llm-api-gateway/
│
├── .github/
│   └── copilot-instructions.md      # Copilot's auto-loaded project context (was CLAUDE.md)
│
├── PRD.md                            # full product/architecture spec
├── FOLDER_STRUCTURE.md               # this document, for reference while building
├── PHASE_TRACKER.md                  # checklist — mark phases done as you go, paste status into Copilot chat each session
│
├── docker-compose.yml
├── docker-compose.prod.yml           # EC2-specific overrides
├── .env.example
├── .gitignore
├── README.md                         # Phase 12 — architecture, load test results, "why" section
│
├── docker/
│   ├── gateway.Dockerfile
│   ├── worker.Dockerfile
│   ├── dashboard.Dockerfile
│   └── nginx/
│       └── nginx.conf                # Phase 9 — round-robin LB config
│
├── gateway/                           # Phases 1–7
│   ├── package.json
│   ├── tsconfig.json
│   ├── .eslintrc.json
│   └── src/
│       ├── index.ts                   # Express app entrypoint
│       ├── config/
│       │   ├── env.ts                 # env var validation (zod)
│       │   ├── redis.ts               # Redis client singleton
│       │   └── mongo.ts               # Mongoose connection
│       │
│       ├── models/
│       │   ├── Tenant.model.ts
│       │   └── UsageLog.model.ts
│       │
│       ├── middleware/
│       │   ├── auth.middleware.ts         # Phase 2 — API key auth, Redis cache-aside
│       │   ├── jwtAuth.middleware.ts      # Phase 1 — dashboard JWT auth
│       │   ├── rateLimiter.middleware.ts  # Phase 3 — sliding window, Lua script
│       │   ├── cache.middleware.ts        # Phase 4 — response caching
│       │   ├── circuitBreaker.middleware.ts # Phase 5
│       │   └── errorHandler.middleware.ts
│       │
│       ├── routes/
│       │   ├── auth.routes.ts         # /auth/signup, /auth/login, /auth/api-key/rotate
│       │   ├── chat.routes.ts         # /v1/chat/completions
│       │   ├── jobs.routes.ts         # /v1/jobs/:jobId (Phase 7)
│       │   ├── dashboard.routes.ts    # /dashboard/usage, /dashboard/limits
│       │   ├── admin.routes.ts        # /admin/circuit-status, /admin/tenants
│       │   └── health.routes.ts       # /v1/health
│       │
│       ├── controllers/
│       │   ├── auth.controller.ts
│       │   ├── chat.controller.ts
│       │   ├── jobs.controller.ts
│       │   ├── dashboard.controller.ts
│       │   └── admin.controller.ts
│       │
│       ├── services/
│       │   ├── upstream/
│       │   │   ├── groq.service.ts        # Phase 6
│       │   │   ├── gemini.service.ts      # Phase 6
│       │   │   └── upstream.interface.ts  # shared provider contract
│       │   ├── cache.service.ts           # hash prompt, get/set Redis
│       │   ├── rateLimit.service.ts       # core Lua-script logic, reused by middleware
│       │   ├── circuitBreaker.service.ts  # state machine logic
│       │   ├── apiKey.service.ts          # generate/hash/rotate keys
│       │   └── queue.service.ts           # Phase 7 — BullMQ producer
│       │
│       ├── lua/
│       │   └── slidingWindowRateLimit.lua    # atomic rate-limit script (Phase 3)
│       │
│       ├── types/
│       │   ├── tenant.types.ts
│       │   ├── request.types.ts           # extends Express Request with tenant info
│       │   └── provider.types.ts
│       │
│       └── utils/
│           ├── logger.ts
│           ├── hash.ts                    # SHA256 for cache keys, bcrypt wrappers
│           └── keys.ts                    # centralized Redis key-name generators
│
├── worker/                            # Phase 7 — separate process, separate container
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                   # worker loop entrypoint
│       ├── processors/
│       │   └── chatJob.processor.ts   # reuses gateway's cache/circuitBreaker services
│       └── config/
│           ├── redis.ts
│           └── mongo.ts
│
├── dashboard/                         # Phase 8
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/
│       │   └── client.ts              # axios instance with JWT interceptor
│       ├── pages/
│       │   ├── SignupPage.tsx
│       │   ├── LoginPage.tsx
│       │   ├── DashboardPage.tsx      # usage charts, cache-hit rate
│       │   └── ApiKeyPage.tsx         # view/rotate key
│       ├── components/
│       │   ├── UsageChart.tsx         # recharts
│       │   ├── RateLimitCard.tsx
│       │   └── Navbar.tsx
│       ├── hooks/
│       │   └── useAuth.ts
│       └── types/
│           └── dashboard.types.ts
│
├── shared/                            # types shared between gateway/worker/dashboard
│   └── types/
│       └── api-contracts.ts           # request/response shapes, single source of truth
│
├── scripts/
│   ├── k6/
│   │   ├── rateLimitTest.js           # Phase 10 — concurrency proof
│   │   ├── cacheHitTest.js
│   │   └── circuitBreakerTest.js
│   └── seed/
│       └── seedTenant.ts              # create a test tenant + API key quickly
│
└── tests/
    ├── gateway/
    │   ├── rateLimiter.test.ts        # Phase 3 verification — concurrent hits
    │   ├── auth.test.ts
    │   ├── cache.test.ts
    │   └── circuitBreaker.test.ts
    └── integration/
        └── endToEnd.test.ts