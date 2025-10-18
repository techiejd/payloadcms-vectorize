import { voyage } from 'voyage-ai-provider'
import { embedMany } from 'ai'

export const voyageEmbed = async (texts: string[]): Promise<number[][]> => {
  const embedResult = await embedMany({
    model: voyage.textEmbeddingModel('voyage-3.5-lite'),
    values: texts,
  })
  return embedResult.embeddings
}
export const voyageEmbedDims = 1024

export function makeDummyEmbed(dims: number) {
  return async function embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = []
    for (let currText = 0; currText < texts.length; currText++) {
      const text = texts[currText]
      const normalized = (text || '').trim()

      // Create a new array for each text
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
      vectors.push(vector)
    }
    return vectors
  }
}
export const testEmbeddingVersion = 'test-v1'
