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
