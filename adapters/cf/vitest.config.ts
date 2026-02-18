import path from 'path'
import { loadEnv } from 'payload/node'
import { fileURLToPath } from 'url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default defineConfig(() => {
  loadEnv(path.resolve(dirname, '../../dev'))

  return {
    plugins: [
      tsconfigPaths({
        ignoreConfigErrors: true,
      }),
    ],
    resolve: {
      alias: {
        '@shared-test/utils': path.resolve(dirname, '../../dev/specs/utils.ts'),
        '@shared-test/helpers/chunkers': path.resolve(dirname, '../../dev/helpers/chunkers.ts'),
        '@shared-test/helpers/embed': path.resolve(dirname, '../../dev/helpers/embed.ts'),
        '@shared-test/constants': path.resolve(dirname, '../../dev/specs/constants.ts'),
      },
    },
    test: {
      environment: 'node',
      hookTimeout: 30_000,
      testTimeout: 30_000,
      include: ['dev/specs/**/*.spec.ts'],
      exclude: ['**/e2e.spec.{ts,js}', '**/node_modules/**'],
      // Run test files sequentially to avoid global state interference
      // (embeddingsTables map and Payload instance caching)
      fileParallelism: false,
    },
  }
})
