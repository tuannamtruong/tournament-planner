import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['admin/src/**/*.test.ts'],
  },
});
