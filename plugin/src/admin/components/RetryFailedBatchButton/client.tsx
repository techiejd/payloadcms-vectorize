'use client'

import React, { useState } from 'react'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../../collections/bulkEmbeddingsBatches.js'

type RetryFailedBatchButtonClientProps = {
  batchId: string
  status: string
  retriedBatchId?: string | null
}

export const RetryFailedBatchButtonClient: React.FC<RetryFailedBatchButtonClientProps> = ({
  batchId,
  status,
  retriedBatchId,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  const isDisabled = status !== 'failed' && status !== 'retried'
  const isRetried = status === 'retried' && retriedBatchId

  const handleClick = async () => {
    if (isDisabled) return

    setIsSubmitting(true)
    setMessage(null)

    try {
      const res = await fetch('/api/vector-retry-failed-batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ batchId }),
      })

      const data = await res.json()

      if (!res.ok) {
        setMessage({ text: data?.error || 'Failed to retry batch', error: true })
        return
      }

      // If a new batch was created, show that in the message
      const newBatchId = data?.newBatchId
      if (newBatchId) {
        setMessage({
          text: `Batch resubmitted successfully. New batch ID: ${newBatchId}`,
          error: false,
        })
        // Redirect to the new batch after a delay
        setTimeout(() => {
          window.location.href = `/admin/collections/${BULK_EMBEDDINGS_BATCHES_SLUG}/${newBatchId}`
        }, 2000)
      } else {
        setMessage({ text: 'Batch resubmitted successfully', error: false })
        // Reload the page after a short delay to show the updated status
        setTimeout(() => {
          window.location.reload()
        }, 1500)
      }
    } catch (error: any) {
      setMessage({ text: error?.message || 'Failed to retry batch', error: true })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      style={{
        marginBottom: '1rem',
        padding: '1rem',
        backgroundColor: isDisabled ? '#f8f9fa' : '#fff5f5',
        borderRadius: '4px',
        border: `1px solid ${isDisabled ? '#e9ecef' : '#fecaca'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <h4
            style={{
              fontSize: '0.875rem',
              fontWeight: 600,
              margin: '0 0 0.25rem 0',
              color: isDisabled && !isRetried ? '#6c757d' : '#c92a2a',
            }}
          >
            {isRetried
              ? 'Batch Retried'
              : isDisabled
                ? 'Retry Not Available'
                : 'Retry Failed Batch'}
          </h4>
          <p
            style={{
              fontSize: '0.8125rem',
              color: '#6c757d',
              margin: 0,
            }}
          >
            {isRetried ? (
              <>
                This batch was retried.{' '}
                {retriedBatchId && (
                  <a
                    href={`/admin/collections/${BULK_EMBEDDINGS_BATCHES_SLUG}/${retriedBatchId}`}
                    style={{ color: '#2563eb', textDecoration: 'underline' }}
                  >
                    View retry batch
                  </a>
                )}
              </>
            ) : isDisabled ? (
              `This batch is in "${status}" status. Retry is only available for failed or retried batches.`
            ) : (
              'Resubmit this failed batch to the provider. The batch will be resubmitted and processed from the beginning.'
            )}
          </p>
        </div>

        {!isRetried && (
          <button
            type="button"
            className={`btn ${isDisabled ? 'btn--style-secondary' : 'btn--style-primary'}`}
            onClick={handleClick}
            disabled={isDisabled || isSubmitting}
            data-testid="retry-failed-batch-button"
            style={{
              minWidth: '120px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              opacity: isDisabled ? 0.5 : 1,
              cursor: isDisabled ? 'not-allowed' : 'pointer',
            }}
          >
            {isSubmitting ? (
              <>
                <span
                  style={{
                    display: 'inline-block',
                    width: '12px',
                    height: '12px',
                    border: '2px solid currentColor',
                    borderTopColor: 'transparent',
                    borderRadius: '50%',
                    animation: 'spin 0.6s linear infinite',
                  }}
                />
                Retrying...
              </>
            ) : (
              <>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{ flexShrink: 0 }}
                >
                  <path
                    d="M2 8C2 4.68629 4.68629 2 8 2C10.0503 2 11.8711 3.0016 13 4.54329M14 8C14 11.3137 11.3137 14 8 14C5.94975 14 4.12893 12.9984 3 11.4567M3 14V11.4567M3 11.4567H5.5M13 2V4.54329M13 4.54329H10.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Retry
              </>
            )}
          </button>
        )}
      </div>

      {message && (
        <div
          style={{
            marginTop: '0.75rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.5rem 0.75rem',
            borderRadius: '4px',
            fontSize: '0.875rem',
            backgroundColor: message.error ? '#fff5f5' : '#f0f9ff',
            color: message.error ? '#c92a2a' : '#0c4a6e',
            border: `1px solid ${message.error ? '#fecaca' : '#bae6fd'}`,
          }}
        >
          {message.error ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M8 5V8M8 11H8.01"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M6 8L7.5 9.5L10 7"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span>{message.text}</span>
        </div>
      )}

      <style>
        {`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}
      </style>
    </div>
  )
}
