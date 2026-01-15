import type { CollectionConfig } from 'payload'
import type { BulkEmbeddingRunStatus } from '../types.js'

export const BULK_EMBEDDINGS_RUNS_SLUG = 'vector-bulk-embeddings-runs'

const statusOptions: BulkEmbeddingRunStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]

export const createBulkEmbeddingsRunsCollection = (): CollectionConfig => ({
  slug: BULK_EMBEDDINGS_RUNS_SLUG,
  admin: {
    useAsTitle: 'pool',
    description:
      'Bulk embedding run records. Created automatically when the Embed all action is triggered.',
    defaultColumns: ['pool', 'status', 'inputs', 'succeeded', 'failed', 'submittedAt'],
    components: {
      edit: {
        beforeDocumentControls: [
          {
            path: 'payloadcms-vectorize/client#FailedBatchesList',
          },
        ],
      },
    },
  },
  access: {
    // Anyone can read; only internal (local API) can mutate.
    read: () => true,
    create: ({ req }) => false,
    update: ({ req }) => false,
    delete: ({ req }) => false,
  },
  fields: [
    {
      name: 'pool',
      type: 'text',
      required: true,
      admin: {
        description: 'Knowledge pool slug',
      },
    },
    {
      name: 'embeddingVersion',
      type: 'text',
      required: true,
      admin: {
        description: 'Embedding version at submission time',
      },
    },
    {
      name: 'status',
      type: 'select',
      options: statusOptions.map((value) => ({ value, label: value })),
      required: true,
      defaultValue: 'queued',
    },
    {
      name: 'totalBatches',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Total number of batches in this run',
      },
    },
    {
      name: 'inputs',
      type: 'number',
      defaultValue: 0,
    },
    {
      name: 'succeeded',
      type: 'number',
      defaultValue: 0,
    },
    {
      name: 'failed',
      type: 'number',
      defaultValue: 0,
    },
    {
      name: 'submittedAt',
      type: 'date',
      admin: { description: 'Timestamp when the batch was submitted' },
    },
    {
      name: 'completedAt',
      type: 'date',
      admin: { description: 'Timestamp when the batch finished' },
    },
    {
      name: 'error',
      type: 'textarea',
      admin: {
        description: 'Failure reason if the run ended in error',
      },
    },
    {
      name: 'failedChunkData',
      type: 'json',
      admin: {
        description:
          'Data about chunks that failed during completion (collection, documentId, chunkIndex)',
      },
    },
  ],
  timestamps: true,
  indexes: [
    {
      fields: ['pool'],
    },
    {
      fields: ['status'],
    },
  ],
})
