# Tenfold

A browser companion to the original console number-guessing game in `main (1).cpp`. All credits are fictional: no money, payments, prizes, accounts, or monetization. The original C++ source is preserved unchanged.

## Game workflow

`/` explains the rules and accepts a name and starting credits. `/play` provides a copper/charcoal numbered table: enter a stake, choose 1–10, and play. The authenticated server draws only after validating the play and returns the committed balance, win/loss reveal, and latest 20 rounds newest first. Loading and field errors are accessible; stop, depleted-session feedback, reload recovery, and linked restart preserve the session workflow. Draws and balances are never simulated in the browser.

### Preserved original rules

- Guess a number from 1–10; draw randomly on the server.
- Minimum stake: 100 credits; never more than the current balance.
- A win **adds stake × 10** to the current balance. The stake is **not deducted first**.
- A loss subtracts the stake.
- Stop on request or when the balance falls below 100.

Session creation accepts whole-number deposits from **1 to 1,000,000**. Deposits below 100 create a `depleted` session rather than inventing a new minimum-deposit rule. Names are trimmed, 1–40 characters, and reject control/invisible formatting characters. Unexpected fields and nonnumeric deposits are rejected. Balances are bounded at **1,000,000,000**. A play whose potential +10× win exceeds that limit is rejected before drawing, even if it could lose.

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
| `POST /api/v1/rounds` | Same Bearer header; JSON `{ "bet": 100, "guess": 7 }` | `201 {session}` with committed balance and newest round |
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

Status is `active`, `depleted`, or `stopped`. Retrieval and play never return a token or token hash. Creation returns a random 32-byte base64url capability exactly once. Each completed round has `{id, bet, guess, draw, delta, balance}`; `rounds` returns at most 20, newest first. A win has `delta = bet * 10`, a loss `delta = -bet`, and `balance` is the committed post-round balance.

Round commands accept only whole-number `bet >= 100` and `guess` from 1–10, with no extra fields. Overbalance stakes, potential win overflow, and invalid input return `400 {error, fields}` where applicable. Stopped/depleted sessions or balances below 100 return `409 {error}` without drawing or mutation. Missing, malformed, and unknown capabilities return `401 {error}`. Malformed JSON returns 400; JSON over **8 KB** returns 413; unknown routes return `404 {error}`. Unexpected internal errors use a sanitized 500 response without SQL details.

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

SQLite `sessions` includes ID, capability hash, name, balance, status and creation time. The `rounds` table has an ordered sequence, public round ID, owning session foreign key with cascade delete, integer bet/guess/draw/delta/balance constraints and creation time. Session reads return the latest **20** completed rounds newest first while all completed records remain durable. Each play uses a real SQLite **immediate transaction**: authenticate and validate current state under the write lock, draw, insert the round, update balance/status, and return committed public state. Any failure rolls back the entire operation.

Runtime draws use Node's cryptographic `randomInt(1, 11)`. Deterministic draws are accepted only through the `RoundService` constructor for unit/API tests, never environment settings or request fields. A network/500/conflict failure during play blocks blind replay and offers **Refresh saved state**; the command may already have committed. Refresh is a read, not an automatic retry. Stop remains idempotent.

### Shared implementation interfaces

- `SessionRepository` owns the connection and prepared schema; `SessionService` supplies capability authorization, creation, retrieval and stop.
- `RoundService(sessions, draw?)` owns `play(token, input)` and preserved arithmetic; `roundRouter` exposes that command.
- `createApp(service, {corsOrigin}, rounds?)` mounts session and round routers on one Express application. The optional authority injection is for tests; runtime uses the secure default.
- `frontend/src/session/api.js` supplies `request`, `TOKEN_KEY`, `startSession`, `recoverSession`, and `stopSession`. Authenticated round requests pass the tab's stored token through this same transport.
- `frontend/src/App.jsx` owns the single `BrowserRouter` and shared session state. `/play` renders `Game` with that root-owned state; navigating to setup and back retains committed data.

## Tests and build verification

Unit/API, component and build commands:

```sh
# backend/
node node_modules/vitest/vitest.mjs run tests/round.test.ts
node node_modules/vitest/vitest.mjs run tests/session.test.ts
node node_modules/typescript/bin/tsc
# frontend/
node node_modules/vitest/vitest.mjs run src/round/Game.test.jsx src/session/Welcome.test.jsx
node node_modules/vite/bin/vite.js build
```

