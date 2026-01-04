import type { CollectionConfig } from 'payload'
import type { BulkEmbeddingRunStatus } from '../types.js'

export const BULK_EMBEDDINGS_BATCHES_SLUG = 'vector-bulk-embeddings-batches'

const statusOptions: BulkEmbeddingRunStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]

/**
 * Collection for tracking individual batches within a bulk embedding run.
 * A run can have multiple batches when the input count exceeds the provider's file limit.
 */
export const createBulkEmbeddingsBatchesCollection = (): CollectionConfig => ({
  slug: BULK_EMBEDDINGS_BATCHES_SLUG,
  admin: {
    useAsTitle: 'providerBatchId',
    description:
      'Individual batches within a bulk embedding run. Created when input count exceeds file limits.',
    defaultColumns: ['run', 'batchIndex', 'status', 'inputCount', 'succeededCount', 'failedCount'],
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
      relationTo: 'vector-bulk-embeddings-runs',
      required: true,
      admin: {
        description: 'Parent bulk embedding run',
      },
    },
    {
      name: 'batchIndex',
      type: 'number',
      required: true,
      admin: {
        description: 'Zero-based index of this batch within the run',
      },
    },
    {
      name: 'providerBatchId',
      type: 'text',
      required: true,
      admin: {
        description: 'Provider-specific batch identifier',
      },
    },
    {
      name: 'inputFileRef',
      type: 'text',
      admin: {
        description: 'Provider file reference for the input file',
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
      name: 'inputCount',
      type: 'number',
      required: true,
      defaultValue: 0,
      admin: {
        description: 'Number of inputs in this batch',
      },
    },
    {
      name: 'succeededCount',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Number of successful embeddings',
      },
    },
    {
      name: 'failedCount',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Number of failed embeddings',
      },
    },
    {
      name: 'submittedAt',
      type: 'date',
      admin: { description: 'Timestamp when the batch was submitted to provider' },
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
        description: 'Error message if the batch failed',
      },
    },
  ],
  timestamps: true,
  indexes: [
    {
      fields: ['run'],
    },
    {
      fields: ['providerBatchId'],
    },
    {
      fields: ['status'],
    },
  ],
})

