import { createMongoVectorIntegration } from '../../src/index.js'

export const DIMS = 8
export const MONGO_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27018/?directConnection=true'

export const TEST_DB = `vectorize_mongo_test_${Date.now()}`

export function makeIntegration(filterableFields: string[] = []) {
  return createMongoVectorIntegration({
    uri: MONGO_URI,
    dbName: TEST_DB,
    pools: {
      default: {
        dimensions: DIMS,
        filterableFields,
        // Smaller candidate set so HNSW build/scan stays fast on tiny datasets.
        numCandidates: 50,
      },
    },
  })
}
