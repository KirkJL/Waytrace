# GPS Challenge Platform – Deployment Guide

## Architecture

```
GitHub Pages (static frontend)
       │
       │ HTTPS API calls
       ▼
Cloudflare Worker (server/worker.js)
       │
       ├── D1 SQLite Database
       └── KV Namespace (cache, rate-limiting, JWKS)
```

---

## Prerequisites

- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`
- Cloudflare account (free tier works)
- Microsoft Entra External ID tenant (free)
- GitHub account

---

## Step 1 – Cloudflare Setup

### 1a. Login
```bash
wrangler login
```

### 1b. Create D1 database
```bash
wrangler d1 create gps-challenge-db
```
Copy the `database_id` from the output into `wrangler.toml`.

### 1c. Create KV namespace
```bash
wrangler kv:namespace create KV
```
Copy the `id` into `wrangler.toml`.

### 1d. Apply database schema
```bash
wrangler d1 execute gps-challenge-db --file=server/schema.sql
```

### 1e. Apply the sponsorship migration
```bash
wrangler d1 execute gps-challenge-db --file=server/sponsorship-migration.sql
```
This adds the charities/sponsored-challenges/wallet tables used by the
Sponsor tab. Run it once, after `schema.sql`, on a fresh database.
(`server/schema_sponsorship.sql` is a deprecated earlier draft of this same
migration — don't run it, see the comment at the top of that file.)

### 1f. (Optional) Set the admin secret for manual challenge-expiry sweeps
```bash
wrangler secret put ADMIN_SECRET
```
Expired sponsored challenges are swept automatically every 15 minutes by the
Cron Trigger declared in `wrangler.toml` (`[triggers] crons = [...]`) —
`wrangler deploy` picks this up with no extra steps. `ADMIN_SECRET` is only
needed if you also want to trigger a sweep manually via
`POST /admin/process-expired` (header `X-Admin-Secret`).

---

## Step 2 – Microsoft Entra External ID

1. Go to https://entra.microsoft.com → **External Identities** → **Create tenant**
2. Create an **External** tenant (e.g. `yourapp.onmicrosoft.com`)
3. Register an app:
   - **App registrations** → **New registration**
   - Name: `WayTrace GPS Challenge`
   - Redirect URI: `https://YOUR_USERNAME.github.io/YOUR_REPO/` (SPA)
   - Also add `http://localhost:5500/` for local dev
4. Copy the **Client ID** and **Tenant ID**
5. Under **Authentication** → enable **ID tokens**
6. Under **API permissions** → add `openid`, `profile`, `email`

The JWKS URI will be:
`https://YOUR_TENANT.ciamlogin.com/YOUR_TENANT_ID/discovery/v2.0/keys`

The issuer will be:
`https://YOUR_TENANT.ciamlogin.com/YOUR_TENANT_ID/v2.0`

---

## Step 3 – Configure the App

### Edit `wrangler.toml`
```toml
[vars]
ALLOWED_ORIGINS = "https://YOUR_USERNAME.github.io,http://localhost:5500"
JWT_ISSUER      = "https://YOUR_TENANT.ciamlogin.com/YOUR_TENANT_ID/v2.0"
JWKS_URI        = "https://YOUR_TENANT.ciamlogin.com/YOUR_TENANT_ID/discovery/v2.0/keys"
DEV_MODE        = "false"
```

### Edit `app.js` (top CONFIG block)
```js
const CONFIG = {
  API_BASE:       'https://gps-challenge-worker.YOUR_SUBDOMAIN.workers.dev',
  MSAL_CLIENT_ID: 'YOUR_ENTRA_CLIENT_ID',
  MSAL_AUTHORITY: 'https://YOUR_TENANT.ciamlogin.com/YOUR_TENANT_ID',
  MSAL_REDIRECT:  'https://YOUR_USERNAME.github.io/YOUR_REPO/',
  ...
};
```

### Update CSP in `index.html`
Replace `YOUR_TENANT` in the Content-Security-Policy `connect-src` directive.

---

## Step 4 – Deploy Worker

```bash
wrangler deploy
```

Note the worker URL (e.g. `https://gps-challenge-worker.YOUR_SUBDOMAIN.workers.dev`).

---

## Step 5 – Deploy Frontend (GitHub Pages)

