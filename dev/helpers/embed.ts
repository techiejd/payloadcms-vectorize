import { voyage } from 'voyage-ai-provider'
import { embed, embedMany } from 'ai'

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
