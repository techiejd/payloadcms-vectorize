import type { Config, SanitizedConfig } from 'payload'

import { buildConfig } from 'payload'
import { createHeadlessEditor } from '@payloadcms/richtext-lexical/lexical/headless'
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  type SerializedEditorState,
} from '@payloadcms/richtext-lexical/lexical'
import { $createHeadingNode } from '@payloadcms/richtext-lexical/lexical/rich-text'
import { editorConfigFactory, getEnabledNodes, lexicalEditor } from '@payloadcms/richtext-lexical'
import { createVectorizeIntegration } from 'payloadcms-vectorize'

export const DIMS = 8

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

export const embeddingsCollection = 'default'

export const integration = createVectorizeIntegration({
  default: {
    dims: DIMS,
    ivfflatLists: 1,
  },
})
export const vectorizeCronJob = { cron: '*/10 * * * * *', limit: 5, queue: 'default' }
export const plugin = integration.payloadcmsVectorize

export const dummyPluginOptions = {
  knowledgePools: {
    default: {
      collections: {},
      embedDocs: async (texts: string[]) => texts.map(() => [0, 0, 0, 0, 0, 0, 0, 0]),
      embedQuery: async (text: string) => [0, 0, 0, 0, 0, 0, 0, 0],
      embeddingVersion: 'test',
    },
  },
  queueNameOrCronJob: vectorizeCronJob,
}

export async function buildDummyConfig(cfg: Partial<Config>) {
  const built = await buildConfig({
    secret: 'test-secret',
    collections: [],
    editor: lexicalEditor(),
    // Provide a dummy db adapter to satisfy types; not used by these tests
    db: {} as any,
    plugins: [plugin(dummyPluginOptions)],
    ...cfg,
  })
  return built
}
