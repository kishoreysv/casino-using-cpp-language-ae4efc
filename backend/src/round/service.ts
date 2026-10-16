/** Validate and commit completed rounds without storing or exposing an advance draw. */
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_BALANCE, Session } from '../session/repository';
import { SessionError, SessionService } from '../session/service';

const playInput = z.object({
  bet: z.number().int().min(100).max(MAX_BALANCE),
  guess: z.number().int().min(1).max(10)
}).strict();

/** Own atomic game rules using the established session repository.
 * Notes: Constructor-only draw injection allows deterministic tests, never runtime configuration.
 */
export class RoundService {
  /** Bind the shared session authority and a cryptographically random runtime draw.
   * Args: sessions: capability authority; draw: return a whole number from 1 through 10.
   */
  constructor(private readonly sessions: SessionService, private readonly draw: () => number = () => randomInt(1, 11)) {}

  /** Apply exactly one valid play and return public state with newest-first history.
   * Args: token: bearer capability; input: strictly shaped bet and guess JSON.
   * Returns: Committed session state. A win adds ten times the bet without deducting stake first.
   * Raises: SessionError for unauthorized, inactive, invalid or potentially overflowing plays.
   * Notes: Any draw, insertion or update failure rolls back the entire SQLite transaction.
   */
  play(token: unknown, input: unknown): Session {
    const db = this.sessions.repository.db;
    return db.transaction(() => {
      const session = this.sessions.current(token);
      if (session.status !== 'active' || session.balance < 100) {
        throw new SessionError(409, 'This session has finished. Start a new session to play.');
      }
      const parsed = playInput.safeParse(input);
      if (!parsed.success) {
        const fields: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          if (issue.path[0] === 'bet') fields.bet = 'Enter a whole-number stake of at least 100 credits.';
          if (issue.path[0] === 'guess') fields.guess = 'Choose a whole number from 1 to 10.';
        }
        throw new SessionError(400, 'Send only a valid bet and guess.', fields);
      }
      const { bet, guess } = parsed.data;
      if (bet > session.balance) {
        throw new SessionError(400, 'Your stake exceeds your balance.', { bet: 'Stake cannot exceed your balance.' });
      }
      if (session.balance + bet * 10 > MAX_BALANCE) {
        throw new SessionError(400, 'A potential win would exceed the balance limit.', { bet: 'Choose a smaller stake.' });
      }
      const draw = this.draw();
      if (!Number.isInteger(draw) || draw < 1 || draw > 10) throw new Error('Invalid draw source.');
      const delta = draw === guess ? bet * 10 : -bet;
      const balance = session.balance + delta;
      const status = balance < 100 ? 'depleted' : 'active';
      db.prepare('INSERT INTO rounds (id,session_id,bet,guess,draw,delta,balance) VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), session.id, bet, guess, draw, delta, balance);
      db.prepare('UPDATE sessions SET balance = ?, status = ? WHERE id = ?').run(balance, status, session.id);
      return this.sessions.current(token);
    }).immediate();
  }
}
