import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Tests may import either the source (`../src/index.js`) or the package name
 * (`@xiyang/rules`). The alias below points the package name at the source so
 * `npm test` works without a prior `npm run build`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@xiyang/rules': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.{test,spec}.ts'],
    environment: 'node',
  },
})
