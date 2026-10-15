# Tenfold

A browser companion to the original console number-guessing game in `main (1).cpp`. All credits are fictional: no money, payments, prizes, accounts, or monetization. The original C++ source is preserved unchanged.

## Current scope

This implementation contains **slice 1: session entry, recovery, and stop**. `/` explains the rules and accepts a name and starting credits. `/play` shows the real saved name, balance, status, and recent-round count, with visible links back to setup and an idempotent stop action. The number grid, draw service, round endpoint, reveal, and playable game table belong to the next slice and are **not implemented yet**. No simulated draws or fake game functions are shipped.

### Original rules to preserve in the round slice

- Guess a number from 1–10; draw randomly on the server.
- Minimum stake: 100 credits; never more than the current balance.
- A win **adds stake × 10** to the current balance. The stake is **not deducted first**.
- A loss subtracts the stake.
- Stop on request or when the balance falls below 100.

Session creation accepts whole-number deposits from **1 to 1,000,000**. Deposits below 100 create a `depleted` session rather than inventing a new minimum-deposit rule. Names are trimmed, 1–40 characters, and reject control/invisible formatting characters. Unexpected fields and nonnumeric deposits are rejected. Database balances are bounded at 1,000,000,000 to support the upcoming bounded round implementation.

## Stack and layout

- `backend/`: strict TypeScript, Express 4, Zod, Helmet, better-sqlite3; compiled CommonJS runtime.
- `frontend/`: Vite, React 18, JavaScript/JSX, React Router; a single router in `src/App.jsx`.
- SQLite is file-backed, prepared-statement based, foreign-key enabled, WAL mode, with a 5-second busy timeout. Schema creation is idempotent at startup.
- Vitest/Supertest test the actual backend with temporary SQLite files; Testing Library covers frontend session behavior.
- Playwright specs are in `frontend/e2e`; Docker builds independent tiers and nginx proxies `/api`.

## Prerequisites

Use **Node.js 22** and npm. better-sqlite3 may compile a native extension; if no compatible prebuilt binary is available, install Python 3, make and a C++ compiler (Linux: `python3 make g++`; Windows: supported Visual Studio C++ build tools). The backend Docker build includes this toolchain.

The environment disables npm bin links. All scripts invoke package entry files with `node`; do not substitute `npx` commands.

## Install and run locally

Run commands from the indicated directories, in separate terminals for development.

Backend (`backend/`):

```sh
npm ci --no-bin-links --no-audit --no-fund
# Copy .env.example to .env if the runnable development .env is absent.
node node_modules/typescript/bin/tsc
node dist/index.js
# Or hot reload:
node node_modules/ts-node-dev/lib/bin.js --files --respawn src/index.ts
```

Frontend (`frontend/`):

```sh
npm ci --no-bin-links --no-audit --no-fund
# Copy .env.example to .env if needed.
node node_modules/vite/bin/vite.js
```

Open **http://localhost:5173**. The frontend uses relative `/api` requests and the Vite proxy forwards them to the backend on **http://localhost:3000**. Backend liveness is **GET http://localhost:3000/api/health**. No frontend import depends on the backend build.

To serve a production frontend build locally (`frontend/`, with the backend running):

```sh
node node_modules/vite/bin/vite.js build
node node_modules/vite/bin/vite.js preview
```

Open **http://localhost:4173**. Preview has its own API proxy. For direct cross-origin API requests, set backend `CORS_ORIGIN` to the exact browser origin; normal proxied requests remain same-origin.

### Environment contract

Development `.env` and `.env.example` are per-tier. Runnable `.env` files contain only local settings, not credentials; keep them ignored and commit only examples. There is no root `.env` requirement.

| Tier | Variable | Default | Meaning |
|---|---|---|---|
| Backend | `PORT` | `3000` | Integer 1–65535; listener binds `0.0.0.0` |
| Backend | `DATABASE_URL` | `sqlite:./data/tenfold.db` | File path relative to backend working directory; in-memory databases rejected |
| Backend | `CORS_ORIGIN` | `http://localhost:5173` | Exact HTTP(S) origin, without path or trailing slash |
| Backend | `NODE_ENV` | `development` | `development`, `test`, or `production` |
| Frontend | `VITE_API_BASE_URL` | `/api` | Browser-visible API prefix, baked into the Vite build |
| Frontend | `API_PROXY_TARGET` | `http://localhost:3000` | Dev/preview server proxy only; not a browser URL |
| Frontend | `FRONTEND_PORT` | `5173` | Development port; strict port selection |
| Frontend | `PREVIEW_PORT` | `4173` | Preview port; strict port selection |

