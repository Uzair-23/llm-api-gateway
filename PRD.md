# PRD: Multi-Tenant LLM API Gateway
**Version 1.0 | Owner: Uzair | Target: SDE/Backend/Full-Stack Interview Portfolio**

---

## 1. Problem Statement & Goal

Companies building on top of LLM providers (Groq, Gemini, OpenAI) need a layer between their app and the raw provider API to control cost, prevent abuse, and stay resilient when a provider degrades. This project builds that layer — a production-style **API Gateway** purpose-built for LLM traffic.

**Goal:** Build a system that demonstrates real backend engineering depth — not a CRUD wrapper around an AI API — with measurable proof (load test numbers, dashboards, failure-mode demos) that a hiring manager can verify in 5 minutes on GitHub.

**Non-goals:** This is not a chat UI project. The chat UI is a thin demo client. The gateway itself is the product.

---

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (Node.js) | Type safety across API contracts |
| Framework | Express.js | Middleware-first, matches gateway pattern |
| Database | MongoDB | Tenant/usage records |
| Cache/Broker | Redis | Rate limiting, caching, circuit breaker state, job queue |
| Queue | BullMQ (Redis-backed) | Burst request handling |
| Reverse Proxy/LB | Nginx | Round-robin across gateway instances |
| Auth | JWT (dashboard) + API Keys (gateway traffic) | Two distinct trust boundaries |
| Containerization | Docker + docker-compose | Multi-service orchestration |
| Deployment | AWS EC2 (free tier) | Real cloud deployment |
| Load testing | k6 (free, OSS) | Proof-of-scale artifact |
| Upstream LLMs | Groq API, Gemini API (free tiers) | Real upstream dependency |

---

## 3. System Architecture

```
                              ┌─────────────────────┐
                              │   React Dashboard    │
                              │ (signup, API keys,   │
                              │  usage analytics)     │
                              └──────────┬───────────┘
                                         │ JWT auth
                                         ▼
┌────────────┐        ┌──────────────────────────────────┐
│   Client    │        │            Nginx (LB)             │
│  Apps using │───────▶│    round-robin across instances    │
│  API Keys   │        └───────┬───────────┬────────────┘
└────────────┘                │           │
                     ┌─────────▼───┐ ┌─────▼───────┐
                     │ Gateway #1   │ │ Gateway #2   │   ...N instances
                     │ (Express+TS) │ │ (Express+TS) │
                     └───────┬──────┘ └──────┬───────┘
                             │                │
              ┌──────────────┼────────────────┼──────────────┐
              ▼              ▼                ▼              ▼
         ┌─────────┐   ┌──────────┐    ┌─────────────┐  ┌──────────┐
         │  Redis   │   │ MongoDB  │    │  BullMQ      │  │ Upstream  │
         │ (shared) │   │(tenants, │    │  Queue +     │  │  LLM APIs │
         │ rate     │   │ usage    │    │  Workers     │  │(Groq/Gem) │
         │ limits,  │   │ logs)    │    │              │  │           │
         │ cache,   │   └──────────┘    └─────────────┘  └──────────┘
         │ circuit  │
         │ breaker  │
         └─────────┘
```

**Key architectural decision:** All shared state (rate-limit counters, cache, circuit-breaker flags) lives in **centralized Redis**, never in gateway process memory. This is what makes horizontal scaling correct instead of just "technically running multiple copies."

---

## 4. Data Models

```typescript
// MongoDB
interface Tenant {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  apiKeyHash: string;          // never store raw key
  apiKeyPrefix: string;        // e.g. "sk-live-ab12" for display in dashboard
  planTier: "free" | "pro";
  rateLimitPerMin: number;
  createdAt: Date;
}

interface UsageLog {
  _id: ObjectId;
  tenantId: ObjectId;
  timestamp: Date;
  endpoint: string;
  provider: "groq" | "gemini";
  cacheHit: boolean;
  tokensUsed: number;
  latencyMs: number;
  statusCode: number;
}

// Redis key patterns
ratelimit:{tenantId}          -> sorted set, score = request timestamp
cache:{sha256(prompt+model)}  -> string, TTL 3600s
circuit:{provider}            -> hash { failures, state, lastFailureTs }
tenant:{apiKeyHash}            -> cached tenant lookup, TTL 300s
queue:llm-jobs                 -> BullMQ managed
```

---

## 5. API Endpoints

### Dashboard API (JWT-authenticated, human users)

| Method | Endpoint | Description |
|---|---|---|
| POST | `/auth/signup` | Create account, returns JWT |
| POST | `/auth/login` | Login, returns JWT |
| POST | `/auth/api-key/rotate` | Generate new API key, invalidate old |
| GET | `/dashboard/usage` | Usage stats: requests, cache-hit rate, cost estimate |
| GET | `/dashboard/limits` | Current plan, rate limit, remaining quota |

