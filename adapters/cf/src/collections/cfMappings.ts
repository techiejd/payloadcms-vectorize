import type { CollectionConfig } from 'payload'

export const CF_MAPPINGS_SLUG = 'vector-cf-mappings'

// This collection maps Cloudflare Vectorize vector IDs to source documents,
// so we can find and delete vectors when the source document is deleted.
const CFMappingsCollection: CollectionConfig = {
  slug: CF_MAPPINGS_SLUG,
  admin: {
    hidden: true,
    description:
      'Maps Cloudflare Vectorize vector IDs to source documents. Managed by the CF adapter.',
  },
  access: {
    read: () => true,
    create: ({ req }) => req?.payloadAPI === 'local',
    update: ({ req }) => req?.payloadAPI === 'local',
    delete: ({ req }) => req?.payloadAPI === 'local',
  },
  fields: [
    {
      name: 'vectorId',
      type: 'text',
      required: true,
      index: true,
    },
    {
      name: 'poolName',
      type: 'text',
      required: true,
      index: true,
    },
    {
      name: 'sourceCollection',
      type: 'text',
      required: true,
      index: true,
    },
    {
      name: 'docId',
      type: 'text',
      required: true,
      index: true,
    },
  ],
  timestamps: true,
}

export default CFMappingsCollection
