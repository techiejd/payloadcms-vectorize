import { voyage } from 'voyage-ai-provider'
import { embed, embedMany } from 'ai'
import type {
  BulkEmbeddingInput,
  BulkEmbeddingOutput,
  BulkEmbeddingRunStatus,
  BulkEmbeddingsFns,
} from 'payloadcms-vectorize'

export const voyageEmbedDocs = async (texts: string[]): Promise<number[][]> => {
  const embedResult = await embedMany({
    model: voyage.textEmbeddingModel('voyage-3.5-lite'),
    values: texts,
    providerOptions: {
      voyage: { inputType: 'document' },
    },
  })
  return embedResult.embeddings
}
export const voyageEmbedQuery = async (text: string): Promise<number[]> => {
  const embedResult = await embed({
    model: voyage.textEmbeddingModel('voyage-3.5-lite'),
    value: text,
    providerOptions: {
      voyage: { inputType: 'query' },
    },
  })
  return embedResult.embedding
}
export const voyageEmbedDims = 1024

export function makeDummyEmbedQuery(dims: number) {
  return async function embed(text: string) {
    const normalized = (text || '').trim()

    const vector = new Array(dims).fill(0)
    for (let i = 0; i < normalized.length; i++) {
      const code = normalized.charCodeAt(i)
      const idx = i % dims
      vector[idx] = (vector[idx] + code) % 997
    }
    // Normalize range to ~0..1 for consistency
    for (let i = 0; i < dims; i++) {
      vector[i] = vector[i] / 997
    }
    return vector
  }
}

export function makeDummyEmbedDocs(dims: number) {
  const embedSingle = makeDummyEmbedQuery(dims)
  return async function embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = []
    for (let currText = 0; currText < texts.length; currText++) {
      const text = texts[currText]
      const vector = await embedSingle(text)
      vectors.push(vector)
    }
    return vectors
  }
}
export const testEmbeddingVersion = 'test-v1'

// Real Voyage Batch API implementation
export function makeVoyageBulkEmbeddingsConfig(): BulkEmbeddingsFns {
  // Store batch state in memory for dev purposes
  const batchState = new Map<
    string,
    {
      inputs: BulkEmbeddingInput[]
      batchId: string
      outputFileId?: string
    }
  >()

  return {
    prepareBulkEmbeddings: async ({ inputs }) => {
      try {
        // Create JSONL content for Voyage batch
        const jsonlLines = inputs.map((input) => {
          return JSON.stringify({
            custom_id: input.id,
            body: {
              input: [input.text],
              model: 'voyage-3.5-lite',
              input_type: 'document',
            },
          })
        })
        const jsonlContent = jsonlLines.join('\n')

        // Upload file to Voyage Files API using FormData
        const formData = new FormData()
        const blob = new Blob([jsonlContent], { type: 'application/jsonl' })
        formData.append('file', blob, 'batch-input.jsonl')
        formData.append('purpose', 'batch')

        const uploadResponse = await fetch('https://api.voyageai.com/v1/files', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
          },
          body: formData,
        })

        if (!uploadResponse.ok) {
          const error = await uploadResponse.text()
          throw new Error(`Voyage file upload failed: ${error}`)
        }

        const fileData = await uploadResponse.json()
        const fileId = fileData.id

        // Create batch
        const batchResponse = await fetch('https://api.voyageai.com/v1/batches', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input_file_id: fileId,
            endpoint: '/v1/embeddings',
            completion_window: '24h',
          }),
        })

        if (!batchResponse.ok) {
          const error = await batchResponse.text()
          throw new Error(`Voyage batch creation failed: ${error}`)
        }

        const batchData = await batchResponse.json()
        const batchId = batchData.id

        // Store state for later retrieval
        batchState.set(batchId, {
          inputs,
          batchId,
        })

        return {
          providerBatchId: batchId,
          status: batchData.status || 'queued',
          counts: { inputs: inputs.length },
        }
      } catch (error) {
        console.error('Voyage prepareBulkEmbeddings error:', error)
        throw error
      }
    },

    pollBulkEmbeddings: async ({ providerBatchId }) => {
      try {
        const response = await fetch(`https://api.voyageai.com/v1/batches/${providerBatchId}`, {
          headers: {
            Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
          },
        })

        if (!response.ok) {
          const error = await response.text()
          return { status: 'failed', error: `Voyage API error: ${error}` }
        }

        const batchData = await response.json()

        // Map Voyage status to our status
        let status: BulkEmbeddingRunStatus
        switch (batchData.status) {
          case 'queued':
          case 'validating':
            status = 'queued'
            break
          case 'running':
          case 'finalizing':
            status = 'running'
            break
          case 'completed':
            status = 'succeeded'
            break
          case 'failed':
          case 'cancelled':
          case 'expired':
            status = batchData.status === 'cancelled' ? 'canceled' : 'failed'
            break
          default:
            status = 'running'
        }

        // Store output file ID if available
        if (batchData.output_file_id) {
          const state = batchState.get(providerBatchId)
          if (state) {
            state.outputFileId = batchData.output_file_id
          }
        }

        return {
          status,
          counts: batchData.request_counts
            ? {
                inputs: batchData.request_counts.total || 0,
                succeeded: batchData.request_counts.completed || 0,
                failed: batchData.request_counts.failed || 0,
              }
            : undefined,
          nextPollMs: status === 'running' || status === 'queued' ? 10000 : undefined, // Poll every 10s if not terminal
        }
      } catch (error) {
        console.error('Voyage pollBulkEmbeddings error:', error)
        return { status: 'failed', error: 'Failed to poll batch status' }
      }
    },

    completeBulkEmbeddings: async ({ providerBatchId }) => {
      try {
        const state = batchState.get(providerBatchId)
        if (!state?.outputFileId) {
          throw new Error('No output file available for batch')
        }

        // Download output file
        const response = await fetch(
          `https://api.voyageai.com/v1/files/${state.outputFileId}/content`,
          {
            headers: {
              Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
            },
          },
        )

        if (!response.ok) {
          const error = await response.text()
          throw new Error(`Failed to download output file: ${error}`)
        }

        const jsonlContent = await response.text()
        const lines = jsonlContent.trim().split('\n')

        const outputs: BulkEmbeddingOutput[] = []
        let succeeded = 0
        let failed = 0

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const result = JSON.parse(line)
            if (result.error) {
              outputs.push({
                id: result.custom_id,
                error: result.error.message || 'Unknown error',
              })
              failed++
            } else {
              outputs.push({
                id: result.custom_id,
                embedding: result.response.body.data[0].embedding,
              })
              succeeded++
            }
          } catch (parseError) {
            console.error('Failed to parse output line:', line, parseError)
            failed++
          }
        }

        // Clean up state
        batchState.delete(providerBatchId)

        return {
          status: 'succeeded',
          outputs,
          counts: {
            inputs: state.inputs.length,
            succeeded,
            failed,
          },
        }
      } catch (error) {
        console.error('Voyage completeBulkEmbeddings error:', error)
        throw error
      }
    },
  }
}
