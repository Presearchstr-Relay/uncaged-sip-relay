# Deployment

The relay deploys into **your own Cloudflare account** — your Worker, your D1
database, your Durable Objects. Nobody else can read your relay's data or
switch it off.

Prerequisites:

- A Cloudflare account (free tier works; Durable Objects and D1 are available
  on it. The paid Workers plan raises CPU limits and unlocks D1 read
  replication)
- Node.js ≥ 20 and npm (for the wrangler CLI)

There are four supported deployment paths. Path A is recommended (zero
tooling, ~5 minutes). The relay's own **`/deploy`** page is a guided portal
through all four, including a configuration generator and post-deploy
verification.

---

## A. Deploy to Cloudflare (one click)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/NostrDanish/SIP-Booster-Relay)

What happens when you click:

1. Cloudflare clones this repository into **your** GitHub/GitLab account.
2. It reads `wrangler.toml`, **auto-provisions** the D1 database and the
   Durable Object, and writes the real database id into your copy.
3. Workers Builds builds and deploys the Worker; every later push to your
   repo redeploys automatically.

After it finishes: edit `src/config.ts` in your cloned repo (relay name,
payment, policies — the `/deploy` page generates the block for you), push,
and the relay redeploys. The database schema self-initializes on first
request — no migration step.

## B. wrangler CLI (recommended for developers)

```bash
# 1. Get the code
git clone https://github.com/NostrDanish/SIP-Booster-Relay.git
cd SIP-Booster-Relay
npm install

# 2. Configure — edit src/config.ts (see docs/CONFIGURATION.md)
$EDITOR src/config.ts

# 3. Authenticate and deploy — wrangler ≥ 4.45 auto-provisions the D1
#    database and Durable Object on first deploy
npx wrangler login
npx wrangler deploy
```

<details><summary>Older wrangler (< 4.45): create the database manually</summary>

```bash
npx wrangler d1 create sip01-relay
# → paste the printed database_id into wrangler.toml ([[d1_databases]])
npx wrangler deploy
```
</details>

Verify:

```bash
curl -H "Accept: application/nostr+json" https://<name>.workers.dev
# → NIP-11 document containing "uncaged_index": { "sip01": true, … }
```

Optional but recommended:

- **Custom domain**: Workers → your worker → Settings → Domains & Routes.
  `wss://relay.yourdomain.com` is much easier for crawlers to remember.
- **D1 read replication**: D1 → your database → Settings → enable read
  replication (the relay uses the D1 Session API; this lowers global read
  latency).
- **CPU time limit**: Settings → CPU time limit → 30000 ms minimum for busy
  relays (the shipped wrangler.toml requests this).

## C. Shakespeare (cloud IDE)

1. Open the repo in Shakespeare:
   [![Edit with Shakespeare](https://shakespeare.diy/badge.svg)](https://shakespeare.diy/clone?url=https%3A%2F%2Fgithub.com%2FNostrDanish%2FSIP-Booster-Relay.git)
2. Edit `src/config.ts` in the browser.
3. Create the D1 database (Cloudflare dashboard or wrangler) and paste the id
   into `wrangler.jsonc`.
4. Deploy from Shakespeare's deploy dialog (Cloudflare provider). The root
   `worker.ts` + static assets are bundled for you.

## D. Cloudflare dashboard (no CLI)

1. Create a D1 database: Storage & Databases → D1 → Create (note the UUID;
   enable read replication).
2. Create a Worker: Compute → Workers → Create. Keep the default code for now.
3. In the Worker's Settings → Bindings: bind `RELAY_DATABASE` to your D1
   database, and add a Durable Object binding `RELAY_WEBSOCKET` → class
   `RelayWebSocket`. (Dashboard paste deploys do not upload the static UI —
   the relay serves a minimal landing page instead.)
4. Build the single-file bundle locally:
   ```bash
   npm install
   npm run build     # produces worker.js
   ```
5. Paste `worker.js` into the Worker's code editor → Deploy.
6. For the full dashboard UI, prefer paths A/B/D (assets binding).

## E. Git-connected deploy (auto-updates)

1. Fork the repository on GitHub.
2. Cloudflare dashboard → Workers → Create → *Import a repository* → pick
   your fork.
3. Set the build command to `npm run build` (or none — `wrangler deploy`
   works directly against `src/index.ts`) and add the D1/DO bindings (or keep
   them in `wrangler.toml`, which the git flow reads).
4. Every push to `main` redeploys your relay.

## After deployment

1. Open `https://your-relay.workers.dev` — the landing page shows the relay
   URL and configuration.
2. `curl -H "Accept: application/nostr+json" …` — confirm the
   `uncaged_index` block.
3. Point crawlers at it: add `wss://your-relay…` to the publish pools of
   Crawlstr / Indexstr.
4. Search engines can now use your relay via NIP-01 filters and NIP-50.
5. (Optional) announce your relay in the SIP-01 relay registry — see
   docs/FEDERATION.md.

## Custom domain note

NIP-42's `relay` tag verification and the landing page derive their URLs
from the request Host header, so custom domains work without extra config.
