import { voyage } from 'voyage-ai-provider'
import { embed, embedMany } from 'ai'
import type {
  BulkEmbeddingInput,
  BulkEmbeddingOutput,
  BulkEmbeddingRunStatus,
  BulkEmbeddingsFns,
  BatchSubmission,
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

// Voyage file size limit (approximately 100MB, we use a safer threshold)
const VOYAGE_FILE_SIZE_LIMIT = 50 * 1024 * 1024 // 50MB to be safe

/**
 * Real Voyage Batch API implementation using the new streaming API.
 * User controls batching based on file size.
 */
export function makeVoyageBulkEmbeddingsConfig(): BulkEmbeddingsFns {
  // Accumulated chunks for current batch
  let accumulatedChunks: BulkEmbeddingInput[] = []
  let accumulatedSize = 0
  let batchIndex = 0

  // Store batch state in memory for dev purposes (output file IDs for completion)
  const batchOutputFiles = new Map<string, string>()

  // Helper to estimate JSONL line size for a chunk
  const estimateChunkSize = (chunk: BulkEmbeddingInput): number => {
    const jsonLine = JSON.stringify({
      custom_id: chunk.id,
      body: {
        input: [chunk.text],
        model: 'voyage-3.5-lite',
        input_type: 'document',
      },
    })
    return jsonLine.length + 1 // +1 for newline
  }

  // Helper to submit accumulated chunks to Voyage
  const submitBatch = async (chunks: BulkEmbeddingInput[]): Promise<BatchSubmission> => {
    // Create JSONL content for Voyage batch
    const jsonlLines = chunks.map((input) => {
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
    formData.append('file', blob, `batch-input-${batchIndex}.jsonl`)
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
    const providerBatchId = batchData.id

    batchIndex++

    return { providerBatchId }
  }

  return {
    addChunk: async ({ chunk, isLastChunk }) => {
      const chunkSize = estimateChunkSize(chunk)

      // Check if adding this chunk would exceed the file size limit
      if (accumulatedSize + chunkSize > VOYAGE_FILE_SIZE_LIMIT && accumulatedChunks.length > 0) {
        // Submit what we have (without this chunk)
        const toSubmit = [...accumulatedChunks]
        accumulatedChunks = [chunk]
        accumulatedSize = chunkSize
        return await submitBatch(toSubmit)
      }

      // Add chunk to accumulator
      accumulatedChunks.push(chunk)
      accumulatedSize += chunkSize

      // If this is the last chunk, flush everything
      if (isLastChunk && accumulatedChunks.length > 0) {
        const toSubmit = [...accumulatedChunks]
        accumulatedChunks = []
        accumulatedSize = 0
        return await submitBatch(toSubmit)
      }

      return null
    },

    pollBatch: async ({ providerBatchId }) => {
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

        // Store output file ID if available for later completion
        if (batchData.output_file_id) {
          batchOutputFiles.set(providerBatchId, batchData.output_file_id)
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
        }
      } catch (error) {
        console.error('Voyage pollBatch error:', error)
        return { status: 'failed', error: 'Failed to poll batch status' }
      }
    },

    completeBatch: async ({ providerBatchId }) => {
      try {
        const outputFileId = batchOutputFiles.get(providerBatchId)
        if (!outputFileId) {
          throw new Error('No output file available for batch')
        }

        // Download output file
        const response = await fetch(`https://api.voyageai.com/v1/files/${outputFileId}/content`, {
          headers: {
            Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
          },
        })

        if (!response.ok) {
          const error = await response.text()
          throw new Error(`Failed to download output file: ${error}`)
        }

        const jsonlContent = await response.text()
        const lines = jsonlContent.trim().split('\n')

        const outputs: BulkEmbeddingOutput[] = []

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const result = JSON.parse(line)
            if (result.error) {
              outputs.push({
                id: result.custom_id,
                error: result.error.message || 'Unknown error',
              })
            } else {
              outputs.push({
                id: result.custom_id,
                embedding: result.response.body.data[0].embedding,
              })
            }
          } catch (parseError) {
            console.error('Failed to parse output line:', line, parseError)
          }
        }

        // Clean up state
        batchOutputFiles.delete(providerBatchId)

        return outputs
      } catch (error) {
        console.error('Voyage completeBatch error:', error)
        throw error
      }
    },

    onError: async ({ providerBatchIds, error }) => {
      console.log(
        `Voyage bulk run failed: ${error.message}. Cleaning up ${providerBatchIds.length} batches...`,
      )

      // Cancel any running batches
      for (const batchId of providerBatchIds) {
        try {
          await fetch(`https://api.voyageai.com/v1/batches/${batchId}/cancel`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
            },
          })
        } catch (cancelError) {
          console.error(`Failed to cancel batch ${batchId}:`, cancelError)
        }
      }

      // Clean up local state
      for (const batchId of providerBatchIds) {
        batchOutputFiles.delete(batchId)
      }

      // Reset accumulator state for potential retry
      accumulatedChunks = []
      accumulatedSize = 0
      batchIndex = 0
    },
  }
}
