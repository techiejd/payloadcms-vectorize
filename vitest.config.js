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
      include: ['dev/specs/**/*.spec.ts'],
      exclude: ['**/e2e.spec.{ts,js}', '**/node_modules/**'],
      // Run test files sequentially to avoid global state interference
      // (embeddingsTables map and Payload instance caching)
      fileParallelism: false,
      // Disable parallel test execution within files as well
      //threads: false,
      //maxConcurrency: 1,
    },
  }
})
