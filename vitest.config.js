import path from 'path'
import { loadEnv } from 'payload/node'
import { fileURLToPath } from 'url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default defineConfig(() => {
  loadEnv(path.resolve(dirname, './dev'))

  return {
    plugins: [
      tsconfigPaths({
        ignoreConfigErrors: true,
      }),
    ],
    test: {
      environment: 'node',
      hookTimeout: 30_000,
      testTimeout: 30_000,
      exclude: ['**/e2e.spec.{ts,js}', '**/node_modules/**'],
      // Each test file gets its own forked process so memory is fully
      // reclaimed between files (prevents OOM on CI).
      pool: 'forks',
      // Run test files sequentially to avoid DB / global-state interference.
      fileParallelism: false,
    },
  }
})
