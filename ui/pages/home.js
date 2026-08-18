/**
 * Landing page — what this relay is, the relay URL, SIP-01 capabilities,
 * architecture overview, and (optionally) the pay-to-relay zap flow.
 *
 * @module ui/pages/home
 */

import { relayBannerHtml, bindRelayBanner, pageHeader } from '../app.js';
import { escapeHtml, toast, getRelayWsUrl } from '../api.js';

export async function renderHome(root, ctx) {
  const info = ctx.localRelay;
  const wsUrl = getRelayWsUrl();

  const payment = info && info.payment_mode !== 'free';

  root.innerHTML = `
    ${relayBannerHtml()}

    <section class="hero">
      <h1>Your own <span class="accent">decentralized search index</span> relay</h1>
      <p class="tagline">
        A serverless <strong>SIP-01</strong> index relay: signed web-index observations
        (Nostr kind <span class="mono">39697</span>) from independent crawlers,
        validated, stored, searchable — on Cloudflare's edge network.
        One shared index. Many independent indexers. No single owner.
      </p>
      <div class="relay-url" id="relay-url-box" title="Click to copy">
        <span>${escapeHtml(wsUrl)}</span>
        <span class="copy">click to copy</span>
      </div>
      <div class="flex mt" style="justify-content:center">
        <a class="btn" href="#/deploy">Deploy your own node</a>
        <a class="btn ghost" href="#/search">Search the index</a>
      </div>
    </section>

    ${payment ? renderPayment(info) : ''}

    <section class="panel">
      <h2>// how it fits together</h2>
      <div class="flow"><span class="hl">WEB</span>
        │
  ┌─────▼──────┐        SIP-01 kind 39697        ┌───────────────┐
  │  crawlers  │ ───────────────────────────────▶ │  <span class="hl">SIP-01 relays</span> │  ← you are here
  │ (Crawlstr, │    signed web-index observations │  (this node)  │
  │  Indexstr) │                                  └───────┬───────┘
  └────────────┘                          NIP-50 / NIP-77 │
                                        ┌─────────────────┼─────────────────┐
                                  ┌─────▼─────┐   ┌───────▼──────┐   ┌──────▼──────┐
                                  │ search    │   │ other SIP-01 │   │  search     │
                                  │ engines   │   │ relays (sync)│   │  nodes      │
                                  └───────────┘   └──────────────┘   └─────────────┘</div>
    </section>

    <div class="grid cols-3 mb">
      <div class="feature">
        <h3>validated at the door</h3>
        <p>Every observation is checked against the SIP-01 v1 schema — URL normalization,
           <span class="mono">d</span>/<span class="mono">x</span> hash consistency, signatures,
           size caps — before it ever reaches the index.</p>
      </div>
      <div class="feature">
        <h3>built to search</h3>
        <p>NIP-50 with real web-search operators:
           <span class="mono">site:</span> <span class="mono">lang:</span>
           <span class="mono">mime:</span> <span class="mono">indexer:</span>
           <span class="mono">before:</span>/<span class="mono">after:</span>
           <span class="mono">distinct:domain</span> …</p>
      </div>
      <div class="feature">
        <h3>federated by design</h3>
        <p>NIP-77 negentropy sync lets relays reconcile indexes efficiently.
           No relay is the permanent global index — if one disappears, the index lives on.</p>
      </div>
      <div class="feature">
        <h3>independent indexers</h3>
        <p>Same URL observed by <em>N</em> different indexer keys = <em>N</em> signed observations,
           grouped by <span class="mono">d</span>. Provenance is preserved, never merged.</p>
      </div>
      <div class="feature">
        <h3>serverless economics</h3>
        <p>Cloudflare Workers + D1 + Durable Objects. No server to babysit,
           hibernating WebSockets, global read replication. Runs on the free tier for small nodes.</p>
      </div>
      <div class="feature">
        <h3>open, optionally paid</h3>
        <p>The protocol is free for everyone, forever. Operators may optionally charge
           for relay access via Bitcoin Lightning zaps. Policy, not protocol.</p>
      </div>
    </div>

    ${info ? renderCapabilities(info) : ''}

    <section class="panel">
      <h2>// start using this index</h2>
      <div class="grid cols-2">
        <div>
          <h3>Publish observations (crawlers)</h3>
          <p class="muted small">Any SIP-01 crawler can publish to this relay — plain Nostr EVENT messages:</p>
          <pre class="codeblock"><span class="k">["REQ","docs",{"kinds":[39697],"#t":["nostr"],"limit":50}]</span></pre>
        </div>
        <div>
          <h3>Search the index (engines)</h3>
          <p class="muted small">NIP-50 with SIP-01 operators:</p>
          <pre class="codeblock"><span class="k">["REQ","s",{"kinds":[39697],
  "search":"bitcoin privacy site:github.com lang:en",
  "limit":50}]</span></pre>
        </div>
      </div>
      <p class="small mt">
        <a href="#/search">Try search</a> ·
        <a href="#/explorer">Browse observations</a> ·
        <a href="#/relay">Relay information (NIP-11)</a> ·
        <a href="#/docs">Documentation</a> ·
        <a href="#/deploy"><strong>Deploy your own node</strong></a>
      </p>
    </section>
  `;

  bindRelayBanner(root);

  const urlBox = root.querySelector('#relay-url-box');
  if (urlBox) {
    urlBox.addEventListener('click', () => {
      navigator.clipboard.writeText(wsUrl).then(() => toast('Relay URL copied'));
    });
  }

  if (payment) initPayment(info);
}

