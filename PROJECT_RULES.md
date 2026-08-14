# CLAUDE.md — Multi-Tenant LLM API Gateway

This file is persistent project context for Claude Code / any agentic coding session. Read this in full before writing any code. Re-read relevant sections before starting a new phase.

---

## 1. What This Project Is

A production-style API Gateway that sits between client applications and LLM providers (Groq, Gemini). It is NOT a chatbot UI project — the gateway/infrastructure layer is the actual product being built. Every architectural decision should be made with "would this hold up in a system design interview" as the bar, not "does this make the demo work."

Full spec lives in `PRD.md` (place the PRD doc in repo root) — treat that as the source of truth for requirements. This file governs *how* to build it.

---

## 2. Tech Stack (do not substitute without asking)

- Language: **TypeScript** everywhere (gateway, worker, dashboard) — no plain JS files
- Backend framework: **Express.js**
- Database: **MongoDB** via Mongoose
- Cache/broker: **Redis** (ioredis client)
- Queue: **BullMQ**
- Frontend: **React + Vite**, **Tailwind** for styling, **recharts** for charts
- Auth: **JWT** (`jsonwebtoken`) for dashboard sessions, custom **API key** scheme for gateway traffic — these are two separate, non-interchangeable auth mechanisms. Never let one substitute for the other.
- Validation: **zod** for all request body/env var validation
- Testing: **Jest** + **supertest** for API tests, **k6** for load tests (k6 scripts are JS, not TS)
- Containerization: **Docker + docker-compose**
- Package manager: **npm** (not yarn/pnpm) — keep lockfiles consistent

---

## 3. Repository Structure

Follow the structure in `FOLDER_STRUCTURE.md` exactly. Key rules:
- `gateway/`, `worker/`, and `dashboard/` are **separate services** with their own `package.json` and `Dockerfile` — never merge worker logic into the gateway's process, they must be independently scalable and independently containerized.
- Shared TypeScript types (API request/response contracts) live in `shared/types/` and must be imported by both gateway and dashboard — never duplicate a type definition in two places.
- The rate-limiting Lua script lives at `gateway/src/lua/slidingWindowRateLimit.lua` as its own file, not inlined as a string in a `.ts` file — this file should be directly readable/reviewable.

---

## 4. Non-Negotiable Architectural Rules

These exist because they're the exact details that get probed in interviews. If you (the agent) are about to implement something that violates one of these, stop and flag it instead of proceeding.

1. **No shared state in process memory.** Rate limit counters, cache, circuit breaker state — all of it lives in Redis, never in a JS variable/Map in the gateway process. The whole point of this project is correctness under horizontal scaling (multiple gateway instances behind Nginx). In-memory state breaks that silently.

2. **Rate limiter must be atomic under concurrency.** Do NOT implement rate limiting as separate `GET` (check count) then `SET`/`INCR` (increment) calls — that's a race condition where concurrent requests can both pass the check before either increments. Use a **Lua script executed via `EVAL`** (preferred, single atomic op) or a Redis `MULTI` transaction. This is Phase 3 and is the single most important piece of this codebase. If asked to implement rate limiting and the first instinct is separate check-then-increment calls, use the Lua script approach instead without being asked twice.

3. **Never store raw API keys or passwords.** Passwords: bcrypt hash. API keys: generate with `crypto.randomBytes`, store only a bcrypt or SHA256 hash in MongoDB, show the raw key to the user exactly once at creation time.

4. **Circuit breaker state machine has exactly 3 states**: `closed` (normal) → `open` (failing, short-circuit immediately) → `half-open` (cooldown elapsed, allow 1 trial request) → back to `closed` on success or `open` on failure. Don't simplify this to a binary up/down flag.

5. **Cache keys must include the model name**, not just the prompt — `sha256(prompt + model)`, since the same prompt against different models is not a valid cache hit.

6. **Every middleware in the request chain (auth → rate limit → cache → circuit breaker → upstream call) must be independently unit-testable.** Don't write one giant handler function that does all five things inline — this defeats the purpose of demonstrating clean separation of concerns.

7. **Async logging only.** Writing `UsageLog` entries to MongoDB must never block the response being sent to the client. Fire-and-forget or push to a lightweight internal queue.

---

## 5. Build Order — Follow the Phases, Do Not Skip Ahead

