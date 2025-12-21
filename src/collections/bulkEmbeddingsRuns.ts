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
      name: 'inputFileRef',
      type: 'text',
      admin: {
        description: 'Provider file or input reference used for the batch',
      },
    },
    {
      name: 'providerBatchId',
      type: 'text',
      admin: {
        description: 'Provider batch identifier',
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
  ],
  timestamps: true,
  indexes: [
    {
      fields: ['pool'],
    },
    {
      fields: ['providerBatchId'],
    },
    {
      fields: ['status'],
    },
  ],
})
