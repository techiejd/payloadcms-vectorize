import { voyage } from 'voyage-ai-provider'
import { embed, embedMany } from 'ai'
import type { BulkEmbeddingsCallbacks } from 'payloadcms-vectorize'

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

export function makeLocalBulkEmbeddingsCallbacks(dims: number): BulkEmbeddingsCallbacks {
  const pendingInputs = new Map<string, Array<{ id: string; text: string }>>()
  const embedDocs = makeDummyEmbedDocs(dims)
  return {
    prepareBulkEmbeddings: async ({ inputs }) => {
      const providerBatchId = `local-${dims}-${Date.now()}`
      pendingInputs.set(providerBatchId, inputs)
      return {
        providerBatchId,
        status: 'queued',
        counts: { inputs: inputs.length },
      }
    },
    pollBulkEmbeddings: async ({ providerBatchId }) => {
      if (!pendingInputs.has(providerBatchId)) {
        return { status: 'failed', error: 'unknown batch' }
      }
      return { status: 'succeeded' }
    },
    completeBulkEmbeddings: async ({ providerBatchId }) => {
      const inputs = pendingInputs.get(providerBatchId) || []
      const embeddings = await embedDocs(inputs.map((i) => i.text))
      pendingInputs.delete(providerBatchId)
      return {
        status: 'succeeded',
        outputs: embeddings.map((vector, idx) => ({
          id: inputs[idx]?.id ?? String(idx),
          embedding: vector,
        })),
        counts: { inputs: inputs.length, succeeded: embeddings.length, failed: 0 },
      }
    },
  }
}
