'use client'

import React, { useState } from 'react'

type EmbedAllButtonProps = {
  collectionSlug: string
  hasCreatePermission?: boolean
  newDocumentURL?: string
}

export const EmbedAllButton: React.FC<EmbedAllButtonProps> = ({ collectionSlug }) => {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

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
        setMessage(data?.error || 'Failed to queue bulk embed run')
        return
      }
      setMessage(`Queued bulk embed run ${data.runId}`)
    } catch (error: any) {
      setMessage(error?.message || 'Failed to queue bulk embed run')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
      <button
        type="button"
        className="btn btn--style-primary"
        onClick={handleClick}
        disabled={isSubmitting}
      >
        {isSubmitting ? 'Submitting…' : 'Embed all'}
      </button>
      {message ? <span style={{ fontSize: '0.9rem' }}>{message}</span> : null}
    </div>
  )
}

export default EmbedAllButton
