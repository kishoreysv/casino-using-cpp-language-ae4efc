# Changelog

## Tenfold web extension

### Added
- An attractive, responsive browser game in `frontend/`, using Vite/React JavaScript and a copper/charcoal table with Fraunces display typography and DM Sans text.
- Rules/session setup at `/` and playable table at `/play`: select 1–10, enter a stake, see the actual random reveal and newest 20 rounds, stop, restart, or recover after reload.
- Strict TypeScript Express service in `backend/` with session creation/current/stop and round endpoints under `/api/v1`, plus dependency-free `/api/health`.
- Real file-backed SQLite sessions and completed rounds, prepared statements, constraints, foreign keys and atomic immediate transactions. Session capabilities are random, hashed on disk, and stored only in the browser tab.
- Per-tier env examples, independent build/run scripts, Dockerfiles and root Compose with a persistent SQLite volume and nginx API proxy/history fallback.
- 225 backend feature unit/API tests, 64 frontend component/transport tests, 5 cross-feature integration tests and 8 desktop/mobile browser checks. Screenshot evidence and updated code graph accompany the handoff.

### Repository relationship and modified files
The adopted `main (1).cpp` remains unchanged. Its rules are the authority: minimum stake 100; guess 1–10; a winning balance adds ten times the stake WITHOUT first deducting it; a loss subtracts the stake; stop or balance below 100 ends play. This is an additive web extension in the same repository, not an unrelated game.

Shared files added/extended include `.gitignore`, `README.md`, `docker-compose.yml`, tier manifests/configuration, `backend/src/app.ts`, `frontend/src/App.jsx`, global styles, session transport and feature test suites. `frontend/src/session/useSessionCommands.js` fixes replay-safety loss on route changes and rejects late responses from obsolete sessions. Default test scripts cover both features rather than only setup.

### Reliability and boundaries
Cryptographic server draws replace repeated console `srand` seeding in the browser workflow; no advance draw is returned. Inputs reject invalid types, unknown fields, overbalance stakes and potential balance overflow. Authenticated session failures are sanitized. An uncertain round requires saved-state reconciliation rather than automatic replay. Accessibility includes labeled fields, native keyboard controls, live feedback, reduced motion and mobile number targets.

### Migration / deployment / rollback
No original CLI data migration or breaking CLI change. SQLite schema is installed idempotently on startup; configure `DATABASE_URL=sqlite:./data/tenfold.db` and preserve the Compose `tenfold-data` volume. Closing a tab loses its capability; there is no account-based recovery. Back up the database before deleting volumes. Backend build uses `node:22-bookworm` for native SQLite tooling and a slim runtime; frontend uses nginx. Revert the additive web commits to return to console-only behavior, retaining database backups as desired.

### Verified and remaining review
Builds, real SQLite persistence, integration and browser journeys passed; Compose services started healthy, API proxy and `/play` deep link returned 200. Read-only critic round 2 passed at 1.0 with zero high failures. Initial missing-browser/library and Docker apt-network failures were resolved, not waived.

Dependency remediation remains outstanding: frontend audit reports 5 advisories (3 moderate/2 critical), including dev-only Vitest/Tinypool and React Router; backend dev-inclusive build reports 6, pruned production backend 0. Major upgrades were not forced without compatibility testing. Do not expose dev/test servers publicly. Product-owner visual acceptance remains pending in this unattended run. All credits are fictional; no real money, payments, prizes, accounts, multiplayer or monetization was added.
