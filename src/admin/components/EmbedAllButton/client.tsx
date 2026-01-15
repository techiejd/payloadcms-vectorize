'use client'

import React, { useState } from 'react'

type EmbedAllButtonClientProps = {
  collectionSlug: string
  hasBulkEmbeddings: boolean
}

export const EmbedAllButtonClient: React.FC<EmbedAllButtonClientProps> = ({
  collectionSlug,
  hasBulkEmbeddings,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<{ text: string; runId?: string; error?: boolean } | null>(
    null,
  )
  const [isExpanded, setIsExpanded] = useState(false)
  const [isExpandedDisabled, setIsExpandedDisabled] = useState(false)

  const handleClick = async () => {
    setIsSubmitting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/vector-bulk-embed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ knowledgePool: collectionSlug }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessage({ text: data?.error || 'Failed to queue bulk embed run', error: true })
        return
      }
      setMessage({ text: 'Queued bulk embed run', runId: data.runId, error: false })
    } catch (error: any) {
      setMessage({ text: error?.message || 'Failed to queue bulk embed run', error: true })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!hasBulkEmbeddings) {
    return (
      <div
        style={{
          marginBottom: '2rem',
          padding: '1.5rem',
          backgroundColor: '#f8f9fa',
          borderRadius: '4px',
          border: '1px solid #e9ecef',
        }}
      >
        <button
          type="button"
          onClick={() => setIsExpandedDisabled(!isExpandedDisabled)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            width: '100%',
            textAlign: 'left',
            marginBottom: isExpandedDisabled ? '0.75rem' : 0,
          }}
        >
          <h3
            style={{
              fontSize: '1rem',
              fontWeight: 600,
              margin: 0,
              color: '#212529',
            }}
          >
            Bulk Embed All
          </h3>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{
              transform: isExpandedDisabled ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s ease',
              flexShrink: 0,
            }}
          >
            <path
              d="M4 6L8 10L12 6"
              stroke="#6c757d"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span
            style={{
              fontSize: '0.875rem',
              color: '#6c757d',
              marginLeft: 'auto',
            }}
          >
            {isExpandedDisabled ? 'Hide details' : 'Show details'}
          </span>
        </button>

        {isExpandedDisabled && (
          <div
            style={{
              animation: 'fadeIn 0.2s ease',
              paddingTop: '0.5rem',
            }}
          >
            <span style={{ fontSize: '0.875rem', color: '#6c757d', fontWeight: 500 }}>
              Bulk embedding not configured
            </span>
            <p
              style={{
                fontSize: '0.8125rem',
                color: '#6c757d',
                margin: 0,
                lineHeight: '1.5',
              }}
            >
              This knowledge pool does not have bulk embedding configured. Configure{' '}
              <code
                style={{
                  fontSize: '0.875em',
                  padding: '0.125rem 0.25rem',
                  backgroundColor: '#fff',
                  borderRadius: '2px',
                }}
              >
                bulkEmbeddingsFns
              </code>{' '}
              in your plugin options to enable this feature.
            </p>
          </div>
        )}

        <style>
          {`
            @keyframes fadeIn {
              from { opacity: 0; transform: translateY(-4px); }
              to { opacity: 1; transform: translateY(0); }
            }
          `}
        </style>
      </div>
    )
  }

  return (
    <div
      style={{
        marginBottom: '2rem',
        padding: '1.5rem',
        backgroundColor: '#ffffff',
        borderRadius: '4px',
        border: '1px solid #e9ecef',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
      }}
    >
      <div style={{ marginBottom: '1rem' }}>
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            width: '100%',
            textAlign: 'left',
            marginBottom: isExpanded ? '0.75rem' : 0,
          }}
        >
          <h3
            style={{
              fontSize: '1rem',
              fontWeight: 600,
              margin: 0,
              color: '#212529',
            }}
          >
            Bulk Embed All
          </h3>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s ease',
              flexShrink: 0,
            }}
          >
            <path
              d="M4 6L8 10L12 6"
              stroke="#6c757d"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span
            style={{
              fontSize: '0.875rem',
              color: '#6c757d',
              marginLeft: 'auto',
            }}
          >
            {isExpanded ? 'Hide details' : 'Show details'}
          </span>
        </button>

        {isExpanded && (
          <div
            style={{
              animation: 'fadeIn 0.2s ease',
              paddingTop: '0.5rem',
            }}
          >
            <p
              style={{
                fontSize: '0.875rem',
                color: '#6c757d',
                margin: '0 0 0.75rem 0',
                lineHeight: '1.6',
              }}
            >
              Generate embeddings for all documents that don't have embeddings in this knowledge
              pool. This process will:
            </p>
            <ul
              style={{
                fontSize: '0.875rem',
                color: '#6c757d',
                margin: '0 0 0.75rem 1.25rem',
                padding: 0,
                lineHeight: '1.6',
              }}
            >
              <li>
                Collects all documents missing embeddings or with embeddings of a different version
              </li>
              <li>Create batches and submit them to your embedding provider</li>
              <li>Monitor batch completion and save embeddings atomically</li>
              <li>Track progress in the bulk embeddings runs collection</li>
            </ul>
            <p
              style={{
                fontSize: '0.8125rem',
                color: '#868e96',
                margin: '0 0 1rem 0',
                fontStyle: 'italic',
              }}
            >
              Note: This is a large operation. You can monitor progress by clicking the run link
              after submission.
            </p>

            <div
              style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}
            >
              <button
                type="button"
                className="btn btn--style-primary"
                onClick={handleClick}
                disabled={isSubmitting}
                style={{
                  minWidth: '140px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
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
                    Processing...
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
                        d="M8 2V8M8 8L5 5M8 8L11 5M3 8C3 9.30622 3.52678 10.4175 4.46447 11.1213M13 8C13 9.30622 12.4732 10.4175 11.5355 11.1213M4.46447 11.1213C5.50095 11.8819 6.70096 12.3333 8 12.3333C9.29904 12.3333 10.499 11.8819 11.5355 11.1213M4.46447 11.1213L4 14H12L11.5355 11.1213"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Embed all
                  </>
                )}
              </button>

              {message && (
                <div
                  style={{
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
                  <span>
                    {message.text}
                    {message.runId && !message.error && (
                      <>
                        {' — '}
                        <a
                          href={`/admin/collections/vector-bulk-embeddings-runs/${message.runId}`}
                          style={{
                            color: 'inherit',
                            textDecoration: 'underline',
                            fontWeight: 500,
                          }}
                          data-testid="bulk-run-link"
                          onClick={(e) => {
                            e.preventDefault()
                            window.location.href = `/admin/collections/vector-bulk-embeddings-runs/${message.runId}`
                          }}
                        >
                          View run #{message.runId}
                        </a>
                      </>
                    )}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <style>
        {`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-4px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}
      </style>
    </div>
  )
}
