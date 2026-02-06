import type { Config, SanitizedConfig } from 'payload'
import { buildConfig } from 'payload'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { createCloudflareVectorizeIntegration } from '../../src/index.js'
import payloadcmsVectorize from 'payloadcms-vectorize'

export const DIMS = 8

// Mock Cloudflare Vectorize binding for tests
export function createMockVectorizeBinding() {
  const storage = new Map<string, { id: string; values: number[]; metadata?: any }>()

  return {
    query: async (queryVector: number[], options?: any) => {
      const topK = options?.topK || 10
      const allVectors = Array.from(storage.values())

      // Apply WHERE filter if present
      let filtered = allVectors
      if (options?.where?.and) {
        filtered = allVectors.filter((vec) => {
          return options.where.and.every((condition: any) => {
            return vec.metadata?.[condition.key] === condition.value
          })
        })
      }

      // Calculate cosine similarity
      const results = filtered.map((vec) => {
        let dotProduct = 0
        let normA = 0
        let normB = 0

        for (let i = 0; i < queryVector.length; i++) {
          dotProduct += queryVector[i] * vec.values[i]
          normA += queryVector[i] * queryVector[i]
          normB += vec.values[i] * vec.values[i]
        }

        const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))

        return {
          id: vec.id,
          score: similarity,
          metadata: vec.metadata,
        }
      })

      // Sort by score descending and limit
      results.sort((a, b) => b.score - a.score)
      return { matches: results.slice(0, topK) }
    },

    upsert: async (vectors: Array<{ id: string; values: number[]; metadata?: any }>) => {
      for (const vec of vectors) {
        storage.set(vec.id, vec)
      }
    },

    delete: async (ids: string[]) => {
      for (const id of ids) {
        storage.delete(id)
      }
    },

    list: async () => {
      return Array.from(storage.values())
    },

    // Test helper
    __getStorage: () => storage,
  }
}

const mockVectorize = createMockVectorizeBinding()

const integrationResult = createCloudflareVectorizeIntegration({
  config: {
    default: {
      dims: DIMS,
    },
  },
  binding: mockVectorize as any,
})

export const integration = integrationResult

/** Create the plugin with the cf adapter pre-configured */
export const plugin = (
  options: Omit<Parameters<typeof payloadcmsVectorize>[0], 'dbAdapter'>,
): ReturnType<typeof payloadcmsVectorize> => {
  return payloadcmsVectorize({
    ...options,
    dbAdapter: integrationResult.adapter,
  })
}

export async function buildDummyConfig(cfg: Partial<Config>): Promise<SanitizedConfig> {
  const built = await buildConfig({
    secret: process.env.PAYLOAD_SECRET || 'test-secret',
    collections: [],
    editor: lexicalEditor(),
    ...cfg,
  })
  return built
}
