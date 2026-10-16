/** Verify round rules and HTTP boundaries against isolated, reopened SQLite files. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { SessionRepository, MAX_BALANCE } from '../src/session/repository';
import { SessionService } from '../src/session/service';
import { RoundService } from '../src/round/service';
import { createApp } from '../src/app';

let directory: string;
let path: string;
let repository: SessionRepository;
let sessions: SessionService;
let rounds: RoundService;
let token: string;
let id: string;
let draw: ReturnType<typeof vi.fn<() => number>>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tenfold-round-'));
  path = `sqlite:${join(directory, 'round.db')}`;
  repository = new SessionRepository(path);
  sessions = new SessionService(repository);
  const created = sessions.create({ name: 'Ada', deposit: 1000 });
  token = created.token;
  id = created.session.id;
  draw = vi.fn(() => 7);
  rounds = new RoundService(sessions, draw);
});
afterEach(() => {
  repository.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Read raw committed session and all rounds to prove failed commands do not mutate state. */
function state() {
  return {
    session: repository.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id),
    rounds: repository.db.prepare('SELECT * FROM rounds ORDER BY sequence').all()
  };
}

/** Send the command through the real app and capability header. */
function post(input: unknown, capability: string = token) {
  return request(createApp(sessions, { corsOrigin: 'http://localhost:5173' }, rounds))
    .post('/api/v1/rounds').set('Authorization', `Bearer ${capability}`).send(input as object);
}

const invalid = [
  ['missing both', {}], ['missing bet', { guess: 7 }], ['missing guess', { bet: 100 }],
  ['null shape', null], ['array shape', []], ['string shape', 'payload'],
  ['extra secret', { bet: 100, guess: 7, draw: 7 }], ['extra session id', { bet: 100, guess: 7, session_id: 'other' }],
  ['bet null', { bet: null, guess: 7 }], ['bet string', { bet: '100', guess: 7 }],
  ['bet boolean', { bet: true, guess: 7 }], ['bet object', { bet: {}, guess: 7 }],
  ['bet array', { bet: [100], guess: 7 }], ['bet zero', { bet: 0, guess: 7 }],
  ['bet negative', { bet: -100, guess: 7 }], ['bet below min', { bet: 99, guess: 7 }],
  ['bet decimal', { bet: 100.1, guess: 7 }], ['bet over balance', { bet: 1001, guess: 7 }],
  ['bet huge', { bet: Number.MAX_SAFE_INTEGER, guess: 7 }],
  ['bet SQL', { bet: '100; DROP TABLE sessions;--', guess: 7 }],
  ['bet XSS', { bet: '<script>alert(1)</script>', guess: 7 }],
  ['bet traversal', { bet: '../../data', guess: 7 }],
  ['guess null', { bet: 100, guess: null }], ['guess string', { bet: 100, guess: '7' }],
  ['guess boolean', { bet: 100, guess: true }], ['guess object', { bet: 100, guess: {} }],
  ['guess array', { bet: 100, guess: [7] }], ['guess zero', { bet: 100, guess: 0 }],
  ['guess negative', { bet: 100, guess: -1 }], ['guess too large', { bet: 100, guess: 11 }],
  ['guess decimal', { bet: 100, guess: 1.5 }], ['guess huge', { bet: 100, guess: 1e20 }],
  ['guess SQL', { bet: 100, guess: '7 OR 1=1' }], ['guess XSS', { bet: 100, guess: '<img src=x onerror=alert(1)>' }],
  ['guess traversal', { bet: 100, guess: '../1' }]
] as const;

