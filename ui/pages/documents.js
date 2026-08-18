/**
 * Documents — the aggregated document index (one row per `d`), plus the
 * per-document provenance view (every observation, every indexer).
 *
 * @module ui/pages/documents
 */

import { relayBannerHtml, bindRelayBanner, pageHeader, relayContextLine, routeParams } from '../app.js';
import { apiGet, escapeHtml, fmtNum, timeAgo, fmtTime, shortHex } from '../api.js';

export async function renderDocuments(root, ctx) {
  const d = routeParams().get('d');
  if (d) {
    await renderDocumentDetail(root, d);
    return;
  }

  root.innerHTML = pageHeader(
    'Documents',
    'The aggregated web-document index: one entry per normalized URL, across all indexers.'
  ) + relayBannerHtml() + `
    <div class="searchbar">
      <input type="text" id="doc-filter" placeholder="filter by keyword, host:, or lang: (client-side)">
      <button class="btn small" id="doc-filter-go">Apply</button>
    </div>
    <div id="docs"><p class="muted">loading…</p></div>
  `;
  bindRelayBanner(root);

  const load = async () => {
    const val = /** @type {HTMLInputElement} */ (root.querySelector('#doc-filter')).value.trim();
    let path = '/api/documents?limit=60';
    if (val.includes('host:')) {
      path += `&host=${encodeURIComponent(val.replace('host:', '').trim())}`;
    } else if (val.includes('lang:')) {
      path += `&lang=${encodeURIComponent(val.replace('lang:', '').trim())}`;
    } else if (val) {
      path += `&q=${encodeURIComponent(val)}`;
    }
    const data = await apiGet(path);
    renderDocList(root, data);
  };

  root.querySelector('#doc-filter-go').addEventListener('click', load);
  root.querySelector('#doc-filter').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

  try {
    const data = await apiGet('/api/documents?limit=60');
    renderDocList(root, data);
  } catch (error) {
    root.querySelector('#docs').innerHTML =
      `<div class="notice info"><strong>No live data.</strong> ${escapeHtml(error.message)}</div>`;
  }
}

function renderDocList(root, data) {
  const docs = data.documents || [];
  root.querySelector('#docs').innerHTML = `
    ${relayContextLine()}
    <p class="small muted mb">${fmtNum(data.total)} documents in the index${docs.length < data.total ? `, showing ${docs.length}` : ''}:</p>
    <section class="panel">
      <div class="table-wrap"><table>
        <thead>
          <tr><th>title</th><th>host</th><th style="text-align:right">indexers</th>
              <th style="text-align:right">observations</th><th>lang</th><th>last seen</th></tr>
        </thead>
        <tbody>
          ${docs.map((doc) => `
            <tr>
              <td style="max-width:340px">
                <a href="#/documents?d=${encodeURIComponent(doc.d)}" style="color:var(--text);font-weight:600">${escapeHtml(doc.title)}</a>
                <div class="mono faint" style="font-size:.72rem;word-break:break-all">${escapeHtml(doc.canonical_url)}</div>
              </td>
              <td class="mono-cell">${escapeHtml(doc.url_host)}</td>
              <td class="mono-cell" style="text-align:right">
                <span class="pill ${doc.indexer_count > 1 ? 'green' : ''}">${fmtNum(doc.indexer_count)}</span>
              </td>
              <td class="mono-cell" style="text-align:right">${fmtNum(doc.observation_count)}</td>
              <td class="mono-cell">${escapeHtml(doc.language || '—')}</td>
              <td class="mono-cell" title="${escapeHtml(fmtTime(doc.last_seen))}">${timeAgo(doc.last_seen)}</td>
            </tr>`).join('') || '<tr><td colspan="6" class="faint">No documents yet.</td></tr>'}
        </tbody>
      </table></div>
    </section>
  `;
}

async function renderDocumentDetail(root, d) {
  root.innerHTML = pageHeader('Document provenance', 'Every observation of this URL, preserved independently.') +
    relayBannerHtml() + `<div id="doc"><p class="muted">loading…</p></div>`;
  bindRelayBanner(root);

  let data;
  try {
    data = await apiGet(`/api/document?d=${encodeURIComponent(d)}`);
  } catch (error) {
    root.querySelector('#doc').innerHTML =
      `<div class="notice"><strong>Document not found.</strong> ${escapeHtml(error.message)}</div>`;
    return;
  }

  const doc = data.document;
  const topics = (() => { try { return JSON.parse(doc.topics || '[]'); } catch { return []; } })();

  root.querySelector('#doc').innerHTML = `
    <section class="panel">
      <h2 style="color:var(--text);font-size:1.2rem">${escapeHtml(doc.title)}</h2>
      <a class="url mono" style="color:var(--blue);word-break:break-all" href="${escapeHtml(doc.canonical_url)}" target="_blank" rel="noopener nofollow">${escapeHtml(doc.canonical_url)}</a>
      ${doc.description ? `<p class="muted mt">${escapeHtml(doc.description)}</p>` : ''}
      <div class="meta flex mt">
        <span class="pill green">${fmtNum(doc.indexer_count)} independent indexer${doc.indexer_count === 1 ? '' : 's'}</span>
        <span class="pill">${fmtNum(doc.observation_count)} observation${doc.observation_count === 1 ? '' : 's'}</span>
        ${doc.language ? `<span class="pill blue">${escapeHtml(doc.language)}</span>` : ''}
        ${doc.content_type ? `<span class="pill">${escapeHtml(doc.content_type)}</span>` : ''}
        ${doc.doc_type ? `<span class="pill">${escapeHtml(doc.doc_type)}</span>` : ''}
        ${doc.platform ? `<span class="pill">${escapeHtml(doc.platform)}</span>` : ''}
        ${topics.map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join('')}
      </div>
      <div class="codeblock mt">d:           ${escapeHtml(doc.d)}
x (latest):  ${escapeHtml(doc.content_hash || '—')}
first seen:  ${escapeHtml(fmtTime(doc.first_seen))}
last seen:   ${escapeHtml(fmtTime(doc.last_seen))}</div>
    </section>

    <section class="panel">
      <h2>// observations (${data.observations.length})</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>event id</th><th>indexer</th><th>software</th><th>content hash (x)</th><th>observed at</th></tr></thead>
        <tbody>
          ${data.observations.map((o) => `
            <tr>
              <td class="mono-cell" title="${escapeHtml(o.event_id)}">${escapeHtml(shortHex(o.event_id, 10, 6))}</td>
              <td class="mono-cell" title="${escapeHtml(o.pubkey)}">${escapeHtml(shortHex(o.pubkey, 10, 6))}</td>
              <td class="mono-cell">${escapeHtml(o.source || '—')}</td>
              <td class="mono-cell" title="${escapeHtml(o.content_hash || '')}">${escapeHtml(o.content_hash ? shortHex(o.content_hash, 8, 6) : '—')}</td>
              <td class="mono-cell" title="${escapeHtml(fmtTime(o.created_at))}">${timeAgo(o.created_at)}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
      <p class="faint small mt">Same <code>d</code> + same <code>x</code> across indexers = independent agreement.
         Same <code>d</code> + different <code>x</code> = the page changed or indexers disagree — both are ranking signals (SIP-01 §8).</p>
      <p class="small mt"><a href="#/documents">← all documents</a></p>
    </section>
  `;
}