Work strictly phase by phase as defined in `PRD.md` Section 8. Each phase should:
1. Be implemented completely
2. Be manually verified against its stated verification step before moving on
3. Be committed with a clear message referencing the phase (e.g. `feat(phase-3): sliding window rate limiter with Lua script`)

**Do not implement Phase 6 (upstream integration) logic inside Phase 3 (rate limiter), even if it seems convenient.** Each phase should be reviewable in isolation — this matters both for you staying on track across sessions and because the git history itself becomes a portfolio artifact (a reviewer can see the system built up in a logical, professional sequence).

If a session starts mid-project, first check which phase was last completed (check recent commits / ask the user) before writing new code.

---

## 6. Environment Variables

All env vars must be declared in `.env.example` with comments, validated at startup via a zod schema in `gateway/src/config/env.ts` — fail fast and loud if a required var is missing, don't let the app start in a half-configured state.

Expected vars (add to `.env.example`, never commit real `.env`):
```
NODE_ENV=
PORT=
MONGO_URI=
REDIS_URL=
JWT_SECRET=
GROQ_API_KEY=
GEMINI_API_KEY=
RATE_LIMIT_DEFAULT_MAX=
RATE_LIMIT_WINDOW_SECONDS=
CACHE_TTL_SECONDS=
CIRCUIT_BREAKER_FAILURE_THRESHOLD=
CIRCUIT_BREAKER_COOLDOWN_SECONDS=
```

---

## 7. Coding Conventions

- Strict TypeScript: `strict: true` in `tsconfig.json`, no `any` unless genuinely unavoidable (and comment why if used)
- All Express route handlers typed with request/response generics from `shared/types/`
- Errors: use a centralized `errorHandler.middleware.ts`, don't `try/catch` + inline `res.status().json()` scattered everywhere
- All Redis key names as named constants/functions in one place (e.g. `keys.ts`: `rateLimitKey(tenantId)`, `cacheKey(hash)`) — never string-template Redis keys inline in multiple files, this causes silent bugs when a key format changes
- File naming: `*.middleware.ts`, `*.service.ts`, `*.controller.ts`, `*.routes.ts`, `*.model.ts` — keep these suffixes consistent, they're how the folder structure stays scannable
- Write JSDoc comments on any function implementing something non-obvious (the Lua script logic, circuit breaker transitions) — a hiring manager reading this code should understand the *why* without needing to ask you

---

## 8. Testing Expectations

- Every middleware needs a Jest test file
- The rate limiter test MUST fire genuinely concurrent requests (`Promise.all([...])` against the same tenant) — a test that awaits requests sequentially in a loop does not prove atomicity and defeats the purpose of the test
- The circuit breaker test should mock the upstream call to force failures and assert state transitions
- Don't aim for 100% coverage on trivial code (simple CRUD routes); prioritize coverage on Phases 3, 4, 5 (rate limiter, cache, circuit breaker) — that's where the actual engineering claims live

---

## 9. What NOT to Do

- Don't add authentication providers, OAuth, or social login — out of scope, adds surface area with no interview value for this project
- Don't build a chat UI beyond the minimum needed to demo the gateway working — time is better spent on Phase 10 (load testing) than on chat UX polish
- Don't use an ORM abstraction that hides what Redis commands are actually running — direct `ioredis` calls (or a thin wrapper you write yourself) so the code stays explainable
- Don't silently swallow errors from upstream provider calls — they must be visible in logs and correctly trip the circuit breaker
- Don't add Kubernetes/Helm — Docker + docker-compose + single EC2 instance is the target deployment; K8s is out of scope and would be a distraction from the core rate-limiter/cache/circuit-breaker story

---

## 10. Commands Reference

```bash
# Local dev (all services)
docker-compose up

# Run gateway only (with hot reload)
cd gateway && npm run dev

# Run tests
cd gateway && npm test

# Run a specific test file
cd gateway && npm test -- rateLimiter.test.ts

# Load test (requires k6 installed locally)
k6 run scripts/k6/rateLimitTest.js

# Scale workers
docker-compose up --scale worker=5
```

---

## 11. Definition of Done (per phase)

Before marking any phase complete, confirm:
- [ ] Code matches the architectural rules in Section 4
- [ ] Manual verification step from `PRD.md` Section 8 passes
- [ ] Relevant Jest tests written and passing
- [ ] No secrets committed, `.env.example` updated if new vars added
- [ ] Commit message references the phase number
