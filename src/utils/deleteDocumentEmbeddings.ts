import type { CollectionSlug, Payload } from 'payload'
import type { DbAdapter, KnowledgePoolName } from '../types.js'

/**
 * Two-step deletion: removes embeddings from the Payload collection
 * and then from the adapter's storage (for adapters that store vectors separately).
 */
export async function deleteDocumentEmbeddings(args: {
  payload: Payload
  poolName: KnowledgePoolName
  collection: string
  docId: string
  adapter: DbAdapter
}): Promise<void> {
  const { payload, poolName, collection, docId, adapter } = args

  await payload.delete({
    collection: poolName as CollectionSlug,
    where: {
      and: [
        { sourceCollection: { equals: collection } },
        { docId: { equals: String(docId) } },
      ],
    },
  })

  if (adapter.deleteEmbeddings) {
    await adapter.deleteEmbeddings(payload, poolName, collection, String(docId))
  }
}