describe('RoundService', () => {
  it('wins +10 times stake without subtracting first, loses stake, and persists after reopen', () => {
    const won = rounds.play(token, { bet: 100, guess: 7 });
    expect(won).toMatchObject({ balance: 2000, status: 'active' });
    expect(won.rounds[0]).toMatchObject({ bet: 100, guess: 7, draw: 7, delta: 1000, balance: 2000 });
    const lost = rounds.play(token, { bet: 250, guess: 1 });
    expect(lost.balance).toBe(1750);
    expect(lost.rounds[0]).toMatchObject({ bet: 250, guess: 1, draw: 7, delta: -250, balance: 1750 });
    expect(lost.rounds[1]).toEqual(won.rounds[0]);
    expect(lost.rounds[0].id).not.toBe(won.rounds[0].id);
    expect(draw).toHaveBeenCalledTimes(2);
    repository.close();
    repository = new SessionRepository(path);
    sessions = new SessionService(repository);
    expect(sessions.current(token)).toEqual(lost);
    expect(repository.db.prepare('SELECT count(*) AS n FROM rounds').get()).toEqual({ n: 2 });
  });

  it.each(invalid)('rejects %s without any draw or DB mutation', (_name, input) => {
    const before = state();
    expect(() => rounds.play(token, input)).toThrow(expect.objectContaining({ status: 400 }));
    expect(state()).toEqual(before);
    expect(draw).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-JSON number %s in each field', (value) => {
    const before = state();
    expect(() => rounds.play(token, { bet: value, guess: 7 })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => rounds.play(token, { bet: 100, guess: value })).toThrow(expect.objectContaining({ status: 400 }));
    expect(state()).toEqual(before);
    expect(draw).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(43), '../secret', '<script>', "' OR 1=1--"])
    ('rejects capability %s before drawing or revealing state', (capability) => {
      const before = state();
      expect(() => rounds.play(capability, { bet: 100, guess: 7 })).toThrow(expect.objectContaining({ status: 401 }));
      expect(state()).toEqual(before);
      expect(draw).not.toHaveBeenCalled();
    });

  it.each([1, 10])('accepts guess boundary %s and an all-balance win', (guess) => {
    const game = new RoundService(sessions, () => guess);
    expect(game.play(token, { bet: 1000, guess }).balance).toBe(11000);
    expect(sessions.current(token).rounds[0]).toMatchObject({ guess, draw: guess, delta: 10000 });
  });

  it.each([[200, 100, 'active'], [199, 99, 'depleted'], [100, 0, 'depleted']] as const)
    ('loss from %s ends at %s with status %s', (balance, expected, status) => {
      repository.db.prepare('UPDATE sessions SET balance = ? WHERE id = ?').run(balance, id);
      const saved = rounds.play(token, { bet: 100, guess: 1 });
      expect(saved).toMatchObject({ balance: expected, status });
      expect(sessions.current(token)).toEqual(saved);
      if (status === 'depleted') {
        const before = state();
        expect(() => rounds.play(token, { bet: 100, guess: 7 })).toThrow(expect.objectContaining({ status: 409 }));
        expect(state()).toEqual(before);
        expect(draw).toHaveBeenCalledTimes(1);
      }
    });

  it.each(['stopped', 'depleted'])('rejects existing %s status without draw', (status) => {
    repository.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
    const before = state();
    expect(() => rounds.play(token, { bet: 100, guess: 7 })).toThrow(expect.objectContaining({ status: 409 }));
    expect(state()).toEqual(before);
    expect(draw).not.toHaveBeenCalled();
  });

  it('rejects potential overflow before a losing draw and allows exactly max balance', () => {
    repository.db.prepare('UPDATE sessions SET balance = ? WHERE id = ?').run(MAX_BALANCE - 999, id);
    const before = state();
    expect(() => rounds.play(token, { bet: 100, guess: 1 })).toThrow(expect.objectContaining({ status: 400 }));
    expect(state()).toEqual(before);
    expect(draw).not.toHaveBeenCalled();
    repository.db.prepare('UPDATE sessions SET balance = ? WHERE id = ?').run(MAX_BALANCE - 1000, id);
    expect(rounds.play(token, { bet: 100, guess: 7 }).balance).toBe(MAX_BALANCE);
    expect(sessions.current(token).balance).toBe(MAX_BALANCE);
  });

  it('rolls back the round insert when the later balance update fails', () => {
    repository.db.exec("CREATE TRIGGER fail_balance BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    const before = state();
    expect(() => rounds.play(token, { bet: 100, guess: 7 })).toThrow('forced failure');
    expect(state()).toEqual(before);
    repository.db.exec('DROP TRIGGER fail_balance');
    expect(rounds.play(token, { bet: 100, guess: 7 }).balance).toBe(2000);
  });

  it('rolls back on insertion failure and throwing or invalid RNG', () => {
    const before = state();
    repository.db.exec("CREATE TRIGGER fail_round BEFORE INSERT ON rounds BEGIN SELECT RAISE(ABORT, 'insert failure'); END");
    expect(() => rounds.play(token, { bet: 100, guess: 7 })).toThrow('insert failure');
    expect(state()).toEqual(before);
    repository.db.exec('DROP TRIGGER fail_round');
    const broken = new RoundService(sessions, () => { throw new Error('draw failed'); });
    expect(() => broken.play(token, { bet: 100, guess: 7 })).toThrow('draw failed');
    for (const value of [0, 11, 1.5, NaN]) {
      expect(() => new RoundService(sessions, () => value).play(token, { bet: 100, guess: 7 })).toThrow('Invalid draw source');
    }
    expect(state()).toEqual(before);
  });

  it('takes the SQLite write lock before drawing and releases it after commit', () => {
    const second = new SessionRepository(path);
    second.db.pragma('busy_timeout = 1');
    try {
      const game = new RoundService(sessions, () => {
        expect(repository.db.inTransaction).toBe(true);
        expect(() => second.db.transaction(() => {}).immediate()).toThrow('database is locked');
        return 7;
      });
      const saved = game.play(token, { bet: 100, guess: 7 });
      expect(saved.balance).toBe(2000);
      expect(repository.db.inTransaction).toBe(false);
      expect(second.db.transaction(() => new SessionService(second).current(token)).immediate()).toEqual(saved);
    } finally {
      second.close();
    }
  });

  it.each([
    ['id', null], ['session_id', null], ['session_id', 'missing-session'],
    ['bet', null], ['bet', 99], ['bet', 100.5], ['bet', MAX_BALANCE + 1],
    ['guess', null], ['guess', 0], ['guess', 11], ['guess', 1.5],
    ['draw', null], ['draw', 0], ['draw', 11], ['draw', 1.5],
    ['delta', null], ['delta', 1.5], ['delta', MAX_BALANCE + 1], ['delta', -MAX_BALANCE - 1],
    ['balance', null], ['balance', -1], ['balance', 1.5], ['balance', MAX_BALANCE + 1]
  ])('enforces the real round constraint for %s=%s without mutation', (field, value) => {
    const record: Record<string, unknown> = {
      id: 'constraint-round', session_id: id, bet: 100, guess: 7, draw: 7, delta: 1000, balance: 2000
    };
    record[field as string] = value;
    const before = state();
    expect(() => repository.db.prepare(
      'INSERT INTO rounds (id,session_id,bet,guess,draw,delta,balance) VALUES (@id,@session_id,@bet,@guess,@draw,@delta,@balance)'
    ).run(record)).toThrow();
    expect(state()).toEqual(before);
  });

  it('enforces unique round IDs and cascades only the deleted session history', () => {
    const saved = rounds.play(token, { bet: 100, guess: 7 });
    const other = sessions.create({ name: 'Other', deposit: 1000 });
    const otherSaved = rounds.play(other.token, { bet: 100, guess: 7 });
    const before = state();
    expect(() => repository.db.prepare(
      'INSERT INTO rounds (id,session_id,bet,guess,draw,delta,balance) VALUES (?,?,?,?,?,?,?)'
    ).run(saved.rounds[0].id, id, 100, 7, 7, 1000, 2000)).toThrow('UNIQUE');
    expect(state()).toEqual(before);
    repository.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    expect(repository.db.prepare('SELECT count(*) AS n FROM rounds WHERE session_id = ?').get(id)).toEqual({ n: 0 });
    expect(sessions.current(other.token)).toEqual(otherSaved);
    expect(() => sessions.current(token)).toThrow(expect.objectContaining({ status: 401 }));
  });

  it('retains all durable records while returning only 20 newest rounds', () => {
    for (let index = 0; index < 25; index++) rounds.play(token, { bet: 100, guess: 7 });
    const saved = sessions.current(token);
    expect(saved.balance).toBe(26000);
    expect(saved.rounds).toHaveLength(20);
    expect(saved.rounds.map((round) => round.balance)).toEqual(Array.from({ length: 20 }, (_, index) => 26000 - index * 1000));
    expect(repository.db.prepare('SELECT count(*) AS n FROM rounds').get()).toEqual({ n: 25 });
    expect(draw).toHaveBeenCalledTimes(25);
  });
});

describe('round HTTP API', () => {
  it('returns 201 with committed result only after play, without capability/hash leaks', async () => {
    expect(sessions.current(token).rounds).toEqual([]);
    expect(draw).not.toHaveBeenCalled();
    const response = await post({ bet: 100, guess: 7 });
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ session: sessions.current(token) });
    expect(response.body.session).toMatchObject({ id, balance: 2000, status: 'active' });
    expect(response.body.session.rounds[0]).toMatchObject({ bet: 100, guess: 7, draw: 7, delta: 1000, balance: 2000 });
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(JSON.stringify(response.body)).not.toContain('token_hash');
    expect(Object.keys(response.body)).toEqual(['session']);
  });

  it.each(invalid.filter(([, input]) => input !== null && typeof input !== 'string'))
    ('returns explicit 400 for %s with unchanged real DB', async (_name, input) => {
      const before = state();
      const response = await post(input);
      expect(response.status).toBe(400);
      expect(response.body.error).toEqual(expect.any(String));
      expect(state()).toEqual(before);
      expect(draw).not.toHaveBeenCalled();
    });

  it.each(['', 'Basic abc', 'Bearer', 'Bearer short', `Bearer ${'Z'.repeat(43)}`, 'Bearer ../data', "Bearer 'OR1=1", 'Bearer <script>'])
    ('returns 401 for header %s with no state leak or draw', async (authorization) => {
      const before = state();
      const response = await request(createApp(sessions, { corsOrigin: 'http://localhost:5173' }, rounds))
        .post('/api/v1/rounds').set('Authorization', authorization).send({ bet: 100, guess: 7 });
      expect(response.status).toBe(401);
      expect(Object.keys(response.body)).toEqual(['error']);
      expect(state()).toEqual(before);
      expect(draw).not.toHaveBeenCalled();
    });

  it('rejects absent header and absent body with 401 and 400 respectively', async () => {
    const app = createApp(sessions, { corsOrigin: 'http://localhost:5173' }, rounds);
    const noAuth = await request(app).post('/api/v1/rounds').send({ bet: 100, guess: 7 });
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error).toEqual(expect.any(String));
    const noBody = await request(app).post('/api/v1/rounds').set('Authorization', `Bearer ${token}`);
    expect(noBody.status).toBe(400);
    expect(noBody.body.error).toEqual(expect.any(String));
    expect(sessions.current(token).rounds).toEqual([]);
    expect(draw).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'depleted'])('returns 409 for %s status', async (status) => {
    repository.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
    const before = state();
    const response = await post({ bet: 100, guess: 7 });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('finished');
    expect(state()).toEqual(before);
    expect(draw).not.toHaveBeenCalled();
  });

  it('returns a committed loss and rejects depleted replay with unchanged state', async () => {
    repository.db.prepare('UPDATE sessions SET balance = 100 WHERE id = ?').run(id);
    const response = await post({ bet: 100, guess: 1 });
    expect(response.status).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.session).toMatchObject({ id, balance: 0, status: 'depleted' });
    expect(response.body.session.rounds[0]).toMatchObject({ bet: 100, guess: 1, draw: 7, delta: -100, balance: 0 });
    expect(response.body).toEqual({ session: sessions.current(token) });
    const before = state();
    const rejected = await post({ bet: 100, guess: 7 });
    expect(rejected.status).toBe(409);
    expect(rejected.body).toEqual({ error: 'This session has finished. Start a new session to play.' });
    expect(state()).toEqual(before);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('rejects an active but below-minimum balance with 409 before validation or drawing', async () => {
    repository.db.prepare('UPDATE sessions SET balance = 99 WHERE id = ?').run(id);
    const before = state();
    const response = await post({ bet: 0, guess: 11 });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('finished');
    expect(state()).toEqual(before);
    expect(draw).not.toHaveBeenCalled();
  });

  it('returns 400 for potential win overflow before RNG', async () => {
    repository.db.prepare('UPDATE sessions SET balance = ? WHERE id = ?').run(MAX_BALANCE - 999, id);
    const before = state();
    const response = await post({ bet: 100, guess: 1 });
    expect(response.status).toBe(400);
    expect(response.body.fields.bet).toContain('smaller');
    expect(state()).toEqual(before);
    expect(draw).not.toHaveBeenCalled();
  });

  it('isolates another valid capability even when malicious input supplies a session id', async () => {
    const other = sessions.create({ name: 'Other', deposit: 500 });
    const rejected = await post({ bet: 100, guess: 7, session_id: id }, other.token);
    expect(rejected.status).toBe(400);
    const response = await post({ bet: 100, guess: 7 }, other.token);
    expect(response.status).toBe(201);
    expect(response.body.session.id).toBe(other.session.id);
    expect(response.body.session.balance).toBe(1500);
    expect(sessions.current(token)).toMatchObject({ balance: 1000, rounds: [] });
  });

  it('rejects malformed, primitive and oversized JSON before drawing', async () => {
    const app = createApp(sessions, { corsOrigin: 'http://localhost:5173' }, rounds);
    const before = state();
    for (const body of ['{', 'null', '"text"']) {
      const response = await request(app).post('/api/v1/rounds').set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('JSON');
    }
    const oversized = await post({ bet: 'x'.repeat(9000), guess: 7 });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error).toContain('8 KB');
    expect(state()).toEqual(before);
    expect(draw).not.toHaveBeenCalled();
  });

  it('returns sanitized 500 and rolls back when a late database write fails', async () => {
    repository.db.exec("CREATE TRIGGER fail_balance BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'private SQL failure'); END");
    const before = state();
    const response = await post({ bet: 100, guess: 7 });
    expect(response.status).toBe(500);
    expect(response.body.error).toContain('try again');
    expect(JSON.stringify(response.body)).not.toContain('private SQL');
    expect(state()).toEqual(before);
  });

  it('serializes simultaneous losses against current balance instead of accepting stale bets', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => post({ bet: 100, guess: 1 })));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(2);
    for (const response of responses) {
      if (response.status === 201) expect(response.body.session.rounds[0].delta).toBe(-100);
      else expect(response.body.error).toContain('finished');
    }
    expect(sessions.current(token)).toMatchObject({ balance: 0, status: 'depleted' });
    expect(sessions.current(token).rounds).toHaveLength(10);
    expect(repository.db.prepare('SELECT count(*) AS n FROM rounds').get()).toEqual({ n: 10 });
    expect(draw).toHaveBeenCalledTimes(10);
    repository.close();
    repository = new SessionRepository(path);
    expect(new SessionService(repository).current(token)).toMatchObject({ balance: 0, status: 'depleted' });
  });

  it('allows repeated valid commands as distinct plays and serializes separate SQLite connections', async () => {
    const secondRepository = new SessionRepository(path);
    try {
      const secondService = new SessionService(secondRepository);
      const secondGame = new RoundService(secondService, () => 7);
      const secondApp = createApp(secondService, { corsOrigin: 'http://localhost:5173' }, secondGame);
      const responses = await Promise.all([
        post({ bet: 100, guess: 7 }),
        request(secondApp).post('/api/v1/rounds').set('Authorization', `Bearer ${token}`).send({ bet: 100, guess: 7 })
      ]);
      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      expect(sessions.current(token).balance).toBe(3000);
      expect(sessions.current(token).rounds).toHaveLength(2);
      expect(new Set(sessions.current(token).rounds.map((round) => round.id)).size).toBe(2);
      expect(secondService.current(token)).toEqual(sessions.current(token));
    } finally {
      secondRepository.close();
    }
  });

  it('uses valid secure draws by default without test injection', async () => {
    const response = await request(createApp(sessions, { corsOrigin: 'http://localhost:5173' }))
      .post('/api/v1/rounds').set('Authorization', `Bearer ${token}`).send({ bet: 100, guess: 7 });
    expect(response.status).toBe(201);
    const round = response.body.session.rounds[0];
    expect(Number.isInteger(round.draw)).toBe(true);
    expect(round.draw).toBeGreaterThanOrEqual(1);
    expect(round.draw).toBeLessThanOrEqual(10);
    expect(round.delta).toBe(round.draw === 7 ? 1000 : -100);
    expect(response.body.session.balance).toBe(1000 + round.delta);
  });
});
