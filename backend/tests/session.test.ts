/** Verify session services and HTTP routes against actual temporary SQLite files. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { createApp } from '../src/app';
import { MAX_BALANCE, MAX_DEPOSIT, SessionRepository } from '../src/session/repository';
import { hashToken, SessionError, SessionService } from '../src/session/service';

let directory: string;
let url: string;
let repository: SessionRepository;
let service: SessionService;
let api: ReturnType<typeof supertest>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tenfold-session-'));
  url = `sqlite:${join(directory, 'nested', 'session.db')}`;
  repository = new SessionRepository(url);
  service = new SessionService(repository);
  api = supertest(createApp(service, { corsOrigin: 'http://localhost:5173' }));
});
afterEach(() => {
  if (repository.db.open) repository.close();
  rmSync(directory, { recursive: true, force: true });
});

const invalidInputs: [string, unknown][] = [
  ['missing name', { deposit: 100 }],
  ['missing deposit', { name: 'Ada' }],
  ['null name', { name: null, deposit: 100 }],
  ['numeric name', { name: 7, deposit: 100 }],
  ['array name', { name: [], deposit: 100 }],
  ['empty name', { name: '', deposit: 100 }],
  ['whitespace name', { name: '  ', deposit: 100 }],
  ['overlong name', { name: 'a'.repeat(41), deposit: 100 }],
  ['control name', { name: 'a\nb', deposit: 100 }],
  ['invisible format name', { name: 'a\u202Eb', deposit: 100 }],
  ['string deposit', { name: 'Ada', deposit: '100' }],
  ['null deposit', { name: 'Ada', deposit: null }],
  ['boolean deposit', { name: 'Ada', deposit: true }],
  ['object deposit', { name: 'Ada', deposit: {} }],
  ['array deposit', { name: 'Ada', deposit: [100] }],
  ['zero deposit', { name: 'Ada', deposit: 0 }],
  ['negative deposit', { name: 'Ada', deposit: -1 }],
  ['fractional deposit', { name: 'Ada', deposit: 100.5 }],
  ['over-limit deposit', { name: 'Ada', deposit: MAX_DEPOSIT + 1 }],
  ['unsafe integer deposit', { name: 'Ada', deposit: Number.MAX_SAFE_INTEGER + 1 }],
  ['unknown field', { name: 'Ada', deposit: 100, status: 'stopped' }],
  ['array body', []],
  ['null body', null],
  ['string body', 'Ada'],
  ['empty object', {}]
];

describe('session service', () => {
  it('creates trimmed public state, persists only the capability hash, and reopens the file', () => {
    const result = service.create({ name: '  Ada  ', deposit: 1000 });
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.session).toEqual({ id: expect.any(String), name: 'Ada', balance: 1000, status: 'active', rounds: [] });
    const stored = repository.db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(stored.token_hash).toBe(hashToken(result.token));
    expect(stored.token_hash).not.toContain(result.token);
    expect(service.current(result.token)).toEqual(result.session);
    repository.close();
    repository = new SessionRepository(url);
    service = new SessionService(repository);
    expect(service.current(result.token)).toEqual(result.session);
  });

  it.each(invalidInputs)('rejects %s without inserting a session', (_label, input) => {
    expect(() => service.create(input)).toThrow(SessionError);
    expect(repository.db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 });
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite deposit %s', (deposit) => {
    expect(() => service.create({ name: 'Ada', deposit })).toThrow(SessionError);
  });

  it.each([1, 99, 100, MAX_DEPOSIT])('accepts boundary deposit %s and preserves depletion rules', (deposit) => {
    const { token, session } = service.create({ name: 'a'.repeat(40), deposit });
    expect(session.balance).toBe(deposit);
    expect(session.status).toBe(deposit < 100 ? 'depleted' : 'active');
    expect(service.current(token)).toEqual(session);
  });

  it.each([undefined, null, 123, '', 'x', 'A'.repeat(43), "' OR 1=1 --", '../session.db'])
    ('rejects invalid capability %s on current and stop', (token) => {
      const existing = service.create({ name: 'Ada', deposit: 100 });
      for (const operation of [() => service.current(token), () => service.stop(token)]) {
        expect(operation).toThrow(expect.objectContaining({ status: 401 }));
      }
      expect(service.current(existing.token)).toEqual(existing.session);
    });

  it('generates distinct isolated capabilities even for identical player names', () => {
    const first = service.create({ name: 'Ada', deposit: 100 });
    const second = service.create({ name: 'Ada', deposit: 200 });
    expect(first.token).not.toBe(second.token);
    expect(first.session.id).not.toBe(second.session.id);
    service.stop(first.token);
    expect(service.current(second.token)).toEqual(second.session);
  });

  it('stops idempotently and persists stopped state after reopening', () => {
    const { token, session } = service.create({ name: 'Ada', deposit: 500 });
    const stopped = service.stop(token);
    expect(stopped).toEqual({ ...session, status: 'stopped' });
    expect(service.stop(token)).toEqual(stopped);
    repository.close();
    repository = new SessionRepository(url);
    service = new SessionService(repository);
    expect(service.current(token)).toEqual(stopped);
  });

  it('stops a depleted session without changing its balance', () => {
    const { token } = service.create({ name: 'Ada', deposit: 1 });
    expect(service.stop(token)).toMatchObject({ balance: 1, status: 'stopped', rounds: [] });
  });

  it('enforces unique capability, not-null, balance and status constraints', () => {
    const { token, session } = service.create({ name: 'Ada', deposit: 100 });
    expect(() => repository.create({ ...session, id: 'duplicate' }, hashToken(token))).toThrow();
    expect(() => repository.db.prepare('UPDATE sessions SET name = NULL').run()).toThrow();
    for (const balance of [-1, MAX_BALANCE + 1, 1.5]) {
      expect(() => repository.db.prepare('UPDATE sessions SET balance = ?').run(balance)).toThrow();
    }
    expect(() => repository.db.prepare("UPDATE sessions SET status = 'invalid'").run()).toThrow();
    expect(service.current(token)).toEqual(session);
  });

  it('supports round foreign keys, ordered retrieval, constraints, rollback and cascading deletes', () => {
    const { token, session } = service.create({ name: 'Ada', deposit: 1000 });
    const insert = repository.db.prepare(
      'INSERT INTO rounds (id, session_id, bet, guess, draw, delta, balance) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    expect(() => insert.run('missing', 'unknown', 100, 1, 2, -100, 900)).toThrow();
    expect(() => insert.run('bad-bet', session.id, 99, 1, 2, -99, 901)).toThrow();
    expect(() => insert.run('bad-guess', session.id, 100, 11, 2, -100, 900)).toThrow();
    expect(() => insert.run('bad-draw', session.id, 100, 1, 0, -100, 900)).toThrow();
    insert.run('first', session.id, 100, 1, 2, -100, 900);
    insert.run('second', session.id, 100, 1, 1, 1000, 1900);
    expect(() => insert.run('second', session.id, 100, 1, 1, 1000, 1900)).toThrow();
    expect(service.current(token).rounds.map((round) => round.id)).toEqual(['second', 'first']);
    expect(() => repository.db.transaction(() => {
      repository.db.prepare('UPDATE sessions SET balance = 0').run();
      throw new Error('rollback');
    })()).toThrow('rollback');
    expect(service.current(token).balance).toBe(1000);
    repository.db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    expect(repository.db.prepare('SELECT count(*) AS count FROM rounds').get()).toEqual({ count: 0 });
  });
});

describe('session HTTP API', () => {
  it('creates, recovers and stops through Bearer-authenticated HTTP including reopen', async () => {
    const created = await api.post('/api/v1/sessions').send({ name: 'Ada', deposit: 1000 }).expect(201);
    expect(created.body.session).toEqual({ id: expect.any(String), name: 'Ada', balance: 1000, status: 'active', rounds: [] });
    expect(created.headers['cache-control']).toBe('no-store');
    const token = created.body.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const recovered = await api.get('/api/v1/sessions/current').auth(token, { type: 'bearer' }).expect(200);
    expect(recovered.body).toEqual({ session: created.body.session });
    const stopped = await api.post('/api/v1/sessions/stop').auth(token, { type: 'bearer' }).expect(200);
    expect(stopped.body.session).toEqual({ ...created.body.session, status: 'stopped' });
    const repeated = await api.post('/api/v1/sessions/stop').auth(token, { type: 'bearer' }).expect(200);
    expect(repeated.body).toEqual(stopped.body);
    repository.close();
    repository = new SessionRepository(url);
    service = new SessionService(repository);
    api = supertest(createApp(service, { corsOrigin: 'http://localhost:5173' }));
    const reopened = await api.get('/api/v1/sessions/current').auth(token, { type: 'bearer' }).expect(200);
    expect(reopened.body).toEqual(stopped.body);
    expect(JSON.stringify(reopened.body)).not.toContain(token);
    expect(JSON.stringify(reopened.body)).not.toContain('token_hash');
  });

  it.each(invalidInputs)('HTTP rejects %s with 400 and unchanged SQLite', async (_label, input) => {
    const response = await api.post('/api/v1/sessions').set('Content-Type', 'application/json')
      .send(JSON.stringify(input)).expect(400);
    expect(response.body.error).toEqual(expect.any(String));
    expect(repository.db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 });
  });

  it.each([undefined, '', 'Bearer x', `Bearer ${'A'.repeat(43)}`, 'Basic abc',
    `Bearer ${'A'.repeat(43)} extra`, "Bearer ' OR 1=1 --", 'Bearer ../session.db'])
    ('HTTP current and stop reject invalid authorization %s', async (authorization) => {
      for (const method of ['get', 'post'] as const) {
        const call = method === 'get' ? api.get('/api/v1/sessions/current') : api.post('/api/v1/sessions/stop');
        if (authorization !== undefined) call.set('Authorization', authorization);
        const response = await call.expect(401);
        expect(response.body.error).toMatch(/session key/i);
      }
    });

  it.each(["' OR 1=1; DROP TABLE sessions; --", '<script>alert(1)</script>', '../data/private.db'])
    ('treats security-like name %s as literal data, not SQL, HTML or a path', async (name) => {
      const created = await api.post('/api/v1/sessions').send({ name, deposit: 100 }).expect(201);
      const response = await api.get('/api/v1/sessions/current').auth(created.body.token, { type: 'bearer' }).expect(200);
      expect(response.body.session.name).toBe(name);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(repository.db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 1 });
    });

  it('rejects absent, non-JSON, malformed and oversized request bodies', async () => {
    await api.post('/api/v1/sessions').expect(400);
    await api.post('/api/v1/sessions').type('text').send('name=Ada').expect(400);
    const malformed = await api.post('/api/v1/sessions').type('json').send('{"name":').expect(400);
    expect(malformed.body).toEqual({ error: 'Malformed JSON body.' });
    const oversized = await api.post('/api/v1/sessions').send({ name: 'a'.repeat(9000), deposit: 100 }).expect(413);
    expect(oversized.body.error).toMatch(/8 KB/);
    expect(repository.db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 });
  });

  it('rejects malformed/oversized JSON on stop without mutating an authenticated session', async () => {
    const { token, session } = service.create({ name: 'Ada', deposit: 100 });
    await api.post('/api/v1/sessions/stop').auth(token, { type: 'bearer' }).type('json').send('{').expect(400);
    await api.post('/api/v1/sessions/stop').auth(token, { type: 'bearer' }).send({ large: 'x'.repeat(9000) }).expect(413);
    expect(service.current(token)).toEqual(session);
  });

  it('provides dependency-free health, JSON 404s and sanitized errors when persistence is unavailable', async () => {
    repository.close();
    const healthy = await api.get('/api/health').expect(200);
    expect(healthy.body).toEqual({ status: 'ok' });
    const missing = await api.get('/unknown').expect(404);
    expect(missing.body).toEqual({ error: 'Route not found.' });
    const roundFailure = await api.post('/api/v1/rounds').send({ bet: 100, guess: 1 }).expect(500);
    expect(roundFailure.body).toEqual({ error: 'The session service is unavailable. Please try again.' });
    expect(JSON.stringify(roundFailure.body)).not.toMatch(/SQLITE|database connection/i);
    const failure = await api.post('/api/v1/sessions').send({ name: 'Ada', deposit: 100 }).expect(500);
    expect(failure.body).toEqual({ error: 'The session service is unavailable. Please try again.' });
    expect(JSON.stringify(failure.body)).not.toMatch(/SQLITE|database connection/i);
  });

  it('allows only the configured browser origin', async () => {
    const allowed = await api.get('/api/health').set('Origin', 'http://localhost:5173').expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const other = await api.get('/api/health').set('Origin', 'https://untrusted.example').expect(200);
    expect(other.headers['access-control-allow-origin']).not.toBe('https://untrusted.example');
  });
});
