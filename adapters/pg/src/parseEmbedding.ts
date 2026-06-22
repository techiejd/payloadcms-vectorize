export function parseEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[]
  if (typeof value === 'string') {
    return value
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .filter((s) => s.length > 0)
      .map((s) => Number(s))
  }
  return []
}
