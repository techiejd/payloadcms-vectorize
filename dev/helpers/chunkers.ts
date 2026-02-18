import {
  $isElementNode,
  $parseSerializedNode,
  SerializedElementNode,
  SerializedLexicalNode,
  type LexicalNode,
  type SerializedEditorState,
} from '@payloadcms/richtext-lexical/lexical'
import {
  convertLexicalToMarkdown,
  editorConfigFactory,
  getEnabledNodes,
} from '@payloadcms/richtext-lexical'
import { createHeadlessEditor } from '@payloadcms/richtext-lexical/lexical/headless'
import { $getRoot } from '@payloadcms/richtext-lexical/lexical'
import { HeadingNode } from '@payloadcms/richtext-lexical/lexical/rich-text'
import type { SanitizedConfig, Payload } from 'payload'

/** Inspired by https://github.com/facebook/lexical/discussions/5206#discussioncomment-7477699
 * using https://github.com/facebook/lexical/blob/main/packages/lexical/src/LexicalEditorState.ts#L56*/
function exportNodeToJson<SerializedNode extends SerializedLexicalNode>(
  node: LexicalNode,
): SerializedNode {
  const serializedNode = node.exportJSON()
  const nodeClass = node.constructor

  if (serializedNode.type !== nodeClass.getType()) {
    throw new Error(
      `LexicalNode: Node ${nodeClass.name} does not match the serialized type. Check if .exportJSON() is implemented and it is returning the correct type.`,
    )
  }

  if ($isElementNode(node)) {
    const serializedChildren = (serializedNode as SerializedElementNode).children
    if (!Array.isArray(serializedChildren)) {
      throw new Error(
        `LexicalNode: Node ${nodeClass.name} is an element but .exportJSON() does not have a children array.`,
      )
    }

    const children = node.getChildren()

    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const serializedChildNode = exportNodeToJson(child)
      serializedChildren.push(serializedChildNode)
    }
  }

  // @ts-expect-error
  return serializedNode
}

export const createRichTextChunker = async (config: SanitizedConfig) => {
  const editorConfig = await editorConfigFactory.default({ config })
  const enabledNodes = getEnabledNodes({ editorConfig })
  const _createHeadlessEditor = () => {
    return createHeadlessEditor({
      nodes: enabledNodes,
    })
  }

  const createMarkdownFromNodes = async (nodes: SerializedLexicalNode[]): Promise<string> => {
    const editor = _createHeadlessEditor()
    // Create a new root with just these nodes
    await new Promise((resolve) => {
      const unregister = editor.registerUpdateListener(({ editorState }) => {
        unregister()
        resolve(editorState.toJSON())
      })
      editor.update(() => {
        const root = $getRoot()
        nodes.forEach((node) => {
          root.append($parseSerializedNode(node))
        })
      })
    })

    // Convert to markdown using PayloadCMS converter
    return convertLexicalToMarkdown({
      data: editor.getEditorState().toJSON(),
      editorConfig,
    })
  }

  return async (richText: SerializedEditorState): Promise<string[]> => {
    const editor = _createHeadlessEditor()
    const parsedEditorState = editor.parseEditorState(richText)
    await new Promise((resolve) => {
      const unregister = editor.registerUpdateListener(({ editorState }) => {
        unregister()
        resolve(editorState.toJSON())
      })
      editor.update(() => {
        editor.setEditorState(parsedEditorState)
      })
    })

    const nodeChunks: SerializedLexicalNode[][] = []
    let currentChunk: SerializedLexicalNode[] = []

    editor.getEditorState().read(() => {
      const root = $getRoot()
      const children = root.getChildren()

      for (const node of children) {
        // Check if this is an H2 heading
        if (node.getType() === 'heading' && (node as HeadingNode).getTag() === 'h2') {
          // If we have accumulated nodes, create a chunk
          if (currentChunk.length > 0) {
            nodeChunks.push([...currentChunk])
            currentChunk = []
          }
          // Start new chunk with this H2
          currentChunk = [exportNodeToJson(node)]
        } else {
          // Add to current chunk
          currentChunk.push(exportNodeToJson(node))
        }
      }

      // Don't forget the last chunk
      if (currentChunk.length > 0) {
        nodeChunks.push([...currentChunk])
      }
    })
    // Process all chunks to markdown
    const processedChunks = await Promise.all(
      nodeChunks.map(async (chunk, i) => {
        const markdown = await createMarkdownFromNodes(chunk)
        return markdown
      }),
    )

    return processedChunks.filter(Boolean)
  }
}

// Rich text chunker specifically for SerializedEditorState
export const chunkRichText = async (
  richText: SerializedEditorState,
  config: SanitizedConfig,
): Promise<string[]> => {
  // Create chunker with payload config and chunk the rich text
  const chunk = await createRichTextChunker(config)
  return await chunk(richText)
}

/**
 * Simplified rich text chunker for adapter tests that don't need Lexical parsing.
 * Extracts text content from SerializedEditorState by walking the node tree.
 */
export const chunkRichTextSimple = async (
  richText: SerializedEditorState,
): Promise<string[]> => {
  const root = richText?.root
  if (!root || !root.children) {
    return []
  }

  const chunks: string[] = []
  for (const node of (root as any).children) {
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
    return node.children.map(extractText).join(' ')
  }
  return ''
}

// Simple text chunker
export const chunkText = (text: string): string[] => {
  const maxChars = 1000
  const sentences = text.match(/[^.!?]+[.!?](?:\s+|$)|[^.!?]+$/g) || []
  const chunks = []
  let currentChunk = ''
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length >= maxChars) {
      chunks.push(currentChunk)
      currentChunk = sentence
    } else {
      currentChunk += sentence
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk)
  }
  return chunks
}
