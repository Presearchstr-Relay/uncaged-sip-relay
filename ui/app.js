/**
 * UNCAGED SIP Relay — operator UI shell (hash router).
 *
 * Every page works in two modes:
 *   - live:  served by a running relay (same-origin API + WebSocket)
 *   - preview/remote: static hosting, pointing at any SIP-01 relay URL
 *
 * @module ui/app
 */

import { detectLocalRelay, getRelayHttpBase, setRelayOverride, getRelayOverride, escapeHtml } from './api.js';

import { renderHome } from './pages/home.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderSearch } from './pages/search.js';
import { renderExplorer } from './pages/explorer.js';
import { renderIndexers } from './pages/indexers.js';
import { renderDocuments } from './pages/documents.js';
import { renderRelay } from './pages/relay.js';
import { renderDeploy } from './pages/deploy.js';
import { renderTests } from './pages/tests.js';
import { renderDocs } from './pages/docs.js';

const routes = {
  '/': renderHome,
  '/dashboard': renderDashboard,
  '/search': renderSearch,
  '/explorer': renderExplorer,
  '/indexers': renderIndexers,
  '/documents': renderDocuments,
  '/relay': renderRelay,
  '/deploy': renderDeploy,
  '/tests': renderTests,
  '/docs': renderDocs,
};

/** Shared context passed to every page renderer. */
export const ctx = {
  localRelay: null,   // same-origin /api/relay-info payload or null
};

export function currentRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path] = hash.split('?');
  return path === '' ? '/' : path;
}

export function routeParams() {
  const hash = location.hash.replace(/^#/, '');
  const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  return new URLSearchParams(q);
}

/**
 * Banner shown when the UI is not talking to a live relay on this origin.
 * Lets the operator point the UI at any SIP-01 relay (or deploy one).
 */
export function relayBannerHtml() {
  if (ctx.localRelay) return '';
  const override = getRelayOverride();
  return `
    <div class="notice">
      <strong>Preview mode.</strong> This origin is not a running SIP-01 relay, so the UI is not
      connected to live index data.
      ${override
        ? `Currently pointing at <code>${escapeHtml(override)}</code>.`
        : 'Enter a relay URL below to browse a live relay, or <a href="#/deploy">deploy your own</a>.'}
      <div class="flex mt">
        <input type="text" id="relay-override" placeholder="https://your-relay.example.com"
               value="${escapeHtml(override)}" style="max-width:380px">
        <button class="btn small" id="relay-override-save">Connect</button>
        ${override ? '<button class="btn small ghost" id="relay-override-clear">Reset</button>' : ''}
      </div>
    </div>
  `;
}

export function bindRelayBanner(root) {
  const save = root.querySelector('#relay-override-save');
  const clear = root.querySelector('#relay-override-clear');
  if (save) {
    save.addEventListener('click', () => {
      const input = /** @type {HTMLInputElement} */ (root.querySelector('#relay-override'));
      const value = input.value.trim();
      setRelayOverride(value || null);
      rerender();
    });
  }
  if (clear) {
    clear.addEventListener('click', () => {
      setRelayOverride(null);
      rerender();
    });
  }
}

/** Standard page header. */
export function pageHeader(title, subtitle) {
  return `
    <div class="mb">
      <h1 style="font-size:1.6rem;font-weight:800;letter-spacing:-0.01em">${escapeHtml(title)}</h1>
      ${subtitle ? `<p class="muted small mt">${subtitle}</p>` : ''}
    </div>
  `;
}

/** Small "which relay am I looking at" line for data pages. */
export function relayContextLine() {
  const base = getRelayHttpBase();
  const isLocal = !!ctx.localRelay && !getRelayOverride();
  return `<p class="faint small mono mb">source: ${escapeHtml(base)} ${isLocal ? '(this relay)' : ''}</p>`;
}

async function render() {
  const route = currentRoute();
  const root = document.getElementById('app');
  const renderFn = routes[route] || renderHome;

  // Nav active state
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.getAttribute('data-route') === route);
  }

  root.innerHTML = '<p class="muted center" style="padding:3rem 0">loading…</p>';
  try {
    await renderFn(root, ctx);
  } catch (error) {
    console.error(`[ui] page render failed for ${route}:`, error);
    root.innerHTML = `
      <div class="notice">
        <strong>Something broke.</strong> ${escapeHtml(error.message || String(error))}
      </div>`;
  }
  window.scrollTo(0, 0);
}

export function rerender() {
  render();
}

async function boot() {
  ctx.localRelay = await detectLocalRelay();
  if (ctx.localRelay) {
    console.log(`[ui] local relay detected: ${ctx.localRelay.name} v${ctx.localRelay.version} (mode: ${ctx.localRelay.relay_mode})`);
  } else {
    console.log('[ui] no local relay API — preview mode');
    // In preview mode, run the conformance suite in the background so anyone
    // inspecting the static build can verify protocol correctness from the
    // console (the /tests page shows the same suite in the UI).
    try {
      const { runAllTests, summarize } = await import('../shared/selftest.js');
      const results = await runAllTests((line) => console.log(line));
      console.log(`[TEST] preview self-test: ${summarize(results)}`);
    } catch (error) {
      console.error('[TEST] preview self-test failed to run:', error);
    }
  }
  window.addEventListener('hashchange', render);
  await render();
}

boot();
