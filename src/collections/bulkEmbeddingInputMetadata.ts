import type { CollectionConfig } from 'payload'
import { BULK_EMBEDDINGS_RUNS_SLUG } from './bulkEmbeddingsRuns.js'

export const BULK_EMBEDDINGS_INPUT_METADATA_SLUG = 'vector-bulk-embedding-input-metadata'

export const createBulkEmbeddingInputMetadataCollection = (): CollectionConfig => ({
  slug: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
  admin: {
    useAsTitle: 'inputId',
    description: 'Stores per-input metadata for bulk embedding runs.',
    defaultColumns: ['run', 'inputId', 'sourceCollection', 'docId', 'chunkIndex'],
  },
  access: {
    // Anyone can read; only internal (local API) can mutate.
    read: () => true,
    create: ({ req }) => req?.payloadAPI === 'local',
    update: ({ req }) => req?.payloadAPI === 'local',
    delete: ({ req }) => req?.payloadAPI === 'local',
  },
  fields: [
    {
      name: 'run',
      type: 'relationship',
      relationTo: BULK_EMBEDDINGS_RUNS_SLUG,
      required: true,
      admin: { description: 'Bulk run this input belongs to' },
    },
    {
      name: 'inputId',
      type: 'text',
      required: true,
    },
    {
      name: 'text',
      type: 'textarea',
      required: true,
      admin: { description: 'Original chunk text' },
    },
    {
      name: 'sourceCollection',
      type: 'text',
      required: true,
    },
    {
      name: 'docId',
      type: 'text',
      required: true,
    },
    {
      name: 'chunkIndex',
      type: 'number',
      required: true,
    },
    {
      name: 'embeddingVersion',
      type: 'text',
      required: true,
    },
    {
      name: 'extensionFields',
      type: 'json',
      admin: {
        description: 'Extension field values for this chunk',
      },
    },
  ],
  indexes: [
    {
      fields: ['run', 'inputId'],
    },
    {
      fields: ['run'],
    },
  ],
})
