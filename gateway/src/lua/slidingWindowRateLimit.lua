-- Sliding-window log rate limiter using Redis sorted sets.
-- This script executes atomically via EVAL/EVALSHA — no race condition between
-- the check and the increment.
--
-- KEYS[1] = sorted set key for this tenant (e.g. "ratelimit:tenantId")
-- ARGV[1] = current timestamp in milliseconds (tonumber)
-- ARGV[2] = window size in milliseconds (tonumber)
-- ARGV[3] = max requests allowed in the window (tonumber)
--
-- Returns: { allowed (0 or 1), currentCount, oldestTimestamp }
--   allowed = 1 means request is allowed, 0 means rate limited
--   currentCount = number of requests in the window after this operation
--   oldestTimestamp = timestamp of the oldest entry in the window (for Retry-After)

local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])

-- 1. Evict entries older than (now - window)
--    ZREMRANGEBYSCORE key -inf (now - window)
local windowStart = now - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

-- 2. Count remaining entries in the window
--    ZCARD key
local count = redis.call('ZCARD', key)

-- 3. If under limit, add this request and allow
if count < max then
  -- Use a unique member to avoid collisions when multiple requests
  -- land in the same millisecond. Format: "timestamp:random"
  local member = now .. ':' .. math.random(1000000)
  redis.call('ZADD', key, now, member)

  -- Set an EXPIRE on the key as a cleanup safety net.
  -- The TTL is the window size in seconds (rounded up).
  local ttl = math.ceil(window / 1000)
  redis.call('EXPIRE', key, ttl)

  -- Return: allowed=1, new count, oldest timestamp (for Retry-After)
  -- After adding, the oldest entry is at index 0.
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestTs = 0
  if #oldest >= 2 then
    oldestTs = tonumber(oldest[2])
  end
  return {1, count + 1, oldestTs}
end

-- 4. At or over limit: deny the request
-- Return: allowed=0, current count, oldest timestamp (for Retry-After)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestTs = 0
if #oldest >= 2 then
  oldestTs = tonumber(oldest[2])
end
return {0, count, oldestTs}