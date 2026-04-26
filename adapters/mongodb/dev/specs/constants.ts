export const DIMS = 8
export const MONGO_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27018/?directConnection=true'

export const TEST_DB = `vectorize_mongo_test_${Date.now()}`