1. Push the repo to GitHub
2. Go to **Settings → Pages**
3. Source: **GitHub Actions** or **main branch / root**
4. Your app will be live at `https://YOUR_USERNAME.github.io/YOUR_REPO/`

---

## Environment Variables Reference

| Variable         | Where          | Description                              |
|------------------|----------------|------------------------------------------|
| `ALLOWED_ORIGINS`| wrangler.toml  | Comma-separated CORS origins             |
| `JWT_ISSUER`     | wrangler.toml  | Entra issuer URL                         |
| `JWKS_URI`       | wrangler.toml  | Entra JWKS endpoint                      |
| `DEV_MODE`       | wrangler.toml  | Set `true` only for local testing        |
| `API_BASE`       | app.js         | Worker URL                               |
| `MSAL_CLIENT_ID` | app.js         | Entra app client ID                      |
| `MSAL_AUTHORITY` | app.js         | Entra authority URL                      |

---

## Local Development

```bash
# Terminal 1 – worker
wrangler dev --local

# Terminal 2 – frontend (use VS Code Live Server or similar)
# Set CONFIG.DEV_MODE = true (auto-detected from localhost)
# Set CONFIG.API_BASE = 'http://localhost:8787'
```

In dev mode, the worker accepts tokens with `"dev": true` in the payload
without signature verification (requires `DEV_MODE=true` in wrangler env).

---

## Verification Checklist

### Auth
- [ ] Sign in with Microsoft opens popup
- [ ] Token is sent with API requests
- [ ] User record created in D1

### Tracking
- [ ] GPS permissions prompt appears
- [ ] Map centres on user location
- [ ] Route line draws as you move
- [ ] Metrics update every second
- [ ] Screen stays awake (wake lock badge lit)
- [ ] Pause/Resume works
- [ ] Finish saves activity to D1

### Gamification
- [ ] XP awarded after activity
- [ ] Personal bests calculated
- [ ] Achievements unlocked
- [ ] Daily challenges update

### Social
- [ ] Friend search returns results
- [ ] Friend requests sent/accepted
- [ ] Clubs created with invite code
- [ ] Club join by code works
- [ ] Club ownership can be transferred to another member
- [ ] Club can be deleted by its owner
- [ ] Leaderboards populated after activities

### Anti-cheat
- [ ] A normal walk/run uploads successfully
- [ ] An activity with a sustained speed above a realistic running pace
      (e.g. recorded while cycling) is rejected with a clear error, not
      silently queued for retry

### Profile
- [ ] Tapping the profile avatar opens a file picker
- [ ] Uploaded photo is resized client-side and shows immediately after upload

### Offline
- [ ] App loads without network (cached) – reload with DevTools "Offline"
      checked after one normal visit
- [ ] Activity queued when offline
- [ ] Queue syncs when back online
- [ ] A permanently-rejected queued activity (e.g. anti-cheat) is dropped
      from the queue with a toast, not retried forever

### PWA
- [ ] Installable on Android/iOS
- [ ] Standalone mode (no browser chrome)
- [ ] Safe-area padding correct on iPhone

---

## D1 Useful Queries

```sql
-- Check users
SELECT id, display_name, email FROM users;

-- Check activities
SELECT user_id, type, distance, duration, xp_awarded FROM activities ORDER BY created_at DESC LIMIT 10;

-- Check leaderboard data
SELECT u.display_name, s.lifetime_distance/1000 AS km, s.lifetime_xp
FROM user_stats s JOIN users u ON s.user_id=u.id
ORDER BY s.lifetime_xp DESC;

-- Check achievements
SELECT u.display_name, a.name FROM user_achievements ua
JOIN users u ON ua.user_id=u.id
JOIN achievements a ON ua.achievement_id=a.id;
```

---

## Cloudflare Free Tier Limits

| Resource       | Free Limit                  | Notes                          |
|----------------|-----------------------------|--------------------------------|
| Worker requests| 100,000/day                 | ~1 req/sec sustained           |
| D1 reads       | 5M rows/day                 | Very generous                  |
| D1 writes      | 100K rows/day               | Monitor activity uploads       |
| KV reads       | 100K/day                    | Used for leaderboard cache     |
| KV writes      | 1K/day                      | Rate limit + JWKS cache        |

The platform will comfortably serve hundreds of daily active users on the free tier.