Environment overrides take precedence over `.env`. Restart the backend after changing its configuration; rebuild the frontend after changing `VITE_API_BASE_URL`. The HTML loads Fraunces and DM Sans with `display=swap`; Georgia/Arial fallbacks work without Google Fonts connectivity. No theme toggle is added: this scope uses the planned copper/charcoal dark identity.

## Session API

Business endpoints use `/api/v1`. Health is deliberately unversioned. All responses are JSON.

| Method/path | Input | Result |
|---|---|---|
| `POST /api/v1/sessions` | JSON `{ "name": "Ada", "deposit": 1000 }` | `201 {token, session}` |
| `GET /api/v1/sessions/current` | `Authorization: Bearer <token>` | `200 {session}` |
| `POST /api/v1/sessions/stop` | Same Bearer header; body unnecessary | `200 {session}` with `status: "stopped"`; repeated calls return the same state |
| `GET /api/health` | None | `200 { "status": "ok" }`, independent of database access |

Public session shape:

```json
{
  "id": "server-generated-uuid",
  "name": "Ada",
  "balance": 1000,
  "status": "active",
  "rounds": []
}
```

Status is `active`, `depleted`, or `stopped`. Retrieval never returns a token or token hash. Creation returns a random 32-byte base64url capability exactly once. Validation returns `400 {error, fields}` where applicable. Missing, malformed, and unknown capabilities return `401 {error}`. Malformed JSON returns 400; JSON over **8 KB** returns 413; unknown routes return `404 {error}`. Unexpected internal errors use a sanitized 500 response without SQL details. `/api/v1/rounds` currently returns 404 because the round slice is not mounted.

Example (bash):

```sh
curl -i http://localhost:3000/api/v1/sessions \
  -H 'Content-Type: application/json' \
  --data '{"name":"Ada","deposit":1000}'
# Keep the returned token private and replace TOKEN below.
curl http://localhost:3000/api/v1/sessions/current -H 'Authorization: Bearer TOKEN'
curl -X POST http://localhost:3000/api/v1/sessions/stop -H 'Authorization: Bearer TOKEN'
```

## Persistence and security

The database stores **SHA-256 capability hashes**, never plaintext capabilities. The browser stores only the token under `sessionStorage["tenfold.session.token"]`; public session state is recovered from SQLite on reload. The token is a bearer capability: whoever possesses it controls that session. Use HTTPS in production and never log/share the token. No user accounts or recovery by name are implemented. Closing the tab or clearing storage loses access, while the database record remains. Server restarts preserve sessions as long as the database file/volume is retained.

Prepared SQL treats SQL-injection-like names literally. React text rendering escapes names (including HTML-like input); no raw HTML insertion is used. Session responses are `Cache-Control: no-store`. Authenticated 401 clears the browser key; transient failures retain it and offer retry. Transport requests have a 15-second timeout and recovery supports cancellation. CORS allows the configured origin rather than a wildcard. The capability model does not replace deployment-level request-rate limits: creation is public, so add rate limiting and volume/retention monitoring for public hosting. There is no session TTL or cleanup job in this slice.

SQLite `sessions` includes ID, capability hash, name, balance, status and creation time. The prepared `rounds` table has an ordered sequence, public round ID, owning session foreign key with cascade delete, integer bet/guess/draw/delta/balance constraints and creation time. Session reads return the latest **20** completed rounds newest first. No round is created by this slice.

### Interfaces exported for slice 2

- `backend/src/session/repository.ts`: `SessionRepository` with public `readonly db: Database.Database`, `create(session, hash)`, `findByHash(hash)`, `stop(id)`, `close()`; `Session`, `Round`, `SessionStatus`, `MAX_DEPOSIT`, `MAX_BALANCE`. Use `repository.db.transaction(...).immediate()` for atomic authenticated round/balance updates, prepared statements, and the existing schema.
- `backend/src/session/service.ts`: `SessionService` with public `repository`, `create(input: unknown)`, `current(token: unknown)`, `stop(token: unknown)`; `SessionError(status, message, fields?)`, `hashToken(token)`.
- `backend/src/session/routes.ts`: `bearerToken(request)` and `sessionRouter(service)`.
- `backend/src/app.ts`: `createApp(service, {corsOrigin})`; mount the future round router here rather than creating a second server.
- `backend/src/config.ts`: `loadConfig(env?)` and `Config`.
- `frontend/src/session/api.js`: `request(path, {method, body, token, signal} = {})`, `TOKEN_KEY`, `ApiError`, `startSession(input)`, `recoverSession(signal?)`, `stopSession()`. Paths are relative to the configured `/api` prefix. Auth is explicit in the shared request utility; future authenticated round requests must pass the stored token.
- `frontend/src/App.jsx`: default `App` owns the single `BrowserRouter`. Its session root holds `session` and `setSession`; replace the `/play` summary route with `<Game session={session} setSession={setSession} />` in slice 2. Do not add a router in `main.jsx` or `Game`.

