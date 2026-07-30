import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globalSetup: './app/test/global-setup.ts',
    include: ['{app,scripts}/**/*.test.ts'],
    testTimeout: 30000,
  },
})
