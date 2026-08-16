#!/usr/bin/env node
/**
 * Tenant Seeding Script for Load Testing (Phase 10)
 *
 * Seeds:
 * 1. 2 Dedicated Warm-up Tenants (used ONLY by cacheHitTest.js setup() warm-up calls)
 * 2. 250 Main Load-Test Tenants (used for VU traffic in rateLimitTest, cacheHitTest, circuitBreakerTest)
 *
 * Resiliency: If a tenant email already exists (409 Conflict), logs in and rotates
 * the API key to retrieve a fresh working key, allowing safe re-runs.
 *
 * Usage:
 *   node scripts/seed/seedTenants.js [BASE_URL]
 *   e.g. node scripts/seed/seedTenants.js http://localhost:8080
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = (process.argv[2] || 'http://localhost:8080').replace(/\/+$/, '');
const WARMUP_TENANT_COUNT = 2;
const MAIN_TENANT_COUNT = 250;
const FIXED_PASSWORD = 'Password123!';
const OUTPUT_FILE = path.join(__dirname, 'tenants.json');

async function seedTenant(email) {
  try {
    // 1. Try Signup
    const signupRes = await fetch(`${BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: FIXED_PASSWORD }),
    });

    if (signupRes.status === 201) {
      const data = await signupRes.json();
      return {
        tenantId: data.tenant.id,
        email: data.tenant.email,
        apiKey: data.apiKey,
      };
    }

    // 2. If 409 Conflict, login and rotate API key to get a fresh raw key
    if (signupRes.status === 409) {
      const loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: FIXED_PASSWORD }),
      });

      if (!loginRes.ok) {
        throw new Error(`Login failed for existing user ${email} (${loginRes.status})`);
      }

      const loginData = await loginRes.json();
      const token = loginData.token;
      const tenantId = loginData.tenant.id;

      const rotateRes = await fetch(`${BASE_URL}/auth/api-key/rotate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!rotateRes.ok) {
        throw new Error(`API key rotation failed for ${email} (${rotateRes.status})`);
      }

      const rotateData = await rotateRes.json();
      return {
        tenantId,
        email,
        apiKey: rotateData.apiKey,
      };
    }

    const errText = await signupRes.text();
    throw new Error(`Unexpected signup response for ${email} (${signupRes.status}): ${errText}`);
  } catch (err) {
    console.error(`[SEED ERROR] Failed to seed ${email}:`, err.message);
    throw err;
  }
}

async function main() {
  console.log(`🌱 [SEED] Starting tenant seeding against ${BASE_URL}...`);
  console.log(`   - ${WARMUP_TENANT_COUNT} dedicated warm-up tenants`);
  console.log(`   - ${MAIN_TENANT_COUNT} main load-test tenants`);

  // Seed Warm-up Tenants
  const warmupTenants = [];
  for (let i = 1; i <= WARMUP_TENANT_COUNT; i += 1) {
    const email = `loadtest-warmup-${i}@example.com`;
    const tenant = await seedTenant(email);
    warmupTenants.push(tenant);
  }
  console.log(`🌱 [SEED] Seeded ${WARMUP_TENANT_COUNT} dedicated warm-up tenants.`);

  // Seed Main Tenants
  const mainTenants = [];
  for (let i = 1; i <= MAIN_TENANT_COUNT; i += 1) {
    const email = `loadtest-tenant-${i}@example.com`;
    const tenant = await seedTenant(email);
    mainTenants.push(tenant);

    if (i % 50 === 0 || i === MAIN_TENANT_COUNT) {
      console.log(`🌱 [SEED] Seeded main tenants ${i}/${MAIN_TENANT_COUNT}...`);
    }
  }

  const payload = {
    warmupTenants,
    tenants: mainTenants,
  };

  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`✅ [SEED SUCCESS] Saved ${warmupTenants.length} warm-up and ${mainTenants.length} main tenants to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('💥 [SEED FATAL]', err);
  process.exit(1);
});
