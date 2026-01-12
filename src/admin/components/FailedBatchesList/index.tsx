import React from 'react'
import { FailedBatchesListClient } from './client.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../../collections/bulkEmbeddingsBatches.js'

type FailedBatchesListProps = {
  payload?: any
  id?: string
  data?: any // The document data passed by beforeDocumentControls
}

export const FailedBatchesList: React.FC<FailedBatchesListProps> = async (props) => {
  // Always render something for debugging
  console.log('[FailedBatchesList] Component called with props:', {
    hasPayload: !!props.payload,
    hasId: !!props.id,
    allProps: Object.keys(props),
  })

  const run = await props.payload.findByID({
    collection: BULK_EMBEDDINGS_RUNS_SLUG,
    id: props.id,
  })

  console.log('[FailedBatchesList] Fetching failed batches for run:', run.id)

  // Fetch failed batches for this run
  const runIdNum = typeof run.id === 'number' ? run.id : parseInt(String(run.id), 10)
  const failedBatches = await props.payload.find({
    collection: BULK_EMBEDDINGS_BATCHES_SLUG,
    where: {
      and: [{ run: { equals: runIdNum } }, { status: { equals: 'failed' } }],
    },
    limit: 100, // Limit to first 100 failed batches
    sort: 'batchIndex',
  })

  const batches = (failedBatches as any)?.docs || []
  const runId = props.id || String(run.id)

  console.log('[FailedBatchesList] Found batches:', batches.length, 'for run:', runId)

  return (
    <FailedBatchesListClient
      runId={runId}
      failedCount={run.failed}
      batches={batches.map((b: any) => ({
        id: String(b.id),
        batchIndex: b.batchIndex,
        providerBatchId: b.providerBatchId,
        error: b.error,
      }))}
    />
  )
}

export default FailedBatchesList
