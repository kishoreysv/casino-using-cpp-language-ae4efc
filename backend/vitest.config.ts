/** Configure isolated session tests against temporary file-backed SQLite. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'], fileParallelism: false }
});
