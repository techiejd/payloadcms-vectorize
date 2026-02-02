import type { SerializedEditorState, Payload } from 'payload'

// Simple text chunker
export const chunkText = (text: string): string[] => {
  const maxChars = 1000
  const sentences = text.match(/[^.!?]+[.!?](?:\s+|$)|[^.!?]+$/g) || []
  const chunks = []
  let currentChunk = ''
  let numSentences = 0
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length >= maxChars) {
      chunks.push(currentChunk)
      currentChunk = sentence
      numSentences = 0
    } else {
      currentChunk += sentence
      numSentences++
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk)
  }
  return chunks
}

// Rich text chunker - simplified version for tests
export const chunkRichText = async (
  richText: SerializedEditorState,
  payload: Payload,
): Promise<string[]> => {
  // Simple implementation that extracts text from root children
  const root = richText?.root
  if (!root || !root.children) {
    return []
  }

  const chunks: string[] = []
  for (const node of root.children) {
    const text = extractText(node)
    if (text) {
      chunks.push(text)
    }
  }
  return chunks
}

function extractText(node: any): string {
  if (!node) return ''
  if (node.text) return node.text
  if (node.children && Array.isArray(node.children)) {
    return node.children.map(extractText).join('')
  }
  return ''
}
