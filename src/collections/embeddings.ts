import type { CollectionConfig, Field } from 'payload'
import type { KnowledgePoolName, VectorizedPayload } from '../types.js'
import { isVectorizedPayload } from '../types.js'

const RESERVED_FIELDS = ['sourceCollection', 'docId', 'chunkIndex', 'chunkText', 'embeddingVersion']

export const createEmbeddingsCollection = (
  slug: KnowledgePoolName,
  extensionFields?: Field[],
): CollectionConfig => {
  // Validate that extensionFields don't conflict with reserved fields
  if (extensionFields) {
    const conflictingFields = extensionFields
      .map((f) => (typeof f === 'object' && 'name' in f ? f.name : null))
      .filter((name): name is string => name !== null && RESERVED_FIELDS.includes(name))

    if (conflictingFields.length > 0) {
      throw new Error(
        `[payloadcms-vectorize] Extension fields cannot use reserved field names: ${conflictingFields.join(', ')}`,
      )
    }
  }

  return {
    slug,
    admin: {
      description:
        'Vector embeddings for search and similarity queries. Created by the payloadcms-vectorize plugin. Embeddings cannot be added or modified, only deleted, through the admin panel. No other restrictions enforced.',
      components: {
        beforeList: [
          {
            path: 'payloadcms-vectorize/client#EmbedAllButton',
            exportName: 'EmbedAllButton',
            serverProps: {
              hasBulkEmbeddings: ({ payload, params }: { payload: any; params: any }): boolean => {
                // Get the knowledge pool name from params.segments
                // params structure: { segments: [ 'collections', 'bulkDefault' ] }
                const poolName = params?.segments?.[1]

                // Use the _isBulkEmbedEnabled method added by the plugin
                if (poolName && typeof poolName === 'string' && isVectorizedPayload(payload)) {
                  return payload._isBulkEmbedEnabled(poolName)
                }

                return false
              },
              collectionSlug: ({ params }: { payload: any; params: any }): string => {
                // Get the knowledge pool name from params.segments
                // params structure: { segments: [ 'collections', 'bulkDefault' ] }
                return params?.segments?.[1] || ''
              },
            },
          },
        ],
      },
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
        name: 'chunkIndex',
        type: 'number',
        required: true,
        admin: {
          description: 'The index of this chunk',
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
      // Extension fields are merged here
      ...(extensionFields || []),
    ],
    timestamps: true,
    indexes: [
      {
        fields: ['sourceCollection', 'docId'],
      },
    ],
  }
}
