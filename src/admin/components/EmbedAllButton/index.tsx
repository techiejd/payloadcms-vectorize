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
    hasBulkEmbeddings = Boolean(
      (props.hasBulkEmbeddings as any)({ payload: props.payload, params: props.params }),
    )
  } else {
    hasBulkEmbeddings = Boolean(props.hasBulkEmbeddings)
  }

  let collectionSlug: string = ''

  if (typeof props.collectionSlug === 'function') {
    // Call the serverProps function with the payload/params context
    collectionSlug = String(
      (props.collectionSlug as any)({ payload: props.payload, params: props.params }) || '',
    )
  } else {
    collectionSlug = String(props.collectionSlug || '')
  }

  // Only pass serializable props to the client component
  return (
    <EmbedAllButtonClient collectionSlug={collectionSlug} hasBulkEmbeddings={hasBulkEmbeddings} />
  )
}

export default EmbedAllButton