## Tests and build verification

Permitted slice commands:

```sh
# backend/
node node_modules/vitest/vitest.mjs run tests/session.test.ts
node node_modules/typescript/bin/tsc
# frontend/
node node_modules/vitest/vitest.mjs run src/session/Welcome.test.jsx
node node_modules/vite/bin/vite.js build
```

Backend tests use distinct temporary **file-backed** SQLite databases, close/reopen them, and remove the files afterward. Coverage includes create/current/stop, isolated capabilities, each invalid field, missing/invalid Bearer headers, boundaries/depletion, literal SQL/XSS/path-like names, malformed/oversized JSON, unknown routes, dependency-free health, sanitized errors, schema constraints, foreign keys, transaction rollback and cascade deletion. Frontend tests cover Welcome positive/validation/pending/errors/retry, literal text rendering, transport authentication/cancellation and app recovery/navigation/stop states. Network stubs are confined to component tests.

### E2E and preflight (parent verification only)

**The E2E spec is written but has not been executed in this slice.** The parent must run the test critic and complete cross-feature checks before final E2E. When authorized, build both tiers using the commands above, then run from `frontend/`:

```sh
node node_modules/@playwright/test/cli.js install chromium
node node_modules/@playwright/test/cli.js test e2e/session.spec.js
```

The tier-local Playwright config launches compiled backend `node dist/index.js` on **3100** with `sqlite:./data/e2e-session.db`, and Vite preview independently on **4173**, proxying `/api` to 3100. It refuses to reuse an existing server. Both builds must already exist. E2E records persist in that dedicated database; delete it only when neither process is running if a clean fixture is needed.

Desktop Chromium and mobile Chromium projects cover link-driven navigation, missing-session entry, individual input validation, real session response content, reload recovery, stopping, idempotence and invalid-capability recovery. Loading checks temporarily hold an outgoing API request then continue it unchanged to the real backend; no response is fabricated. Console/page errors are asserted; the explicit invalid-token case permits only Chromium's expected HTTP-401 resource diagnostic. The spec captures full-page screenshots, ARIA snapshots, rendered HTML and computed typography/viewport information as Playwright evidence for welcome, empty, invalid, pending, saved and recovery-error states. Screenshot images are for human review; the parent can inspect the text attachments and source for visual preflight.

Integration tests, actual E2E/browser preflight, Compose verification, critic signoff and publication remain parent responsibilities. No claim of those layers passing is made here.

## Docker deployment

The backend build uses **node:22-bookworm-slim** plus the native SQLite build toolchain; the runtime uses the same Node image, runs as `node`, and starts compiled output. The frontend build also uses **node:22-bookworm-slim**, then nginx serves `dist` with history fallback (`/play` reload resolves to `index.html`) and proxies `/api/` to **backend:3000**. Neither container uses localhost to reach the other.

When authorized to verify deployment, from the root:

```sh
docker compose up --build -d
docker compose ps
curl http://localhost:3000/api/health
curl http://localhost:8080/api/health
# /play must deliver the SPA as well:
curl -I http://localhost:8080/play
docker compose down
```

Default host ports are backend **3000** and frontend **8080**. Compose overrides `PORT=3000`, `NODE_ENV=production`, `DATABASE_URL=sqlite:./data/tenfold.db` and the appropriate local `CORS_ORIGIN`; frontend build prefix is `/api`. Optional shell variables `BACKEND_HTTP_PORT` and `FRONTEND_HTTP_PORT` override host mappings; nginx still targets the fixed internal backend port. For a remote domain, replace Compose's CORS origin with your actual HTTPS origin. The named volume **tenfold-data** mounts `/app/data`, retaining sessions across container recreation. `docker compose down -v` destroys that persistence—do not use it unless intentional. Ensure the volume is writable by the backend runtime user; back up SQLite with a SQLite-aware backup process, accounting for WAL files.

If ports are busy, choose new env values rather than silently accepting another port. If SQLite installation fails, check Node compatibility and the native toolchain. If recovery fails after a server restart, verify `DATABASE_URL`, working directory, volume retention and tab storage before creating a new session. This slice does not modify `.gitignore`, `PLAN.md`, `todos.yaml`, or the original console source; the parent verifies and commits it.
