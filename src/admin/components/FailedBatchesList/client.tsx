'use client'

import React from 'react'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../../collections/bulkEmbeddingsBatches.js'

type FailedBatch = {
  id: string
  batchIndex: number
  providerBatchId: string
  error?: string | null
}

type FailedBatchesListClientProps = {
  runId: string
  failedCount: number
  batches: FailedBatch[]
}

export const FailedBatchesListClient: React.FC<FailedBatchesListClientProps> = ({
  runId,
  failedCount,
  batches,
}) => {
  if (batches.length === 0) {
    return null
  }

  return (
    <div
      style={{
        marginBottom: '2rem',
        padding: '1.5rem',
        backgroundColor: '#fff3cd',
        border: '1px solid #ffc107',
        borderRadius: '4px',
      }}
    >
      <div style={{ marginBottom: '1rem' }}>
        <h3
          style={{
            margin: 0,
            fontSize: '1.25rem',
            fontWeight: 600,
            color: '#856404',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ flexShrink: 0 }}
          >
            <path
              d="M10 2C5.58 2 2 5.58 2 10C2 14.42 5.58 18 10 18C14.42 18 18 14.42 18 10C18 5.58 14.42 2 10 2ZM11 14H9V12H11V14ZM11 10H9V6H11V10Z"
              fill="#856404"
            />
          </svg>
          Failed Batches ({failedCount})
        </h3>
        <p style={{ margin: '0.5rem 0 0 0', color: '#856404', fontSize: '0.875rem' }}>
          {batches.length === failedCount
            ? 'All failed batches are listed below. Click to view details and retry.'
            : `Showing ${batches.length} of ${failedCount} failed batches.`}
        </p>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}
      >
        {batches.map((batch) => (
          <div
            key={batch.id}
            style={{
              padding: '1rem',
              backgroundColor: '#fff',
              border: '1px solid #dee2e6',
              borderRadius: '4px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div style={{ flex: 1 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '0.25rem',
                }}
              >
                <a
                  href={`/admin/collections/${BULK_EMBEDDINGS_BATCHES_SLUG}/${batch.id}`}
                  style={{
                    color: '#2563eb',
                    textDecoration: 'none',
                    fontWeight: 500,
                    fontSize: '0.9375rem',
                  }}
                  data-testid={`failed-batch-link-${batch.id}`}
                  onClick={(e) => {
                    e.preventDefault()
                    window.location.href = `/admin/collections/${BULK_EMBEDDINGS_BATCHES_SLUG}/${batch.id}`
                  }}
                >
                  Batch #{batch.batchIndex}
                </a>
                <span style={{ color: '#6c757d', fontSize: '0.875rem' }}>
                  ({batch.providerBatchId})
                </span>
              </div>
              {batch.error && (
                <p
                  style={{
                    margin: 0,
                    color: '#dc3545',
                    fontSize: '0.8125rem',
                    fontFamily: 'monospace',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: '600px',
                  }}
                  title={batch.error}
                >
                  {batch.error}
                </p>
              )}
            </div>
            <a
              href={`/admin/collections/${BULK_EMBEDDINGS_BATCHES_SLUG}/${batch.id}`}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#2563eb',
                color: '#fff',
                textDecoration: 'none',
                borderRadius: '4px',
                fontSize: '0.875rem',
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
              data-testid={`failed-batch-view-button-${batch.id}`}
              onClick={(e) => {
                e.preventDefault()
                window.location.href = `/admin/collections/${BULK_EMBEDDINGS_BATCHES_SLUG}/${batch.id}`
              }}
            >
              View
            </a>
          </div>
        ))}
      </div>

      {batches.length < failedCount && (
        <div style={{ marginTop: '1rem', textAlign: 'center' }}>
          <a
            href={`/admin/collections/${BULK_EMBEDDINGS_BATCHES_SLUG}?where[run][equals]=${runId}&where[status][equals]=failed`}
            style={{
              color: '#2563eb',
              textDecoration: 'underline',
              fontSize: '0.875rem',
            }}
            data-testid="view-all-failed-batches-link"
          >
            View all {failedCount} failed batches →
          </a>
        </div>
      )}
    </div>
  )
}

export default FailedBatchesListClient
