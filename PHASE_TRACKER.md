# PHASE_TRACKER.md — Build Progress

**Instructions:** Update this file every time you finish a phase — check the box, fill in the date, note any deviation from the plan. At the start of every new Copilot Chat session, paste the "Current Status" block below into the chat first, so Copilot knows exactly where the project stands (it won't infer this automatically the way Claude Code might).

---

## Current Status

```
Project: Multi-Tenant LLM API Gateway
Currently on: Phase [X] — [phase name]
Last completed phase: Phase [X-1] — [phase name]
Branch: [branch name]
Notes for this session: [anything specific you want Copilot to focus on / be careful about]
```

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

- [ ] Cache key = `sha256(prompt + model)`
- [ ] Cache middleware checks Redis before upstream call, stores with 1hr TTL
- [ ] Verified: repeated identical prompt → near-instant response, `cacheHit: true` logged
- [ ] Committed: `feat(phase-4): response caching middleware`
- **Date completed:** \***\*\_\_\_\*\***
- **Notes:** \***\*\_\_\_\*\***

### Phase 5 — Circuit Breaker

- [ ] 3-state machine implemented (closed / open / half-open), state stored in Redis
- [ ] Configurable failure threshold + cooldown
- [ ] Verified: mocked upstream failures → circuit opens after threshold → requests short-circuit with 503 → half-open retry after cooldown → closes on success
- [ ] Committed: `feat(phase-5): circuit breaker for upstream calls`
- **Date completed:** \***\*\_\_\_\*\***
- **Notes:** \***\*\_\_\_\*\***

### Phase 6 — Upstream Integration

- [ ] Groq service implemented
- [ ] Gemini service implemented (fallback provider)
- [ ] `/v1/chat/completions` wired through full middleware chain (auth → rate limit → cache → circuit breaker → upstream)
- [ ] Verified: real end-to-end call with actual API keys
- [ ] Committed: `feat(phase-6): upstream LLM provider integration`
- **Date completed:** \***\*\_\_\_\*\***
- **Notes:** \***\*\_\_\_\*\***

### Phase 7 — Async Queue Path (optional stretch)

- [ ] BullMQ producer added (`?async=true` → returns `jobId`)
- [ ] Worker process consumes queue, runs same middleware logic
- [ ] `GET /v1/jobs/:jobId` implemented
- [ ] Verified: 50 async jobs submitted at once, no duplicate processing
- [ ] Committed: `feat(phase-7): async job queue with BullMQ`
- **Date completed:** \***\*\_\_\_\*\***
- **Notes:** \***\*\_\_\_\*\***

### Phase 8 — Dashboard

- [ ] Signup/login pages
- [ ] API key display + rotate button
- [ ] Usage chart (requests over time, cache-hit rate) via recharts
- [ ] Rate-limit/plan display
- [ ] Verified: manual click-through of every flow
- [ ] Committed: `feat(phase-8): React dashboard`
- **Date completed:** \***\*\_\_\_\*\***
- **Notes:** \***\*\_\_\_\*\***

### Phase 9 — Load Balancing + Multi-Instance Deploy (manual)

- [ ] Nginx round-robin config across 3 gateway instances
- [ ] `docker-compose up --scale gateway=3` (or 3 named services) working
- [ ] Verified: kill one instance mid-load-test, confirm Nginx routes around it, rate limits stay globally consistent
- **Date completed:** \***\*\_\_\_\*\***
- **Notes:** \***\*\_\_\_\*\***

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