### Gateway API (API-key authenticated, machine-to-machine)

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/chat/completions` | Main proxy endpoint → routes to Groq/Gemini |
| GET | `/v1/jobs/:jobId` | Poll status of a queued async request |
| GET | `/v1/health` | Public health check (used by Nginx/LB) |

### Admin/Internal (for your own monitoring, JWT + admin role)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/admin/circuit-status` | View current circuit breaker states per provider |
| POST | `/admin/circuit/reset` | Manually reset a tripped circuit |
| GET | `/admin/tenants` | List all tenants (admin only) |

---

## 6. Complete Request Flow — `POST /v1/chat/completions`

1. **Nginx** receives request, round-robins to a gateway instance.
2. **Auth middleware**: extract `Authorization: Bearer sk-live-xxx`. Hash it, check `tenant:{apiKeyHash}` in Redis first (cache-aside). Miss → query MongoDB, populate Redis cache (TTL 5 min). Invalid → `401`.
3. **Rate limiter middleware**: sliding-window check against `ratelimit:{tenantId}` using Redis sorted set (`ZADD`, `ZREMRANGEBYSCORE`, `ZCARD`). Over limit → `429` + `Retry-After` header.
4. **Cache check**: hash `{prompt, model}` → check `cache:{hash}`. Hit → return cached response immediately, log `cacheHit: true`, respond in <10ms.
5. **Circuit breaker check**: read `circuit:{provider}`. If `state === "open"` and cooldown not elapsed → return `503` immediately without calling upstream.
6. **Upstream call**: forward request to Groq/Gemini with a timeout (e.g. 10s).
   - Success → reset circuit failure count, cache response, log usage, return to client.
   - Failure → increment `circuit:{provider}.failures`. If failures ≥ threshold (e.g. 5 in 30s) → flip `state = "open"`.
