-- Redis-backed circuit breaker state machine.
--
-- This script is intentionally verbose and heavily commented because the
-- circuit breaker is concurrency-sensitive and interview-critical.
--
-- KEYS[1] = circuit state hash key, e.g. "circuit:groq"
-- KEYS[2] = circuit failure-window sorted set key, e.g. "circuit:groq:failures"
--
-- ARGV[1] = now timestamp in milliseconds
-- ARGV[2] = action: CHECK | REPORT_SUCCESS | REPORT_FAILURE
-- ARGV[3] = failure threshold (e.g. 5)
-- ARGV[4] = failure window in milliseconds (e.g. 30000)
-- ARGV[5] = cooldown in milliseconds (e.g. 60000)
--
-- Hash fields on KEYS[1]:
--   state                -> "closed" | "open" | "half_open"
--   consecutiveSuccesses -> integer string
--   openedAt             -> timestamp ms when state last transitioned to open
--   trialInFlight        -> "0" | "1" to guarantee only one half-open trial
--
-- Sorted set KEYS[2] stores failure timestamps as scores (and members).
-- We keep it separate from the hash because sliding-window operations are
-- natural on sorted sets (remove old entries, then count remaining).
--
-- Return values:
--   CHECK          -> "ALLOW" or "DENY"
--   REPORT_SUCCESS -> "OK"
--   REPORT_FAILURE -> "OK"

local stateKey = KEYS[1]
local failuresKey = KEYS[2]

local now = tonumber(ARGV[1])
local action = ARGV[2]
local threshold = tonumber(ARGV[3])
local failureWindowMs = tonumber(ARGV[4])
local cooldownMs = tonumber(ARGV[5])

-- Ensure the hash has a known baseline shape.
-- HSETNX avoids clobbering existing state while making first access safe.
redis.call('HSETNX', stateKey, 'state', 'closed')
redis.call('HSETNX', stateKey, 'consecutiveSuccesses', '0')
redis.call('HSETNX', stateKey, 'openedAt', '0')
redis.call('HSETNX', stateKey, 'trialInFlight', '0')

local state = redis.call('HGET', stateKey, 'state')

if action == 'CHECK' then
  -- CLOSED: allow normal traffic through to upstream.
  if state == 'closed' then
    return 'ALLOW'
  end

  -- OPEN: reject immediately until cooldown elapses.
  if state == 'open' then
    local openedAt = tonumber(redis.call('HGET', stateKey, 'openedAt')) or 0

    -- Lazy open->half_open transition happens only when a request arrives
    -- after cooldown. Exactly one request performs this transition atomically
    -- and gets ALLOW as the trial request.
    if (now - openedAt) >= cooldownMs then
      redis.call('HSET', stateKey, 'state', 'half_open')
      redis.call('HSET', stateKey, 'consecutiveSuccesses', '0')
      redis.call('HSET', stateKey, 'trialInFlight', '1')
      return 'ALLOW'
    end

    return 'DENY'
  end

  -- HALF_OPEN: allow exactly one trial request at a time. If a trial is
  -- already in flight, deny immediately.
  if state == 'half_open' then
    local trialInFlight = tonumber(redis.call('HGET', stateKey, 'trialInFlight')) or 0
    if trialInFlight == 0 then
      redis.call('HSET', stateKey, 'trialInFlight', '1')
      return 'ALLOW'
    end

    return 'DENY'
  end

  -- Defensive default: unknown state behaves as open (safe denial).
  return 'DENY'
end

if action == 'REPORT_SUCCESS' then
  -- Only half_open success affects state transitions.
  if state == 'half_open' then
    redis.call('HSET', stateKey, 'trialInFlight', '0')

    local consecutiveSuccesses = tonumber(redis.call('HGET', stateKey, 'consecutiveSuccesses')) or 0
    consecutiveSuccesses = consecutiveSuccesses + 1
    redis.call('HSET', stateKey, 'consecutiveSuccesses', tostring(consecutiveSuccesses))

    -- After 2 consecutive half-open successes, consider provider recovered.
    if consecutiveSuccesses >= 2 then
      redis.call('HSET', stateKey, 'state', 'closed')
      redis.call('HSET', stateKey, 'consecutiveSuccesses', '0')
      redis.call('HSET', stateKey, 'openedAt', '0')
      redis.call('HSET', stateKey, 'trialInFlight', '0')

      -- Clear old failure history so a stale burst cannot immediately retrip
      -- the circuit after successful recovery.
      redis.call('DEL', failuresKey)
    end
  end

  return 'OK'
end

if action == 'REPORT_FAILURE' then
  if state == 'closed' then
    -- Sliding-window failure accounting in CLOSED state.
    -- 1) Add this failure event
    -- 2) Evict failures older than the window
    -- 3) Count failures still inside the window
    local failureMember = now .. ':' .. math.random(1000000)
    redis.call('ZADD', failuresKey, now, failureMember)

    local windowStart = now - failureWindowMs
    redis.call('ZREMRANGEBYSCORE', failuresKey, '-inf', windowStart)

    local failureCount = tonumber(redis.call('ZCARD', failuresKey)) or 0

    -- Keep a safety TTL so dead providers do not leave keys forever.
    local ttlSeconds = math.ceil(failureWindowMs / 1000) + math.ceil(cooldownMs / 1000)
    redis.call('EXPIRE', failuresKey, ttlSeconds)
    redis.call('EXPIRE', stateKey, ttlSeconds)

    -- Threshold reached: trip to OPEN and start cooldown now.
    if failureCount >= threshold then
      redis.call('HSET', stateKey, 'state', 'open')
      redis.call('HSET', stateKey, 'openedAt', tostring(now))
      redis.call('HSET', stateKey, 'consecutiveSuccesses', '0')
      redis.call('HSET', stateKey, 'trialInFlight', '0')
    end

    return 'OK'
  end

  if state == 'half_open' then
    -- Any failure during recovery immediately reopens the circuit.
    redis.call('HSET', stateKey, 'state', 'open')
    redis.call('HSET', stateKey, 'openedAt', tostring(now))
    redis.call('HSET', stateKey, 'consecutiveSuccesses', '0')
    redis.call('HSET', stateKey, 'trialInFlight', '0')

    local ttlSeconds = math.ceil(failureWindowMs / 1000) + math.ceil(cooldownMs / 1000)
    redis.call('EXPIRE', stateKey, ttlSeconds)
    redis.call('EXPIRE', failuresKey, ttlSeconds)

    return 'OK'
  end

  if state == 'open' then
    -- Already open; keep openedAt so cooldown continues from first trip.
    return 'OK'
  end

  return 'OK'
end

-- Unknown action -> explicit error helps catch wiring bugs.
return redis.error_reply('Unknown circuit breaker action: ' .. tostring(action))
