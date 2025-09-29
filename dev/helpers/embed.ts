export function makeEmbed(dims: number) {
  return async function embed(text: string): Promise<number[]> {
    const vector: number[] = new Array(dims).fill(0)
    const normalized = (text || '').trim()
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

export const embeddingVersion = 'test-v1'
