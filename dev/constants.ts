import type { SanitizedConfig } from 'payload'
import { createHeadlessEditor } from '@payloadcms/richtext-lexical/lexical/headless'
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  type SerializedEditorState,
} from '@payloadcms/richtext-lexical/lexical'
import { $createHeadingNode } from '@payloadcms/richtext-lexical/lexical/rich-text'
import { editorConfigFactory, getEnabledNodes } from '@payloadcms/richtext-lexical'

export const getInitialMarkdownContent = async (
  config: SanitizedConfig,
): Promise<SerializedEditorState> => {
  const editorConfig = await editorConfigFactory.default({ config })
  const enabledNodes = getEnabledNodes({ editorConfig })

  // Still create editor to resemble runtime environment, but seed with serialized
  const editor = createHeadlessEditor({
    nodes: enabledNodes,
  })
  return await new Promise((resolve) => {
    const unregister = editor.registerUpdateListener(({ editorState }) => {
      unregister()
      resolve(editorState.toJSON())
    })
    editor.update(() => {
      const root = $getRoot()
      root.append($createHeadingNode('h1').append($createTextNode('Title')))
      root.append($createParagraphNode().append($createTextNode('Quote')))
      root.append($createParagraphNode().append($createTextNode('Paragraph 0')))
      root.append($createHeadingNode('h2').append($createTextNode('Header 1')))
      root.append($createParagraphNode().append($createTextNode('Paragraph 1')))
      root.append($createParagraphNode().append($createTextNode('Paragraph 2')))
      root.append($createParagraphNode().append($createTextNode('Paragraph 3')))
      root.append($createHeadingNode('h2').append($createTextNode('Header 2')))
      root.append($createParagraphNode().append($createTextNode('Paragraph 4')))
      root.append($createParagraphNode().append($createTextNode('Paragraph 5')))
      root.append($createParagraphNode().append($createTextNode('Paragraph 6')))
    })
  })
}
