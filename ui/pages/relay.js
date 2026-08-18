/**
 * Relay — the NIP-11 information document viewer, with the SIP-01
 * capability block (`uncaged_index`) rendered readably.
 *
 * @module ui/pages/relay
 */

import { relayBannerHtml, bindRelayBanner, pageHeader, relayContextLine } from '../app.js';
import { fetchRelayInfoDoc, escapeHtml, getRelayHttpBase } from '../api.js';

export async function renderRelay(root, ctx) {
  root.innerHTML = pageHeader(
    'Relay information',
    'The NIP-11 document this relay serves for `Accept: application/nostr+json`.'
  ) + relayBannerHtml() + `<div id="nip11"><p class="muted">loading…</p></div>`;
  bindRelayBanner(root);

  let doc;
  try {
    doc = await fetchRelayInfoDoc();
  } catch (error) {
    root.querySelector('#nip11').innerHTML = `
      <div class="notice"><strong>No NIP-11 document.</strong> ${escapeHtml(error.message)}
      <div class="codeblock mt">curl -H "Accept: application/nostr+json" ${escapeHtml(getRelayHttpBase())}</div></div>`;
    return;
  }

  const sip = doc.uncaged_index;

  root.querySelector('#nip11').innerHTML = `
    ${relayContextLine()}
    ${sip ? `
      <section class="panel">
        <h2>// SIP-01 capability block (uncaged_index)</h2>
        <div class="flex mb">
          <span class="pill green">sip01: ${escapeHtml(String(sip.sip01))}</span>
          <span class="pill ${sip.nip50 ? 'green' : ''}">nip50: ${escapeHtml(String(sip.nip50))}</span>
          <span class="pill ${sip.nip77 ? 'green' : ''}">nip77: ${escapeHtml(String(sip.nip77))}</span>
          <span class="pill amber">mode: ${escapeHtml(String(sip.relay_mode ?? '—'))}</span>
          <span class="pill">validation: ${escapeHtml(String(sip.validation))}</span>
          <span class="pill">schema v${escapeHtml(String(sip.schema_version ?? '1'))}</span>
          <span class="pill">scope: ${escapeHtml(String(sip.scope ?? '—'))}</span>
        </div>
        <p class="small muted">document kinds: ${(sip.document_kinds || []).map((k) => `<code>${escapeHtml(String(k))}</code>`).join(' ')}</p>
        <p class="small muted mt">search filters: ${(sip.filters || []).map((f) => `<code>${escapeHtml(f.includes(':') ? f : f + ':')}</code>`).join(' ')}</p>
        ${(sip.languages || []).length ? `<p class="small muted mt">languages: ${sip.languages.map((l) => `<code>${escapeHtml(l)}</code>`).join(' ')}</p>` : ''}
        ${(sip.document_types || []).length ? `<p class="small muted mt">document types: ${sip.document_types.map((t) => `<code>${escapeHtml(t)}</code>`).join(' ')}</p>` : ''}
      </section>
    ` : `
      <div class="notice info"><strong>No <code>uncaged_index</code> block.</strong>
      This relay does not advertise SIP-01 capabilities.</div>
    `}
    <section class="panel">
      <h2>// full NIP-11 document</h2>
      <div class="codeblock">${escapeHtml(JSON.stringify(doc, null, 2))}</div>
    </section>
  `;
}
