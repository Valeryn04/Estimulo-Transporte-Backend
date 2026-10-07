import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // Las pruebas de integración comparten una sola base de datos: se ejecutan en serie.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
