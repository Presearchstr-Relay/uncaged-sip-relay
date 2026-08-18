/**
 * Deploy — the deployment portal. Target user: not a developer.
 *
 * Four tracks, all deploying into the user's OWN Cloudflare account:
 *   A. Deploy to Cloudflare (one click — repo cloned, D1 + Durable Objects
 *      auto-provisioned, Worker built and deployed by Cloudflare)
 *   B. Edit with Shakespeare (browser IDE, zero install)
 *   C. wrangler CLI (developers; wrangler ≥4.45 auto-provisions bindings)
 *   D. Cloudflare dashboard paste (no tooling; minimal UI)
 *
 * Plus: configuration wizard (generates downloadable config files), a
 * post-deploy verification panel, and relay announcement.
 *
 * @module ui/pages/deploy
 */

import { pageHeader } from '../app.js';
import { escapeHtml, toast, getRelayHttpBase } from '../api.js';
import { reqEvents, nip45Count } from '../ws.js';

const REPO = 'https://github.com/NostrDanish/SIP-Booster-Relay';
const CF_DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(REPO)}`;
const SHAKESPEARE_CLONE = 'https://shakespeare.diy/clone?url=https%3A%2F%2Fgithub.com%2FNostrDanish%2FSIP-Booster-Relay.git';

export async function renderDeploy(root, ctx) {
  root.innerHTML = pageHeader(
    'Deploy your own SIP-01 relay',
    'One shared decentralized index. Many independent relays. This page gets you from zero to a live relay in about five minutes.'
  ) + `
    <div class="notice">
      <strong>You own the infrastructure.</strong> Every track deploys into <em>your</em> Cloudflare
      account — your Worker, your D1 database, your Durable Objects. No one else can read your
      relay's data or turn it off. No deployment fee is collected by this page; SIP-01 stays free.
    </div>

    <section class="panel">
      <h2>// step 0 · what you need</h2>
      <div class="grid cols-3">
        <div class="feature"><h3>a Cloudflare account</h3><p>Free tier is fine. D1 + Durable Objects + Workers are all available on it.</p></div>
        <div class="feature"><h3>~5 minutes</h3><p>One click, one config edit, one verify. No terminal required for the main track.</p></div>
        <div class="feature"><h3>~$0 / month</h3><p>Small community relays typically live inside the free tier. The relay stores compact metadata, not the web.</p></div>
      </div>
    </section>

    <div class="grid cols-2">
      <section class="panel" style="border-color: var(--amber-dim)">
        <h2>// track A · one click (recommended)</h2>
        <p class="small muted">
          Cloudflare clones the repository into <em>your</em> GitHub/GitLab account, automatically
          provisions the D1 database and Durable Objects, builds, and deploys. Any later push to
          your repo redeploys automatically.
        </p>
        <p class="center mt mb">
          <a href="${CF_DEPLOY_URL}" target="_blank" rel="noopener">
            <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" class="h-auto">
          </a>
        </p>
        <ol class="small muted" style="padding-left:1.2rem">
          <li>Sign into Cloudflare and authorize the clone.</li>
          <li>Pick a worker name (this becomes <code>https://&lt;name&gt;.workers.dev</code>).</li>
          <li>Accept the detected resources (D1 database + Durable Object) — Cloudflare creates them for you.</li>
          <li>Wait for the first deploy, then scroll to <strong>step 3 · verify</strong> below.</li>
        </ol>
      </section>

      <section class="panel">
        <h2>// track B · Shakespeare (browser IDE)</h2>
        <p class="small muted">
          Clone and edit this project in the browser — no local tooling at all. Change
          <code>src/config.ts</code>, then deploy with the built-in Cloudflare provider.
        </p>
        <p class="center mt mb">
          <a href="${SHAKESPEARE_CLONE}" target="_blank" rel="noopener">
            <img src="https://shakespeare.diy/badge.svg" alt="Edit with Shakespeare" class="h-auto">
          </a>
        </p>
        <p class="small faint">Settings → Deploy inside Shakespeare holds your Cloudflare credentials; they never touch this page.</p>
      </section>
    </div>

    <div class="grid cols-2">
      <section class="panel">
        <h2>// track C · wrangler CLI</h2>
        <p class="small muted">For developers who like terminals:</p>
        <pre class="codeblock">git clone ${REPO}.git
cd SIP-Booster-Relay
npm install
npx wrangler login
# edit src/config.ts, then:
npx wrangler deploy</pre>
        <p class="small faint">wrangler ≥ 4.45 auto-provisions the D1 database and Durable Object on
          first deploy (older versions: <code>npx wrangler d1 create sip01-relay</code> and paste the
          id into <code>wrangler.toml</code>).</p>
      </section>

      <section class="panel">
        <h2>// track D · dashboard paste</h2>
        <p class="small muted">No git, no CLI: create a Worker in the Cloudflare dashboard, create a
          D1 database, bind <code>RELAY_DATABASE</code> + <code>RELAY_WEBSOCKET</code>, and paste the
          bundle:</p>
        <pre class="codeblock">npm install
npm run build   # → worker.js (self-contained)</pre>
        <p class="small faint">Paste <code>worker.js</code> into the Worker's code editor. This track
          serves a minimal landing page (no static dashboard UI) — prefer A/B/C for the full operator
          interface.</p>
      </section>
    </div>

    <section class="panel">
      <h2>// step 1 · configure (optional but recommended)</h2>
      <p class="small muted mb">Generate your <code>src/config.ts</code> values and
        <code>wrangler.toml</code>. After a Track A deploy: edit <code>src/config.ts</code> in your
        cloned repo and push — the relay redeploys automatically. Everything is later editable; nothing
        here is one-way.</p>
      <div class="grid cols-2">
        <div>
          <label>Relay name</label>
          <input type="text" id="cfg-name" value="my-sip-relay">
          <label>Operator npub (zap recipient when payment is on)</label>
          <input type="text" id="cfg-npub" placeholder="npub1…">
          <label>Relay mode</label>
          <select id="cfg-mode">
            <option value="sip01" selected>SIP-01 only (dedicated search index)</option>
            <option value="hybrid">Hybrid (general Nostr relay + SIP-01 index)</option>
            <option value="general">General Nostr relay (no SIP-01)</option>
          </select>
          <label>Payment</label>
          <select id="cfg-payment">
            <option value="free" selected>Free (no payment)</option>
            <option value="donation">Donation (optional zap button)</option>
            <option value="pay-to-relay">Pay-to-publish (zap required)</option>
          </select>
          <label>Price (sats, when payment is not free)</label>
          <input type="number" id="cfg-sats" value="1000" min="1">
        </div>
        <div>
          <label>Indexer policy</label>
          <select id="cfg-indexer-policy">
            <option value="open" selected>Open (any valid signed observation)</option>
            <option value="blocklist">Blocklist (block specific indexers)</option>
            <option value="allowlist">Allowlist (only listed indexers)</option>
          </select>
          <div class="mt">
            <label class="inline"><input type="checkbox" id="cfg-validation" checked> SIP-01 schema validation</label>
            <label class="inline"><input type="checkbox" id="cfg-nip50" checked> NIP-50 search</label>
            <label class="inline"><input type="checkbox" id="cfg-nip45" checked> NIP-45 counts</label>
            <label class="inline"><input type="checkbox" id="cfg-nip77" checked> NIP-77 federation</label>
            <label class="inline"><input type="checkbox" id="cfg-auth"> Require NIP-42 auth</label>
            <label class="inline"><input type="checkbox" id="cfg-pruning" checked> Auto-pruning at 9 GB</label>
          </div>
          <button class="btn mt" id="generate">Generate configuration</button>
        </div>
      </div>
      <div id="generated"></div>
    </section>

    <section class="panel">
      <h2>// step 2 · verify your relay</h2>
      <p class="small muted mb">Paste your relay URL once it's deployed. We check the NIP-11 document
        (the <code>uncaged_index</code> SIP-01 block), a live WebSocket REQ, and a NIP-45 COUNT.</p>
      <div class="searchbar">
        <input type="text" id="verify-url" placeholder="https://my-sip-relay.workers.dev">
        <button class="btn" id="verify-go">Verify</button>
      </div>
      <div id="verify-out"></div>
    </section>

    <section class="panel">
      <h2>// step 3 · join the network</h2>
      <div class="grid cols-2">
        <div>
          <h3>Point crawlers at it</h3>
          <p class="small muted">In Crawlstr / Indexstr, add your relay to the publish pool:
            <code>wss://&lt;your-relay&gt;</code>. Observations appear on your dashboard immediately.</p>
          <h3 class="mt">Search engines</h3>
          <p class="small muted">Engines discover your relay from its NIP-11 <code>uncaged_index</code>
            block and can federate with it over NIP-77. See docs → FEDERATION.</p>
        </div>
        <div>
          <h3>Announce it on Nostr (optional)</h3>
          <p class="small muted">Publish a plain note announcing your relay (uses your browser's Nostr
            signer — nothing is signed without your approval):</p>
          <button class="btn small ghost" id="announce">Announce with Nostr</button>
          <span class="small faint" id="announce-status" style="margin-left:.6rem"></span>
          <p class="small faint mt">Registry convention: PRs to the SIP-01 repo's relay list are welcome;
            always verify a relay's NIP-11 document before trusting its index.</p>
        </div>
      </div>
    </section>
  `;

  bindGenerate(root);
  bindVerify(root);
  bindAnnounce(root);
}

/* ---------------- configuration generation ---------------- */

function bindGenerate(root) {
  root.querySelector('#generate').addEventListener('click', () => {
    const val = (id) => /** @type {HTMLInputElement} */ (root.querySelector(id)).value;
    const checked = (id) => /** @type {HTMLInputElement} */ (root.querySelector(id)).checked;

    const name = val('#cfg-name').trim() || 'my-sip-relay';
    const npub = val('#cfg-npub').trim() || 'npub1…';
    const mode = val('#cfg-mode');
    const payment = val('#cfg-payment');
    const sats = Math.max(1, parseInt(val('#cfg-sats'), 10) || 1000);
    const policy = val('#cfg-indexer-policy');
    const workerName = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

    const configSnippet = [
      '// src/config.ts — the editable block, generated by the deploy portal',
      `export const RELAY_MODE: 'general' | 'hybrid' | 'sip01' = '${mode}';`,
      `export const SIP01_VALIDATION = ${checked('#cfg-validation')};`,
      `export const NIP50_ENABLED = ${checked('#cfg-nip50')};`,
      `export const NIP45_ENABLED = ${checked('#cfg-nip45')};`,
      `export const NIP77_ENABLED = ${checked('#cfg-nip77')};`,
      '',
      `export const PAYMENT_MODE: 'free' | 'donation' | 'pay-to-relay' = '${payment}';`,
      `export const relayNpub = "${npub}";`,
      `export const RELAY_ACCESS_PRICE_SATS = ${sats};`,
      '',
      `export const AUTH_REQUIRED = ${checked('#cfg-auth')};`,
      `export const SIP01_INDEXER_POLICY: 'open' | 'allowlist' | 'blocklist' = '${policy}';`,
      '',
      `export const DB_PRUNING_ENABLED = ${checked('#cfg-pruning')};`,
      '',
      'export const relayInfo: RelayInfo = {',
      `  name: "${name.replace(/"/g, '\\"')}",`,
      '  description: "A SIP-01 decentralized search index relay",',
      '  // …keep the rest of the shipped relayInfo defaults or adjust to taste',
      '};',
      '',
    ].join('\n');

    const wranglerSnippet = [
      '# wrangler.toml',
      `name = "${workerName}"`,
      'compatibility_date = "2025-06-01"',
      'main = "src/index.ts"',
      '',
      '[assets]',
      'directory = "./"',
      'binding = "ASSETS"',
      '',
      '[[durable_objects.bindings]]',
      'name = "RELAY_WEBSOCKET"',
      'class_name = "RelayWebSocket"',
      '',
      '[[d1_databases]]',
      'binding = "RELAY_DATABASE"',
      'database_name = "sip01-relay"',
      'database_id = "PASTE_YOUR_D1_DATABASE_ID_HERE"   # not needed with wrangler ≥ 4.45 auto-provisioning',
      '',
      '[triggers]',
      'crons = ["0 0 * * *"]',
      '',
      '[limits]',
      'cpu_ms = 300000',
      '',
      '[[migrations]]',
      'tag = "v4"',
      'new_sqlite_classes = ["RelayWebSocket"]',
      '',
    ].join('\n');

    root.querySelector('#generated').innerHTML = `
      <div class="grid cols-2 mt">
        <section class="panel">
          <h2>// src/config.ts</h2>
          <pre class="codeblock" id="out-config">${escapeHtml(configSnippet)}</pre>
          <div class="flex">
            <button class="btn small ghost" data-copy="out-config">Copy</button>
            <button class="btn small ghost" data-download="out-config" data-filename="config.ts">Download config.ts</button>
          </div>
        </section>
        <section class="panel">
          <h2>// wrangler.toml</h2>
          <pre class="codeblock" id="out-wrangler">${escapeHtml(wranglerSnippet)}</pre>
          <div class="flex">
            <button class="btn small ghost" data-copy="out-wrangler">Copy</button>
            <button class="btn small ghost" data-download="out-wrangler" data-filename="wrangler.toml">Download wrangler.toml</button>
          </div>
        </section>
      </div>
    `;

    for (const btn of root.querySelectorAll('[data-copy]')) {
      btn.addEventListener('click', () => {
        const el = root.querySelector('#' + btn.getAttribute('data-copy'));
        navigator.clipboard.writeText(el.textContent || '').then(() => toast('Copied'));
      });
    }
    for (const btn of root.querySelectorAll('[data-download]')) {
      btn.addEventListener('click', () => {
        const el = root.querySelector('#' + btn.getAttribute('data-download'));
        const blob = new Blob([el.textContent || ''], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = btn.getAttribute('data-filename') || 'config.txt';
        a.click();
        URL.revokeObjectURL(a.href);
      });
    }

    root.querySelector('#generated').scrollIntoView({ behavior: 'smooth' });
  });
}

