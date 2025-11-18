import type { CollectionConfig } from 'payload'
import type { KnowledgePoolName } from '../types.js'

export const createEmbeddingsCollection = (slug: KnowledgePoolName): CollectionConfig => ({
  slug,
  admin: {
    description:
      'Vector embeddings for search and similarity queries. Created by the payloadcms-vectorize plugin. Embeddings cannot be added or modified, only deleted, through the admin panel. No other restrictions enforced.',
  },
  access: {
    create: () => false, // Cannot add new embeddings through admin panel
    update: () => false, // Cannot modify any embeddings field through admin panel
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
    // TODO(techiejd): This could probably be a relationship field to the source document.
    // Is it possible to use a relationship field to an `ANY` collection?
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
