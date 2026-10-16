/** Validate session input and authorize operations with high-entropy bearer capabilities. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_DEPOSIT, Session, SessionRepository } from './repository';

const creation = z.object({
  name: z.string().trim().min(1).max(40).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Name cannot contain controls'),
  deposit: z.number().int().min(1).max(MAX_DEPOSIT)
}).strict();

/** Carry safe public errors from the business boundary into HTTP responses. */
export class SessionError extends Error {
  /** Attach an HTTP status and optional per-field validation messages.
   * Args: status: public HTTP status; message: safe description; fields: field messages.
   */
  constructor(readonly status: number, message: string, readonly fields?: Record<string, string>) {
    super(message);
  }
}

/** Hash a capability before using it in any database operation.
 * Args: token: browser-held capability.
 * Returns: lowercase SHA-256 digest.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Provide reusable session operations to HTTP routes and future round services. */
export class SessionService {
  /** Retain the shared repository; do not open per-request connections.
   * Args: repository: runtime-owned SQLite repository.
   */
  constructor(readonly repository: SessionRepository) {}

  /** Create a session and return its capability exactly once.
   * Args: input: untrusted name and deposit object.
   * Returns: public session and random base64url token.
   * Raises: SessionError for any invalid field or object shape.
   */
  create(input: unknown): { token: string; session: Session } {
    const parsed = creation.safeParse(input);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fields[String(issue.path[0] ?? 'body')] = issue.message;
      }
      throw new SessionError(400, 'Check your name and starting credits.', fields);
    }
    const token = randomBytes(32).toString('base64url');
    const session: Session = {
      id: randomUUID(), name: parsed.data.name, balance: parsed.data.deposit,
      status: parsed.data.deposit < 100 ? 'depleted' : 'active', rounds: []
    };
    this.repository.create(session, hashToken(token));
    return { token, session };
  }

  /** Recover a session, failing closed for missing, malformed or unknown tokens.
   * Args: token: untrusted capability (without Bearer prefix).
   * Returns: public session, including recent completed rounds.
   * Raises: SessionError with 401 when authentication fails.
   */
  current(token: unknown): Session {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new SessionError(401, 'Your session key is missing or no longer valid. Start a new session.');
    }
    const session = this.repository.findByHash(hashToken(token));
    if (!session) throw new SessionError(401, 'Your session key is missing or no longer valid. Start a new session.');
    return session;
  }

  /** Stop an authorized session atomically and idempotently.
   * Args: token: browser-held capability.
   * Returns: stopped session with unchanged balance and history.
   * Raises: SessionError with 401 for invalid authentication.
   */
  stop(token: unknown): Session {
    return this.repository.db.transaction(() => {
      const session = this.current(token);
      this.repository.stop(session.id);
      return this.current(token);
    }).immediate();
  }
}
