import type { Payload } from 'payload'
import type { DbAdapter, KnowledgePoolName } from '../types.js'

export async function deleteDocumentEmbeddings(args: {
  payload: Payload
  poolName: KnowledgePoolName
  collection: string
  docId: string
  adapter: DbAdapter
}): Promise<void> {
  const { payload, poolName, collection, docId, adapter } = args
  await adapter.deleteChunks(payload, poolName, collection, String(docId))
}
