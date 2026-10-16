/** Validate the runtime environment before opening the database or listener. */
import 'dotenv/config';
import { z } from 'zod';

const environment = z.object({
  PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535)).default('3000'),
  DATABASE_URL: z.string().regex(/^sqlite:.+/).default('sqlite:./data/tenfold.db'),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development')
});

/** Read typed configuration; reject non-file SQLite and non-origin CORS values.
 * Args: env: runtime environment overrides.
 * Returns: validated listener, database and origin settings.
 * Raises: ZodError or Error when configuration is unsafe.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = environment.parse(env);
  const filename = parsed.DATABASE_URL.slice('sqlite:'.length);
  const origin = new URL(parsed.CORS_ORIGIN);
  if (filename === ':memory:' || filename.includes('?') || filename.includes('\0')) {
    throw new Error('DATABASE_URL must identify a SQLite file');
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== parsed.CORS_ORIGIN) {
    throw new Error('CORS_ORIGIN must be an HTTP origin without a path');
  }
  return { port: parsed.PORT, databaseUrl: parsed.DATABASE_URL, corsOrigin: parsed.CORS_ORIGIN };
}
export type Config = ReturnType<typeof loadConfig>;