/* ---------------- post-deploy verification ---------------- */

function bindVerify(root) {
  const out = root.querySelector('#verify-out');

  const row = (label, state, detail) => `
    <div class="test-row">
      <span class="${state === 'pass' ? 'badge-ok' : state === 'fail' ? 'badge-fail' : 'muted'}">
        ${state === 'pass' ? '✓' : state === 'fail' ? '✗' : '…'}</span>
      <span class="name">${escapeHtml(label)}</span>
      ${detail ? `<span class="${state === 'fail' ? 'err' : 'muted'} small mono">${escapeHtml(detail)}</span>` : ''}
    </div>`;

  root.querySelector('#verify-go').addEventListener('click', async () => {
    const raw = /** @type {HTMLInputElement} */ (root.querySelector('#verify-url')).value.trim();
    if (!raw) return;
    const httpBase = raw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
    const wsUrl = httpBase.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

    out.innerHTML = row('NIP-11 document', 'pending') + row('SIP-01 capability (uncaged_index)', 'pending') +
      row('WebSocket REQ (kind 39697)', 'pending') + row('NIP-45 COUNT', 'pending');

    const rows = out.querySelectorAll('.test-row');
    const setRow = (i, state, detail) => { rows[i].outerHTML = row(['NIP-11 document', 'SIP-01 capability (uncaged_index)', 'WebSocket REQ (kind 39697)', 'NIP-45 COUNT'][i], state, detail); };

    // 1–2. NIP-11 + uncaged_index
    let nip11 = null;
    try {
      const res = await fetch(httpBase + '/', { headers: { Accept: 'application/nostr+json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      nip11 = await res.json();
      setRow(0, 'pass', `${nip11.name || 'unnamed'} · v${nip11.version || '?'} · nips: [${(nip11.supported_nips || []).join(', ')}]`);
    } catch (error) {
      setRow(0, 'fail', String(error.message || error));
      setRow(1, 'fail', 'no NIP-11 document');
    }
    if (nip11) {
      const sip = nip11.uncaged_index;
      if (sip && sip.sip01) {
        setRow(1, 'pass', `mode: ${sip.relay_mode || '?'} · validation: ${sip.validation} · nip50: ${sip.nip50} · nip77: ${sip.nip77}`);
      } else {
        setRow(1, 'fail', 'uncaged_index block missing — is this a SIP-01 relay?');
      }
    }

    // 3. WebSocket REQ
    const t0 = Date.now();
    const req = await reqEvents(wsUrl, [{ kinds: [39697], limit: 1 }], { timeoutMs: 8000 });
    if (req.error && !req.closed) {
      setRow(2, 'fail', req.error);
    } else if (req.closed) {
      setRow(2, req.closed.startsWith('auth-required') ? 'pass' : 'fail',
        req.closed.startsWith('auth-required') ? `relay speaks Nostr; NIP-42 required (${req.closed})` : req.closed);
    } else {
      setRow(2, 'pass', `EOSE in ${Date.now() - t0} ms, ${req.events.length} event(s) in store`);
    }

    // 4. COUNT
    const count = await nip45Count(wsUrl, { kinds: [39697] });
    setRow(3, count === null ? 'fail' : 'pass', count === null ? 'COUNT unsupported or refused' : `${count} observations stored`);

    const finalRows = out.querySelectorAll('.badge-ok');
    if (finalRows.length === 4) {
      out.innerHTML += `<div class="notice mt" style="border-color:#2c5a42;background:rgba(90,212,143,.06)">
        <strong style="color:var(--green)">Relay verified.</strong> Add it to your crawler publish pools and
        share it: <code>${escapeHtml(wsUrl)}</code></div>`;
    }
  });
}

/* ---------------- announcement ---------------- */

function bindAnnounce(root) {
  const btn = root.querySelector('#announce');
  const status = root.querySelector('#announce-status');
  btn.addEventListener('click', async () => {
    if (!window.nostr || !window.nostr.signEvent) {
      status.textContent = 'no Nostr signer found (install a NIP-07 extension)';
      return;
    }
    const verifiedUrl = /** @type {HTMLInputElement} */ (root.querySelector('#verify-url')).value.trim();
    const relayUrl = (verifiedUrl || getRelayHttpBase()).replace(/^http/, 'ws').replace(/\/+$/, '');
    const note = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', 'sip01'], ['t', 'nostr'], ['r', relayUrl]],
      content: `I just deployed a SIP-01 decentralized search index relay: ${relayUrl}\n\nOne shared index. Many independent indexers. No single owner.\n\nSpec: https://github.com/NostrDanish/SIP-01`,
    };
    try {
      const signed = await window.nostr.signEvent(note);
      status.textContent = `signed — event ${signed.id.slice(0, 12)}… publish it to your usual relays from any client`;
      console.log('[deploy] announcement event:', signed);
    } catch (error) {
      status.textContent = 'signing declined';
    }
  });
}
