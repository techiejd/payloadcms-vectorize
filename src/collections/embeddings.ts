import type { CollectionConfig } from 'payload'

export const createEmbeddingsCollection = (slug: string = 'embeddings'): CollectionConfig => ({
  slug,
  admin: {
    useAsTitle: 'fieldPath',
    description: 'Vector embeddings for search and similarity queries',
  },
  fields: [
    {
      name: 'sourceCollection',
      type: 'text',
      required: true,
      admin: {
        description: 'The collection that this embedding belongs to',
      },
    },
    {
      name: 'docId',
      type: 'text',
      required: true,
      admin: {
        description: 'The ID of the source document',
      },
    },
    {
      name: 'fieldPath',
      type: 'text',
      required: true,
      admin: {
        description: 'The field path that was vectorized (e.g., "title", "content")',
      },
    },
    {
      name: 'chunkIndex',
      type: 'number',
      required: true,
      admin: {
        description: 'The index of this chunk within the field',
      },
    },
    {
      name: 'chunkText',
      type: 'textarea',
      admin: {
        description: 'The original text that was vectorized',
      },
    },
    {
      name: 'embeddingVersion',
      type: 'text',
      admin: {
        description: 'The version of the embedding model used',
      },
    },
    // Note: 'embedding' field is added via pgvector SQL, not as a Payload field
  ],
  timestamps: true,
  indexes: [
    {
      fields: ['sourceCollection', 'docId'],
    },
    {
      fields: ['sourceCollection', 'fieldPath'],
    },
  ],
})