7. **Async path (optional, burst handling)**: if request has `?async=true` or global load is high, push to BullMQ instead of processing inline. Return `{ jobId }` immediately. A worker process picks it up, runs steps 4–6, stores result in Redis keyed by `jobId`, client polls `/v1/jobs/:jobId`.
8. **Usage logging**: async write to MongoDB `UsageLog` (don't block the response on this).

---

## 7. Non-Functional Requirements (be explicit — this is what you'll get grilled on)

- **Rate limiting algorithm**: sliding-window log (Redis sorted sets), not fixed-window — must justify why in interview (fixed window allows 2x burst at boundary).
- **Cache TTL**: 1 hour default, configurable per tenant.
- **Circuit breaker thresholds**: open after 5 failures in 30s window; half-open retry after 60s cooldown; close after 2 consecutive successes.
- **Horizontal scaling target**: correctness must hold with 3+ gateway instances — no in-memory state anywhere in request path.
- **Load test target**: 500 concurrent requests, p99 latency < 300ms for cache hits, zero rate-limit inconsistency across instances.

---

## 8. Step-by-Step Implementation Plan (structured for agentic coding tools)

**Why phased like this:** Agentic tools (Claude Code, Copilot) perform best with narrow, independently testable units of work. Feed one phase at a time, verify it works, commit, then move to the next phase. Don't ask it to "build the whole gateway" in one prompt — you'll get an unverifiable pile of code.

### Phase 0 — Scaffolding (do this manually, not with agent)
- Init monorepo: `/gateway`, `/dashboard`, `/worker`, `/docker`
- TypeScript config, ESLint, `.env.example`
- `docker-compose.yml` skeleton with Redis + MongoDB services only (no app yet)
- **Verify:** `docker-compose up` brings up Redis + Mongo, you can connect via CLI.

### Phase 1 — Tenant auth (agent task, single prompt)
- Prompt the agent: "Implement `/auth/signup` and `/auth/login` in Express+TS. Use bcrypt for password hashing, JWT for session tokens, Mongoose schema for Tenant. Include input validation with zod."
- **Verify:** Postman/curl test — signup, login, get JWT, hit a protected dummy route.
- Commit.

### Phase 2 — API key issuance + auth middleware (agent task)
- Prompt: "Add API key generation on signup (format `sk-live-{32 random hex}`), store bcrypt hash only. Build Express middleware that authenticates gateway requests via API key, with Redis cache-aside lookup (5 min TTL) falling back to MongoDB."
- **Verify:** Unit test the middleware directly — valid key passes, invalid key returns 401, second request within TTL doesn't hit MongoDB (log this to confirm).
- Commit.

### Phase 3 — Rate limiter (agent task, isolate this — it's your centerpiece)
- Prompt: "Implement a sliding-window rate limiter as Express middleware using Redis sorted sets. Function signature: `rateLimiter(maxRequests, windowSeconds)`. Must be atomic-safe under concurrent requests — use a Lua script or Redis transaction (MULTI) to avoid race conditions in the check-and-increment."
- **This is important**: ask the agent to explain *why* it chose Lua/MULTI — if it can't, push back and ask for the race-condition-safe version explicitly.
- **Verify:** write a small script that fires 200 concurrent requests against a limit of 100/min — confirm exactly 100 pass.
- Commit.

### Phase 4 — Response caching (agent task)
- Prompt: "Add caching middleware: hash `{prompt, model}` with SHA256, check Redis before calling upstream, store successful responses with 1-hour TTL."
- **Verify:** same prompt twice → second call should be near-instant, log `cacheHit: true`.
- Commit.

### Phase 5 — Circuit breaker (agent task)
- Prompt: "Implement a circuit breaker wrapping upstream LLM calls, with state stored in Redis (not memory): closed/open/half-open, configurable failure threshold and cooldown."
- **Verify:** manually mock upstream to always fail, confirm circuit opens after threshold, confirm requests short-circuit with 503 without calling upstream once open.
- Commit.

### Phase 6 — Upstream integration (agent task)
- Prompt: "Wire the `/v1/chat/completions` endpoint to call Groq API (and Gemini as fallback provider), respecting the auth/rate-limit/cache/circuit-breaker middleware chain built in previous phases."
- **Verify:** real end-to-end call with your own Groq API key (free tier).
- Commit.

### Phase 7 — Async queue path (agent task, optional stretch)
- Prompt: "Add BullMQ integration: `/v1/chat/completions?async=true` pushes job to queue, returns jobId immediately. Separate worker process consumes queue, runs the same middleware logic, stores result in Redis keyed by jobId with 10 min TTL. Add `GET /v1/jobs/:jobId`."
- **Verify:** submit 50 async jobs at once, poll for completion, confirm no duplicate processing.
- Commit.

### Phase 8 — Dashboard (agent task, can be done in parallel by a second agent session)
- Prompt: "Build a React+TS dashboard: signup/login forms, API key display + rotate button, usage chart (requests over time, cache-hit rate) using recharts, current rate-limit/plan display."
- **Verify:** manually click through every flow.
- Commit.

### Phase 9 — Load balancing + multi-instance deploy (manual, not agent)
- Write Nginx config for round-robin across `gateway-1`, `gateway-2`, `gateway-3` in docker-compose.
- `docker-compose up --scale gateway=3` (if using a single service definition) or 3 named services.
- **Verify:** kill one instance mid-load-test, confirm Nginx routes around it and rate limits stay globally consistent (test by hammering one tenant's key and confirming the limit holds across which instance handles which request).

### Phase 10 — Load testing (manual — this generates your resume numbers)
- Write a k6 script: ramp to 500 concurrent virtual users hitting `/v1/chat/completions` with a mix of cached and uncached prompts.
- Record: requests/sec, p50/p95/p99 latency, error rate, cache-hit ratio.
- Save results as a screenshot/table in your README.

### Phase 11 — Deploy to EC2
- Provision t2.micro/t3.micro (free tier)
- Install Docker, docker-compose
- Clone repo, `.env` with real API keys, `docker-compose up -d`
- Configure security group: only 80/443 open, Redis/Mongo not publicly exposed
- Point a free domain (or just use the EC2 public IP) at it

### Phase 12 — Documentation (do this yourself, not the agent — this is your voice)
- README with: architecture diagram, the load-test numbers, a "what breaks without X" section (e.g. "without centralized Redis rate-limiting, horizontal scaling would let a tenant get 3x their quota by hitting different instances") — this section specifically is what signals depth to a reviewer skimming your GitHub.

---

## 9. What "Done" Looks Like (Definition of Done)

- [ ] All endpoints in Section 5 implemented and tested
- [ ] Rate limiter proven race-condition-safe under concurrent load (test script + results)
- [ ] Circuit breaker proven to trip and recover (demo script + results)
- [ ] Cache hit-rate visible on dashboard
- [ ] 3 gateway instances behind Nginx, correctness verified under load
- [ ] k6 load test results documented with actual numbers
- [ ] Deployed and reachable on EC2
- [ ] README tells the "why," not just the "what"

## 10. Resume Bullet (draft, edit with your real numbers once tested)

> Built a multi-tenant API gateway for LLM providers (Groq, Gemini) with Redis-backed sliding-window rate limiting, response caching, and circuit-breaker failover; horizontally scaled across 3 Dockerized instances behind Nginx with centralized state for cross-instance consistency; load-tested to 500 concurrent requests at p99 <Xms with zero rate-limit violations.