function renderCapabilities(info) {
  const caps = [
    ['relay mode', info.relay_mode],
    ['SIP-01 validation', info.sip01_validation ? 'on' : 'off'],
    ['NIP-50 search', info.nip50 ? 'on' : 'off'],
    ['NIP-45 counts', info.nip45 ? 'on' : 'off'],
    ['NIP-77 federation', info.nip77 ? 'on' : 'off'],
    ['NIP-42 auth', info.auth_required ? 'required' : 'optional'],
    ['payment', info.payment_mode],
  ];
  return `
    <section class="panel">
      <h2>// this relay's configuration</h2>
      <div class="flex">
        ${caps.map(([k, v]) => `<span class="pill ${v === 'on' || v === 'sip01' ? 'amber' : ''}">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`).join('')}
      </div>
    </section>
  `;
}

function renderPayment(info) {
  const required = info.payment_mode === 'pay-to-relay';
  return `
    <section class="panel" id="pay-panel">
      <h2>// ${required ? 'pay to publish' : 'support this relay'}</h2>
      <p class="muted small">
        ${required
          ? `Publishing to this relay requires a one-time payment of <strong>${escapeHtml(String(info.payment_sats))} sats</strong> (Bitcoin Lightning via Nostr zap).`
          : `This relay is free to use. If it serves you, consider zapping the operator <strong>${escapeHtml(String(info.payment_sats))} sats</strong>.`}
      </p>
      <div class="mt">
        <button id="payButton" class="btn"
                data-npub="${escapeHtml(info.payment_npub)}"
                data-relays="wss://relay.damus.io,wss://relay.primal.net"
                data-sats-amount="${escapeHtml(String(info.payment_sats))}">
          ⚡ Pay ${escapeHtml(String(info.payment_sats))} sats
        </button>
        <span class="small faint" id="pay-status" style="margin-left:.8rem"></span>
      </div>
    </section>
  `;
}

/**
 * Zap flow (pay-to-relay / donation): the nostr-zap library opens the zap
 * dialog; after the zap lands, the zap receipt (kind 9735) is submitted to
 * the relay, which verifies it cryptographically (see src/pay.ts).
 */
function initPayment(info) {
  const statusEl = document.getElementById('pay-status');

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  (async () => {
    try {
      if (!window.nostrZap) {
        await loadScript('./nostr-zap.js').catch(() =>
          loadScript('https://cdn.jsdelivr.net/gh/NostrDanish/SIP-Booster-Relay@main/nostr-zap.js'));
      }
      if (window.nostrZap) {
        window.nostrZap.initTargets('#payButton');
      }
    } catch (error) {
      console.warn('[pay] zap library unavailable:', error);
      if (statusEl) statusEl.textContent = 'zap library failed to load — use any Nostr wallet to zap the operator npub shown in the relay info';
    }
  })();

  window.addEventListener('payment-success', async () => {
    if (statusEl) statusEl.textContent = 'payment sent — verifying…';
    // The zap receipt is fetched from relays by the caller's client in a full
    // deployment; here we poll the relay's payment status endpoint.
    if (!window.nostr || !window.nostr.getPublicKey) return;
    const pubkey = await window.nostr.getPublicKey();
    const started = Date.now();
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`./api/check-payment?pubkey=${pubkey}`);
        const data = await res.json();
        if (data.paid) {
          clearInterval(poll);
          if (statusEl) statusEl.textContent = 'access granted ✓';
        } else if (Date.now() - started > 60000) {
          clearInterval(poll);
          if (statusEl) statusEl.textContent = 'still waiting for confirmation…';
        }
      } catch { /* keep polling */ }
    }, 3000);
  });
}
