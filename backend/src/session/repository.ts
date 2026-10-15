/** Persist capability hashes and public session state using prepared SQLite statements. */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const MAX_BALANCE = 1_000_000_000;
export const MAX_DEPOSIT = 1_000_000;
export type SessionStatus = 'active' | 'stopped' | 'depleted';
export interface Round {
  id: string;
  bet: number;
  guess: number;
  draw: number;
  delta: number;
  balance: number;
}
export interface Session {
  id: string;
  name: string;
  balance: number;
  status: SessionStatus;
  rounds: Round[];
}
type SessionRow = Omit<Session, 'rounds'>;

/** Own a single connection; expose db for atomic round transactions in the next slice. */
export class SessionRepository {
  readonly db: Database.Database;

  /** Open a file and install the idempotent schema.
   * Args: databaseUrl: sqlite: prefixed file path.
   * Raises: Error for non-file URLs or SQLite initialization failures.
   */
  constructor(databaseUrl: string) {
    const filename = databaseUrl.slice('sqlite:'.length);
    if (!databaseUrl.startsWith('sqlite:') || !filename || filename === ':memory:' || filename.includes('?')) {
      throw new Error('A file-backed sqlite: URL is required');
    }
    mkdirSync(dirname(resolve(filename)), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
        balance INTEGER NOT NULL CHECK(typeof(balance) = 'integer' AND balance BETWEEN 0 AND ${MAX_BALANCE}),
        status TEXT NOT NULL CHECK(status IN ('active', 'stopped', 'depleted')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS rounds (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        bet INTEGER NOT NULL CHECK(typeof(bet) = 'integer' AND bet BETWEEN 100 AND ${MAX_BALANCE}),
        guess INTEGER NOT NULL CHECK(typeof(guess) = 'integer' AND guess BETWEEN 1 AND 10),
        draw INTEGER NOT NULL CHECK(typeof(draw) = 'integer' AND draw BETWEEN 1 AND 10),
        delta INTEGER NOT NULL CHECK(typeof(delta) = 'integer' AND delta BETWEEN -${MAX_BALANCE} AND ${MAX_BALANCE}),
        balance INTEGER NOT NULL CHECK(typeof(balance) = 'integer' AND balance BETWEEN 0 AND ${MAX_BALANCE}),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS rounds_session_sequence ON rounds(session_id, sequence DESC);
    `);
  }

  /** Insert an already-validated session without persisting its plaintext capability.
   * Args: session: public session; hash: SHA-256 capability digest.
   * Raises: SQLite constraint errors for invalid or duplicate data.
   */
  create(session: Session, hash: string): void {
    this.db.prepare('INSERT INTO sessions (id, token_hash, name, balance, status) VALUES (?, ?, ?, ?, ?)')
      .run(session.id, hash, session.name, session.balance, session.status);
  }

  /** Resolve a hash to public state, including the latest twenty completed rounds.
   * Args: hash: SHA-256 digest.
   * Returns: session or undefined; never includes capability hashes.
   */
  findByHash(hash: string): Session | undefined {
    const row = this.db.prepare('SELECT id, name, balance, status FROM sessions WHERE token_hash = ?')
      .get(hash) as SessionRow | undefined;
    if (!row) return undefined;
    const rounds = this.db.prepare(
      'SELECT id, bet, guess, draw, delta, balance FROM rounds WHERE session_id = ? ORDER BY sequence DESC LIMIT 20'
    ).all(row.id) as Round[];
    return { ...row, rounds };
  }

  /** Stop a known session; repeated calls preserve balance and round history.
   * Args: id: authenticated session identifier.
   */
  stop(id: string): void {
    this.db.prepare("UPDATE sessions SET status = 'stopped' WHERE id = ? AND status != 'stopped'").run(id);
  }

  /** Release the connection after listener shutdown or test completion. */
  close(): void {
    this.db.close();
  }
}
