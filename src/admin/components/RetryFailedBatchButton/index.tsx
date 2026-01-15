import React from 'react'
import { RetryFailedBatchButtonClient } from './client.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../../collections/bulkEmbeddingsBatches.js'

type RetryFailedBatchButtonProps = {
  batchId: string
  status: string
}

export const RetryFailedBatchButton: React.FC<
  RetryFailedBatchButtonProps & { payload?: any; id?: string }
> = async (props) => {
  const batch = await props.payload?.findByID({
    collection: BULK_EMBEDDINGS_BATCHES_SLUG,
    id: props.id,
  })

  return (
    <RetryFailedBatchButtonClient
      batchId={props.id!}
      status={batch.status}
      retriedBatchId={batch.retriedBatchId}
    />
  )
}

export default RetryFailedBatchButton
