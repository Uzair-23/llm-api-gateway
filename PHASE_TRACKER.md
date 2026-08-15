# PHASE_TRACKER.md — Build Progress

**Instructions:** Update this file every time you finish a phase — check the box, fill in the date, note any deviation from the plan. At the start of every new Copilot Chat session, paste the "Current Status" block below into the chat first, so Copilot knows exactly where the project stands (it won't infer this automatically the way Claude Code might).

---

## Current Status

```
Project: Multi-Tenant LLM API Gateway
Currently on: Phase 5 — Circuit Breaker
Last completed phase: Phase 4 — Response Caching
Branch: main
Notes for this session: Cache middleware is now in place behind rate limiting. Temporary /v1/test-completion route should be removed or replaced in Phase 6.
```

## Known Issues

- Temporary `/v1/test-completion` route exists only for Phase 4 caching verification. Remove or replace it with `/v1/chat/completions` when Phase 6 upstream integration is implemented.
- Temporary `/v1/test-circuit` route exists only for Phase 5 circuit-breaker verification. Remove or replace it with `/v1/chat/completions` circuit integration in Phase 6.

---

## Phase Checklist

### Phase 0 — Scaffolding (manual, no agent)

- [ ] Monorepo folders created (`gateway/`, `worker/`, `dashboard/`, `shared/`, `docker/`, `scripts/`, `tests/`)
- [ ] TypeScript config, ESLint set up in each service
- [ ] `.env.example` created
- [ ] `docker-compose.yml` skeleton with Redis + MongoDB only
- [ ] Verified: `docker-compose up` brings up Redis + Mongo, connectable via CLI
- **Date completed:** 05-08-2026
- **Notes:** completed

### Phase 1 — Tenant Auth

- [x] `/auth/signup` implemented (bcrypt password hash, Mongoose Tenant schema, zod validation)
- [x] `/auth/login` implemented (returns JWT)
- [x] Verified: signup → login → JWT → hit protected dummy route
- [ ] Committed: `feat(phase-1): tenant signup/login with JWT`
- **Date completed:** 05-08-2026
- **Notes:** Implemented with centralized error handling, reusable JWT utility, and Jest/supertest tests using mongodb-memory-server.

### Phase 2 — API Key Issuance + Auth Middleware

- [x] API key generation on signup (`sk-live-{32 hex}` format, SHA256 hash stored)
- [x] `auth.middleware.ts` — API key auth with Redis cache-aside (5 min TTL) → MongoDB fallback
- [x] Verified: valid key passes, invalid key → 401, repeated request within TTL doesn't hit MongoDB
- [x] Fixed: Redis client initialization bug — now called at startup, not lazily in middleware
- [x] Fixed: Test blind spot — authMiddleware.test.ts now requires live Redis, fails if missing
- [x] Committed: `feat(phase-2): API key auth middleware with Redis cache-aside`
- **Date completed:** 09-08-2026
- **Notes:** Migrated apiKeyHash from bcrypt to SHA256 (deterministic for cache-aside lookup). Found and fixed Redis lazy-initialization bug through manual curl/redis-cli verification + test suite validation.

### Phase 3 — Rate Limiter (centerpiece — extra scrutiny required)

- [x] Sliding-window rate limiter implemented via Redis sorted sets
- [x] **Confirmed atomic**: uses Lua script (`EVAL`/`EVALSHA`) — NOT separate check-then-increment calls
- [x] `slidingWindowRateLimit.lua` exists as its own file
- [x] Verified: 20 concurrent requests against limit of 10 → exactly 10 pass, 10 denied (concurrency test in rateLimiter.test.ts)
- [ ] Committed: `feat(phase-3): sliding window rate limiter with Lua script`
- **Date completed:** 12-08-2026
- **Notes:** Lua script at gateway/src/lua/slidingWindowRateLimit.lua uses ZREMRANGEBYSCORE + ZCARD + ZADD atomically via EVAL/EVALSHA with NOSCRIPT fallback. Factory function `rateLimiter(max, windowSeconds)` is reusable per-route. Fail-open on Redis error with [RATE-LIMITER-DEGRADED] log. Wired onto /v1/health/protected at 5 req/60s. Manual concurrency script at scripts/manual-tests/concurrentRateLimit.js (fires 200 against 100/min). Full suite: 4 suites, 26 tests, all passing.

### Phase 4 — Response Caching

- [x] Cache key = `sha256(prompt + model)`
- [x] Cache middleware checks Redis before upstream call, stores with 1hr TTL
- [x] Verified: repeated identical prompt → near-instant response, `cacheHit: true` logged
- [x] Verified: cache hit still counts against rate limit because middleware runs after rateLimiter
- [ ] Committed: `feat(phase-4): response caching middleware`
- **Date completed:** 12-08-2026
- **Notes:** Added temporary `/v1/test-completion` simulated-upstream route for Phase 4 verification. Cache key is shared across tenants and TTL is 3600s. Full suite: 5 suites, 33 tests, all passing. Remove or replace the temporary route when Phase 6 wires `/v1/chat/completions`.

### Phase 5 — Circuit Breaker

- [x] 3-state machine implemented (closed / open / half-open), state stored in Redis
- [x] Configurable failure threshold + cooldown
- [x] Verified: mocked upstream failures → circuit opens after threshold → requests short-circuit with 503 → half-open retry after cooldown → closes on success
- [ ] Committed: `feat(phase-5): circuit breaker for upstream calls`
- **Date completed:** 13-08-2026
- **Notes:** Added atomic Redis Lua script for CHECK/REPORT_SUCCESS/REPORT_FAILURE with per-provider state and half-open single-trial gating. Added temporary `/v1/test-circuit` + `/admin/circuit-status` + `/admin/circuit/reset` for Phase 5 verification. Added `tests/gateway/circuitBreaker.test.ts` including concurrency proof at the open→half-open boundary.

### Phase 6 — Upstream Integration (Groq + Gemini)

- [x] LLMProvider interface with 10s timeout enforcement
- [x] Groq service (primary provider)
- [x] Gemini service (fallback provider)
- [x] callWithFallback: auto-fallback on Groq circuit open or failure
- [x] Real /v1/chat/completions wired through full middleware chain
- [x] Independent per-provider circuit breaker state
- [x] Removed temporary /v1/test-completion route
- [x] Removed temporary /v1/test-circuit route
- [x] Tests fully mocked (jest.mock prevents real API calls)
- [x] Manually verified end-to-end with real Groq API
- [x] Cache hit verified on identical subsequent request (~10x speedup)
- [x] Admin circuit reset endpoint works
- [x] Committed: feat(phase-6): upstream LLM provider integration
- **Date completed:** 15-08-2026
- **Notes:** Real Groq API integration verified. Caching reduces typical 
  call from ~1-2s to ~200ms. Gemini fallback available. All 49 tests passing, 
  zero regressions.

### Phase 7 — Async Queue Path (optional stretch)

- [x] BullMQ producer added (`?async=true` → returns `jobId`)
- [x] Worker process consumes queue, runs same middleware logic
- [x] `GET /v1/jobs/:jobId` implemented
- [x] Verified: worker processes jobs, cache hits return immediately, results stored under `job:{jobId}:result`
- [x] Committed: `feat(phase-7): async job queue with BullMQ`
- **Date completed:** 15-08-2026
- **Notes:** Producer enqueues to 'llm-jobs' with 202 Accepted. Worker process consumes queue with concurrency 5, checks cache, runs Groq/Gemini callWithFallback with circuit breaker, and saves result at `job:{jobId}:result` with 10 min TTL. All gateway and worker tests passing.

### Phase 8 — Dashboard

- [x] Signup/login pages
- [x] API key display + rotate button
- [x] Usage chart (requests over time, cache-hit rate) via recharts
- [x] Rate-limit/plan display
- [x] Verified: manual click-through of every flow & production Vite build
- [x] Committed: `feat(phase-8): React dashboard`
- **Date completed:** 15-08-2026
- **Notes:** Built React 19 + Vite + Tailwind CSS v3 dashboard with signup/login, one-time API key display, API key rotation, recharts analytics (requests over time & provider distribution), rate limit quota bar, dev proxy to gateway :4000, and README documentation. Vite build verified clean.

### Phase 9 — Nginx Load Balancing & Multi-Instance Deployment ✅

- [x] Dockerized gateway service (multi-stage build, optimized production image)
- [x] docker-compose.yml: 3 gateway instances (gateway-1/2/3) + Nginx reverse proxy
- [x] Nginx upstream pool with round-robin load balancing
- [x] Automatic failover: max_fails=3, fail_timeout=10s per upstream server
- [x] Fixed: .lua script files missing from compiled Docker image (added copy step to build)
- [x] Verified: round-robin distribution (6 requests → perfect cycling gateway-2→3→1→2→3→1)
- [x] Verified: rate limit consistency (exactly 100/100 through Nginx across 3 instances)
- [x] Verified: automatic instance failover (killed gateway-2, all requests routed to 1/3, zero 502s)
- [x] Verified: centralized Redis state (single ratelimit key shared across instances)
- [x] Committed: feat(phase-9): Nginx load balancing across 3 gateway instances
- **Date completed:** 16-08-2026
- **Notes:** All 3 instances up simultaneously. Nginx detects dead instance within seconds 
  and routes around it. Rate limiting enforcement identical to Phase 3 single-instance 
  test despite traffic bouncing across 3 separate processes. Proves architecture's core 
  claim: centralized Redis state + stateless gateways = correct horizontal scaling.

### Phase 10 — Load Testing (manual — generates resume numbers)

- [ ] `rateLimitTest.js` k6 script written and run
- [ ] `cacheHitTest.js` k6 script written and run
- [ ] `circuitBreakerTest.js` k6 script written and run
- [ ] Results recorded: requests/sec, p50/p95/p99 latency, error rate, cache-hit ratio
- [ ] Results saved as screenshot/table for README
- **Date completed:** \***\*\_\_\_\*\***
- **Notes / actual numbers:** \***\*\_\_\_\*\***

### Phase 11 — Deploy to EC2

- [ ] EC2 instance provisioned (t2.micro/t3.micro free tier)
- [ ] Docker + docker-compose installed on instance
- [ ] Repo cloned, `.env` configured with real keys
- [ ] `docker-compose up -d` running
- [ ] Security group configured (only 80/443 open, Redis/Mongo not public)
- [ ] Reachable via public IP or domain
- **Date completed:** \***\*\_\_\_\*\***
- **Notes:** \***\*\_\_\_\*\***

### Phase 12 — Documentation (manual — do not delegate to agent)

- [ ] README written with architecture diagram
- [ ] Load test numbers included
- [ ] "What breaks without X" section written (rate limiter, circuit breaker, centralized Redis reasoning)
- [ ] Resume bullet finalized with real numbers
- **Date completed:** \***\*\_\_\_\*\***
- **Notes:** \***\*\_\_\_\*\***

---

## Deviations Log

Track anything you changed from the original PRD/plan and why — useful for your own memory and genuinely useful to mention in an interview ("I originally planned X but switched to Y because...").

| Date | Phase | What changed | Why |
| ---- | ----- | ------------ | --- |
|      |       |              |     |

---

## Known Issues / TODO Before "Done"

- [ ] ***
- [ ] ***
- [ ] ***
