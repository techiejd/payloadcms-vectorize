// dev/create-alt-db.ts
import { Client } from 'pg'

export const create = async ({ dbName }: { dbName: string }) => {
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
