import type { Payload, BasePayload, Where } from 'payload'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { getPayload, buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { chunkText } from 'helpers/chunkers.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'
import {
  createTestDb,
  destroyPayload,
  waitForVectorizationJobs,
} from './utils.js'
import { DIMS } from './constants.js'
import payloadcmsVectorize, {
  type DbAdapter,
  type KnowledgePoolDynamicConfig,
  type RerankFn,
  type VectorSearchResult,
} from 'payloadcms-vectorize'
import { createVectorSearchHandlers } from '../../src/endpoints/vectorSearch.js'

const dbName = 'rerank_test'

type AdapterCall = { limit: number | undefined }

/** Wrap an adapter to record the limit passed to search(). */
function wrapAdapter(adapter: DbAdapter): { adapter: DbAdapter; calls: AdapterCall[] } {
  const calls: AdapterCall[] = []
  const origSearch = adapter.search
  const wrapped: DbAdapter = {
    ...adapter,
    search: async (
      payload: BasePayload,
      queryEmbedding: number[],
      poolName: string,
      limit?: number,
      where?: Where,
    ): Promise<VectorSearchResult[]> => {
      calls.push({ limit })
      return origSearch(payload, queryEmbedding, poolName, limit, where)
    },
  }
  return { adapter: wrapped, calls }
}

function buildPools(rerank?: {
  multiplier: number
  callback: RerankFn
}): Record<string, KnowledgePoolDynamicConfig> {
  return {
    default: {
      collections: {
        posts: {
          toKnowledgePool: async (doc) => {
            const chunks: Array<{ chunk: string }> = []
            if (doc.title) chunks.push(...chunkText(doc.title).map((c) => ({ chunk: c })))
            return chunks
          },
        },
      },
      embeddingConfig: {
        version: testEmbeddingVersion,
        queryFn: makeDummyEmbedQuery(DIMS),
        realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
        ...(rerank ? { rerank } : {}),
      },
    },
  }
}

describe('rerank callback', () => {
  let payload: Payload
  let baseAdapter: DbAdapter

  beforeAll(async () => {
    await createTestDb({ dbName })
    baseAdapter = createMockAdapter()

    const config = await buildConfig({
      collections: [
        {
          slug: 'posts',
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
      db: postgresAdapter({
        pool: {
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
      }),
      plugins: [
        payloadcmsVectorize({
          dbAdapter: baseAdapter,
          knowledgePools: buildPools(),
        }),
      ],
      secret: 'rerank-test-secret',
      jobs: { tasks: [] },
    })

    payload = await getPayload({
      config,
      key: `rerank-test-${Date.now()}`,
      cron: false,
    })

    // Seed three posts so we have multiple results to reorder.
    for (const title of ['alpha', 'bravo', 'charlie']) {
      await payload.create({ collection: 'posts', data: { title } })
    }
    await waitForVectorizationJobs(payload)
  })

  afterAll(async () => {
    await destroyPayload(payload)
  })

  test('callback is invoked and its order is preserved', async () => {
    const callback = vi.fn(async (_query: string, results: VectorSearchResult[]) => {
      // Reverse — proves the plugin honored the callback's order.
      return [...results].reverse()
    })

    // Baseline: a separate handlers with NO rerank, so the callback only fires once total.
    const baselinePools = buildPools()
    const baselineAdapter = wrapAdapter(baseAdapter).adapter
    const baselineHandlers = createVectorSearchHandlers(baselinePools, baselineAdapter)

    const rerankPools = buildPools({ multiplier: 1, callback })
    const { adapter: rerankAdapter } = wrapAdapter(baseAdapter)
    const rerankHandlers = createVectorSearchHandlers(rerankPools, rerankAdapter)

    const baseline = await baselineHandlers.vectorSearch(payload, 'alpha', 'default', 3)
    const reranked = await rerankHandlers.vectorSearch(payload, 'alpha', 'default', 3)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0]).toBe('alpha')
    expect(reranked.map((r) => r.id)).toEqual([...baseline.map((r) => r.id)].reverse())
  })

  test('multiplier=3 fetches limit*3 candidates from the adapter', async () => {
    const callback = vi.fn(async (_q: string, results: VectorSearchResult[]) => results)
    const pools = buildPools({ multiplier: 3, callback })
    const { adapter, calls } = wrapAdapter(baseAdapter)
    const handlers = createVectorSearchHandlers(pools, adapter)

    await handlers.vectorSearch(payload, 'alpha', 'default', 2)

    expect(calls).toHaveLength(1)
    expect(calls[0].limit).toBe(6)
  })

  test('float multiplier=1.5 with limit=10 fetches 15 candidates (Math.floor)', async () => {
    const callback = vi.fn(async (_q: string, results: VectorSearchResult[]) => results)
    const pools = buildPools({ multiplier: 1.5, callback })
    const { adapter, calls } = wrapAdapter(baseAdapter)
    const handlers = createVectorSearchHandlers(pools, adapter)

    await handlers.vectorSearch(payload, 'alpha', 'default', 10)

    expect(calls).toHaveLength(1)
    expect(calls[0].limit).toBe(15)
  })

  test('no rerank configured: adapter receives the unmodified limit', async () => {
    const pools = buildPools()
    const { adapter, calls } = wrapAdapter(baseAdapter)
    const handlers = createVectorSearchHandlers(pools, adapter)

    await handlers.vectorSearch(payload, 'alpha', 'default', 4)

    expect(calls).toHaveLength(1)
    expect(calls[0].limit).toBe(4)
  })
})