Round verification: **138 backend unit/API tests**, **38 game component tests**, **26 session component tests** (64/64 combined in the latest frontend `npm test` run), and both builds passed. Backend tests use distinct temporary **file-backed** SQLite databases, close/reopen them, and remove the files afterward. Round coverage includes exact win/loss arithmetic, boundaries, each invalid field, unknown/invalid capabilities, isolation, overflow before RNG, stopped/depleted rejection, write locking, real schema constraints, cascading deletion, insertion/update/draw rollback, sanitized HTTP errors, history limits, and persisted state requery. Component tests cover selection, keyboard play, results/history, validation, pending/duplicate submission, failures, refresh without blind replay, stop/depletion/restart, and shared root state. Network stubs are confined to component tests; SQLite is never mocked.

The combined backend feature suite passes **225/225** tests (87 session and 138 round). The obsolete session-only absent-round assertion was updated to verify the mounted route's sanitized error on a closed database; unknown routes still explicitly assert 404. `npm test` runs both feature suites in backend and all component suites in frontend. Cross-feature persistence, isolation, depletion, stop/recovery and rollback tests are in `backend/tests/integration.test.ts`; run `npm run test:integration` in backend. Cross-feature integration verification passed 5/5 tests against real temporary SQLite files, including reopen and integrity checks.

### E2E and preflight (parent verification only)

**Both E2E specs executed successfully: 8/8 tests across desktop and mobile Chromium.** The read-only test critic passed in round 2 with score 1.0000 and zero high-severity failures. Build both tiers using the commands above, then run from `frontend/`:

```sh
node node_modules/@playwright/test/cli.js install chromium
node node_modules/@playwright/test/cli.js test e2e/session.spec.js e2e/round.spec.js
```

The tier-local Playwright config launches compiled backend `node dist/index.js` on **3100** with `sqlite:./data/e2e-session.db`, and Vite preview independently on **4173**, proxying `/api` to 3100. It refuses to reuse an existing server. Both builds must already exist. E2E records persist in that dedicated database; delete it only when neither process is running if a clean fixture is needed.

Desktop Chromium and mobile Chromium projects cover link-driven navigation, missing-session entry, individual input validation, real session creation, actual HTTP draws and payout/balance rendering, empty and newest-first history, reload recovery, stop, restart, depletion, idempotence and invalid-capability recovery. Round sessions start through the UI; no API-created fixture or fake result replaces that journey. Loading checks temporarily hold an outgoing API request then continue it unchanged to the real backend; no response is fabricated. Every journey captures and asserts console/page errors; the explicit invalid-token session case permits only Chromium's expected HTTP-401 resource diagnostic. Both specs include full-page screenshots, ARIA snapshots, rendered HTML and computed typography/viewport captures. Round captures cover empty, invalid, loading, result/history, stopped and depleted states in each project. The completed run generated 24 screenshots in `frontend/test-results/`. Playwright text-based inspection confirmed the heading/landmark hierarchy, Fraunces/DM Sans font pairing, two-column desktop and single-column mobile table, 48px mobile number targets and no horizontal overflow. Images are evidence for human review, not a claimed product-owner visual approval.

Integration, E2E, critic review and Compose build/runtime checks passed. Both direct and nginx-proxied `/api/health` returned `{"status":"ok"}`; `/play` returned HTTP 200. Initial browser runs were blocked by a missing Chromium binary and OS libraries; installing them resolved the issue without changing assertions. The initial Docker build timed out on Debian HTTP package repositories; using the full Node build image with its preinstalled native toolchain resolved it while retaining a slim runtime.

## Docker deployment

The backend build uses **node:22-bookworm** with the preinstalled native SQLite build toolchain; the runtime uses **node:22-bookworm-slim**, runs as `node`, and starts compiled output. The frontend build also uses **node:22-bookworm-slim**, then nginx serves `dist` with history fallback (`/play` reload resolves to `index.html`) and proxies `/api/` to **backend:3000**. Neither container uses localhost to reach the other.

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

If ports are busy, choose new env values rather than silently accepting another port. If SQLite installation fails, check Node compatibility and the native toolchain. If recovery fails after a server restart, verify `DATABASE_URL`, working directory, volume retention and tab storage before creating a new session. The original console source remains unchanged. No migration of its process-local balances exists; web sessions use the new SQLite schema created automatically at startup. For rollback, revert the additive web commits; retain or back up the database volume.

## Known review items

The dependency audit reports 5 frontend advisories (3 moderate, 2 critical): dev-only Vitest/Tinypool issues and React Router advisories. Backend build dependencies report 6 advisories, while the pruned production backend reports 0. Do not expose Vitest/dev servers publicly or execute untrusted test code. Router navigation paths are fixed local routes, and this SPA does not use SSR hydration; nevertheless, a tested major-version dependency upgrade remains outstanding. Visual identity and browser-platform choices were inferred from a PRD-only brief because no human was reachable; product-owner visual acceptance remains pending. This is a fictional-credit demonstration, not a real-money gambling service.
