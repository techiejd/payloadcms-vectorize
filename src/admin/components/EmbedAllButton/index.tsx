import React from 'react'
import { EmbedAllButtonClient } from './client.js'

type EmbedAllButtonServerProps = {
  hasBulkEmbeddings: boolean
  collectionSlug: string
}

type EmbedAllButtonProps = EmbedAllButtonServerProps

export const EmbedAllButton: React.FC<EmbedAllButtonProps & { payload?: any; params?: any }> = (
  props,
) => {
  // Payload passes serverProps functions - we need to call them ourselves
  // The function receives { payload, params } context
  let hasBulkEmbeddings: boolean = false

  if (typeof props.hasBulkEmbeddings === 'function') {
    // Call the serverProps function with the payload/params context
    try {
      hasBulkEmbeddings = Boolean(
        (props.hasBulkEmbeddings as any)({ payload: props.payload, params: props.params }),
      )
    } catch (error) {
      console.error('[EmbedAllButton Server] Error calling hasBulkEmbeddings:', error)
      hasBulkEmbeddings = false
    }
  } else {
    hasBulkEmbeddings = Boolean(props.hasBulkEmbeddings)
  }

  let collectionSlug: string = ''

  if (typeof props.collectionSlug === 'function') {
    // Call the serverProps function with the payload/params context
    try {
      collectionSlug = String(
        (props.collectionSlug as any)({ payload: props.payload, params: props.params }) || '',
      )
    } catch (error) {
      console.error('[EmbedAllButton Server] Error calling collectionSlug:', error)
      collectionSlug = ''
    }
  } else {
    collectionSlug = String(props.collectionSlug || '')
  }

  console.log('[EmbedAllButton Server] Resolved hasBulkEmbeddings:', hasBulkEmbeddings)
  console.log('[EmbedAllButton Server] Resolved collectionSlug:', collectionSlug)

  // Only pass serializable props to the client component
  return (
    <EmbedAllButtonClient collectionSlug={collectionSlug} hasBulkEmbeddings={hasBulkEmbeddings} />
  )
}

export default EmbedAllButton
