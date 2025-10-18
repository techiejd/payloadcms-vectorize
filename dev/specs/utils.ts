// dev/create-alt-db.ts
import { Payload } from 'payload'
import { Client } from 'pg'

export const createTestDb = async ({ dbName }: { dbName: string }) => {
  const adminUri =
    process.env.DATABASE_ADMIN_URI || 'postgresql://postgres:password@localhost:5433/postgres' // connect to 'postgres'
  const client = new Client({ connectionString: adminUri })
  await client.connect()
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE ${dbName}`)
  }
  await client.end()
}

// Helper function to wait for vectorization jobs to complete
export async function waitForVectorizationJobs(payload: Payload, maxWaitMs = 10000) {
  const startTime = Date.now()
  while (Date.now() - startTime < maxWaitMs) {
    const jobs = await payload.find({
      collection: 'payload-jobs',
      where: {
        and: [
          { taskSlug: { equals: 'payloadcms-vectorize:vectorize' } },
          { processing: { equals: true } },
        ],
      },
    })
    if (jobs.totalDocs === 0) {
      // No running vectorization jobs, check if any are pending
      const pendingJobs = await payload.find({
        collection: 'payload-jobs',
        where: {
          and: [
            { taskSlug: { equals: 'payloadcms-vectorize:vectorize' } },
            { processing: { equals: false } },
            { completedAt: { equals: null } },
          ],
        },
      })
      if (pendingJobs.totalDocs === 0) {
        return // All jobs completed
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500)) // Check every 500ms
  }
  // Fallback: wait a bit more if we hit the timeout
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
