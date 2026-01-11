import React from 'react'
import { RetryFailedBatchButtonClient } from './client.js'

type RetryFailedBatchButtonProps = {
  batchId: string
  status: string
}

export const RetryFailedBatchButton: React.FC<
  RetryFailedBatchButtonProps & { payload?: any; params?: any; data?: any }
> = (props) => {
  // Handle both direct props and serverProps functions
  let batchId: string = ''
  let status: string = ''

  if (typeof props.batchId === 'function') {
    try {
      batchId = String(
        (props.batchId as any)({ payload: props.payload, params: props.params, data: props.data }) ||
          '',
      )
    } catch (error) {
      console.error('[RetryFailedBatchButton] Error calling batchId:', error)
      batchId = ''
    }
  } else if (props.data?.id) {
    batchId = String(props.data.id)
  } else {
    batchId = String(props.batchId || '')
  }

  if (typeof props.status === 'function') {
    try {
      status = String(
        (props.status as any)({ payload: props.payload, params: props.params, data: props.data }) ||
          '',
      )
    } catch (error) {
      console.error('[RetryFailedBatchButton] Error calling status:', error)
      status = ''
    }
  } else if (props.data?.status) {
    status = String(props.data.status)
  } else {
    status = String(props.status || '')
  }

  // Only render on the edit view (when we have a batchId)
  if (!batchId) {
    return null
  }

  return <RetryFailedBatchButtonClient batchId={batchId} status={status} />
}

export default RetryFailedBatchButton
