/**
 * Validates that each entry in chunkData is an object with a `chunk` string property.
 * Throws a descriptive error listing invalid indices if any entries are malformed.
 */
export function validateChunkData(
  chunkData: unknown[],
  docId: string,
  collection: string,
): void {
  if (!Array.isArray(chunkData)) {
    throw new Error(
      `[payloadcms-vectorize] toKnowledgePool for collection "${collection}" must return an array of entries with a required "chunk" string`,
    )
  }

  const invalidEntries = chunkData
    .map((entry, idx) => {
      if (!entry || typeof entry !== 'object') return idx
      if (typeof (entry as Record<string, unknown>).chunk !== 'string') return idx
      return null
    })
    .filter((idx): idx is number => idx !== null)

  if (invalidEntries.length > 0) {
    throw new Error(
      `[payloadcms-vectorize] toKnowledgePool returned ${invalidEntries.length} invalid entr${
        invalidEntries.length === 1 ? 'y' : 'ies'
      } for document ${docId} in collection "${collection}". Each entry must be an object with a "chunk" string. Invalid indices: ${invalidEntries.join(
        ', ',
      )}`,
    )
  }
}
