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

async function waitForTasks(
  payload: Payload,
  taskSlugs: string[],
  maxWaitMs = 10000,
  intervalMs = 250,
) {
  const startTime = Date.now()
  while (Date.now() - startTime < maxWaitMs) {
    const pending = await payload.find({
      collection: 'payload-jobs',
      where: {
        and: [{ taskSlug: { in: taskSlugs } }, { completedAt: { exists: false } }],
      },
    })
    if (pending.totalDocs === 0) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  // One last grace wait
  await new Promise((resolve) => setTimeout(resolve, 500))
}

export async function waitForVectorizationJobs(payload: Payload, maxWaitMs = 10000) {
  await waitForTasks(payload, ['payloadcms-vectorize:vectorize'], maxWaitMs)
}

export async function waitForBulkJobs(payload: Payload, maxWaitMs = 10000) {
  await waitForTasks(
    payload,
    [
      'payloadcms-vectorize:prepare-bulk-embedding',
      'payloadcms-vectorize:poll-or-complete-bulk-embedding',
    ],
    maxWaitMs,
  )
}
