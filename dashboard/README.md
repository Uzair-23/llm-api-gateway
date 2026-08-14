# LLM API Gateway — React Dashboard

A modern React 19 + Vite + Tailwind CSS dashboard for the Multi-Tenant LLM API Gateway.

## Features & Pages

- **`/auth/signup`**: Tenant registration page. Generates and displays a live `sk-live-...` API key **once** with a copy-to-clipboard button and security warning.
- **`/auth/login`**: JWT authentication page. Stores JWT token in `localStorage` (`"authToken"`).
- **`/dashboard`**: Protected main management console:
  - **API Key Management**: Displays current API key prefix (`sk-live-ab12...`), with immediate **Rotate API Key** action.
  - **Usage Analytics**: Interactive `recharts` graphs (Traffic over time, Cache Hit % rate, Latency, and Provider distribution).
  - **Rate Limit & Quota**: Visual sliding-window progress bar for tenant request quotas.
- **`*`**: 404 catch-all page.

---

## Local Development & Setup

### 1. Prerequisites
Ensure the Express Gateway backend is running on `http://localhost:4000`:
```bash
cd gateway && npm run dev
```

### 2. Start Dashboard
From the repository root or `/dashboard` directory:
```bash
cd dashboard
npm install
npm run dev
```
The Vite development server will launch on `http://localhost:3000`.

---

## Dev Proxy Configuration

`vite.config.ts` proxies API calls seamlessly to the Gateway on `http://localhost:4000`:
- `/auth/*` -> `http://localhost:4000/auth/*`
- `/v1/*` -> `http://localhost:4000/v1/*`
- `/dashboard/*` -> `http://localhost:4000/dashboard/*`

---

## Manual Verification Walkthrough

1. **Signup**:
   - Open `http://localhost:3000/auth/signup`.
   - Register a new tenant account (e.g. `demo@example.com`, password `password123`).
   - Confirm the green success screen displays your `sk-live-...` API key once. Click **Copy Key** and verify clipboard feedback.

2. **Dashboard Overview**:
   - Click **Continue to Dashboard** (or navigate to `/dashboard`).
   - Confirm header shows tenant email and plan tier badge.
   - Verify Active API Key shows key prefix (`sk-live-****`).

3. **Key Rotation**:
   - Click **Rotate Key 🔄** on the dashboard.
   - Confirm warning notice appears with your new rotated key.
   - Verify previous key is invalidated and active prefix updates immediately.

4. **Sign Out**:
   - Click **Sign Out** in the header.
   - Confirm `localStorage` tokens are cleared and you are redirected to `/auth/login`.
