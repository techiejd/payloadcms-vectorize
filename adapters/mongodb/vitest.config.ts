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
        'payloadcms-vectorize': path.resolve(dirname, '../../src/index.ts'),
      },
    },
    test: {
      root: dirname,
      environment: 'node',
      hookTimeout: 120_000,
      testTimeout: 120_000,
      include: ['dev/specs/**/*.spec.ts'],
      exclude: ['**/e2e.spec.{ts,js}', '**/node_modules/**'],
      fileParallelism: false,
    },
  }
})
