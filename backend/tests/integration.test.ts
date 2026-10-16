/** Verify session, round and repository data flows through real HTTP and durable SQLite files. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect } from 'vitest';
import request from 'supertest';
import { SessionRepository } from '../src/session/repository';
import { SessionService } from '../src/session/service';
import { RoundService } from '../src/round/service';
import { createApp } from '../src/app';

let directory: string;
let url: string;
let repository: SessionRepository;
let sessions: SessionService;
let api: ReturnType<typeof request>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tenfold-integration-'));
  url = `sqlite:${join(directory, 'journey.db')}`;
  repository = new SessionRepository(url);
  sessions = new SessionService(repository);
  api = request(createApp(sessions, { corsOrigin: 'http://localhost:5173' }, new RoundService(sessions, () => 7)));
});
afterEach(() => {
  repository.close();
  rmSync(directory, { recursive: true, force: true });
});

it('chains session creation, round service, stop and repository recovery with exact persisted balances', async () => {
  const created = await api.post('/api/v1/sessions').send({ name: 'Journey', deposit: 1000 }).expect(201);
  const token = created.body.token;
  const won = await api.post('/api/v1/rounds').auth(token, { type: 'bearer' }).send({ bet: 100, guess: 7 }).expect(201);
  expect(won.body.session.balance).toBe(2000);
  expect(won.body.session.rounds[0]).toMatchObject({ bet: 100, guess: 7, draw: 7, delta: 1000, balance: 2000 });
  const lost = await api.post('/api/v1/rounds').auth(token, { type: 'bearer' }).send({ bet: 200, guess: 1 }).expect(201);
  expect(lost.body.session.balance).toBe(1800);
  expect(lost.body.session.rounds[1]).toEqual(won.body.session.rounds[0]);
  const stopped = await api.post('/api/v1/sessions/stop').auth(token, { type: 'bearer' }).expect(200);
  expect(stopped.body.session).toEqual({ ...lost.body.session, status: 'stopped' });
  await api.post('/api/v1/rounds').auth(token, { type: 'bearer' }).send({ bet: 100, guess: 7 }).expect(409);
  const recovered = await api.get('/api/v1/sessions/current').auth(token, { type: 'bearer' }).expect(200);
  expect(recovered.body.session).toEqual(stopped.body.session);
  expect(repository.db.prepare('SELECT balance,status FROM sessions WHERE id=?').get(created.body.session.id))
    .toEqual({ balance: 1800, status: 'stopped' });
  expect(repository.db.prepare('SELECT count(*) AS count FROM rounds').get()).toEqual({ count: 2 });
  repository.close();
  repository = new SessionRepository(url);
  sessions = new SessionService(repository);
  expect(sessions.current(token)).toEqual(stopped.body.session);
  expect(repository.db.pragma('integrity_check', { simple: true })).toBe('ok');
});

it('propagates invalid creation and missing capability without leaving downstream orphan rounds', async () => {
  await api.post('/api/v1/sessions').send({ name: '', deposit: 1000 }).expect(400);
  const denied = await api.post('/api/v1/rounds').send({ bet: 100, guess: 7 }).expect(401);
  expect(denied.body.error).toMatch(/session key/);
  await api.post('/api/v1/sessions/stop').expect(401);
  expect(repository.db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 });
  expect(repository.db.prepare('SELECT count(*) AS count FROM rounds').get()).toEqual({ count: 0 });
});

it('isolates two capabilities across play, recovery and stop while rejecting ownership overrides', async () => {
  const first = await api.post('/api/v1/sessions').send({ name: 'First', deposit: 500 }).expect(201);
  const second = await api.post('/api/v1/sessions').send({ name: 'Second', deposit: 800 }).expect(201);
  await api.post('/api/v1/rounds').auth(first.body.token, { type: 'bearer' })
    .send({ bet: 100, guess: 7, session_id: second.body.session.id }).expect(400);
  await api.post('/api/v1/rounds').auth(first.body.token, { type: 'bearer' }).send({ bet: 100, guess: 7 }).expect(201);
  await api.post('/api/v1/sessions/stop').auth(first.body.token, { type: 'bearer' }).expect(200);
  const untouched = await api.get('/api/v1/sessions/current').auth(second.body.token, { type: 'bearer' }).expect(200);
  expect(untouched.body.session).toEqual(second.body.session);
  expect(sessions.current(first.body.token)).toMatchObject({ balance: 1500, status: 'stopped' });
  expect(repository.db.prepare('SELECT session_id FROM rounds').all()).toEqual([{ session_id: first.body.session.id }]);
});

it('shares depleted state from a losing round with recovery and rejects further play without mutations', async () => {
  const created = await api.post('/api/v1/sessions').send({ name: 'Last stake', deposit: 100 }).expect(201);
  const token = created.body.token;
  const lost = await api.post('/api/v1/rounds').auth(token, { type: 'bearer' }).send({ bet: 100, guess: 1 }).expect(201);
  expect(lost.body.session).toMatchObject({ balance: 0, status: 'depleted' });
  await api.post('/api/v1/rounds').auth(token, { type: 'bearer' }).send({ bet: 100, guess: 7 }).expect(409);
  const recovered = await api.get('/api/v1/sessions/current').auth(token, { type: 'bearer' }).expect(200);
  expect(recovered.body.session).toEqual(lost.body.session);
  expect(repository.db.prepare('SELECT count(*) AS count FROM rounds').get()).toEqual({ count: 1 });
  expect(repository.db.prepare('SELECT balance,status FROM sessions').get()).toEqual({ balance: 0, status: 'depleted' });
});

it('rolls back failed downstream persistence and lets the same recovered session play afterward', async () => {
  const created = await api.post('/api/v1/sessions').send({ name: 'Rollback', deposit: 1000 }).expect(201);
  repository.db.exec("CREATE TRIGGER reject_round BEFORE INSERT ON rounds BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");
  const failure = await api.post('/api/v1/rounds').auth(created.body.token, { type: 'bearer' })
    .send({ bet: 100, guess: 7 }).expect(500);
  expect(failure.body).toEqual({ error: 'The session service is unavailable. Please try again.' });
  expect(sessions.current(created.body.token)).toEqual(created.body.session);
  expect(repository.db.prepare('SELECT count(*) AS count FROM rounds').get()).toEqual({ count: 0 });
  repository.db.exec('DROP TRIGGER reject_round');
  const played = await api.post('/api/v1/rounds').auth(created.body.token, { type: 'bearer' })
    .send({ bet: 100, guess: 7 }).expect(201);
  expect(played.body.session.balance).toBe(2000);
  expect(sessions.current(created.body.token)).toEqual(played.body.session);
  expect(repository.db.prepare('SELECT count(*) AS count FROM rounds').get()).toEqual({ count: 1 });
});
