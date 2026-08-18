/**
 * Dashboard — live relay/index statistics from the operator JSON API.
 *
 * @module ui/pages/dashboard
 */

import { relayBannerHtml, bindRelayBanner, pageHeader, relayContextLine } from '../app.js';
import { apiGet, escapeHtml, fmtNum, fmtBytes, timeAgo, shortHex } from '../api.js';

export async function renderDashboard(root, ctx) {
  root.innerHTML = pageHeader('Dashboard', 'Relay and SIP-01 index statistics.') + relayBannerHtml();
  bindRelayBanner(root);

  let stats;
  try {
    stats = await apiGet('/api/stats');
  } catch (error) {
    root.innerHTML += `
      <div class="notice info">
        <strong>No live data.</strong> The selected relay did not answer <code>/api/stats</code>.
        (${escapeHtml(error.message)})
      </div>`;
    return;
  }

  const m = stats.metrics || {};
  const accepted = m.sip01_accepted ?? 0;
  const rejected = m.sip01_validation_failures ?? 0;
  const dupes = m.sip01_duplicates ?? 0;
  const total = accepted + rejected;
  const rejectRate = total > 0 ? ((rejected / total) * 100).toFixed(1) : '0.0';

  const topList = (rows, key, label) => (rows || [])
    .map((r) => `<tr><td class="mono-cell">${escapeHtml(String(r[key] ?? '—'))}</td><td class="mono-cell" style="text-align:right">${fmtNum(r.n ?? r.observations)}</td></tr>`)
    .join('') || `<tr><td colspan="2" class="faint">no ${label} yet</td></tr>`;

  root.innerHTML += `
    ${relayContextLine()}

    <div class="grid cols-4 mb">
      <div class="stat"><div class="v">${fmtNum(stats.observations)}</div><div class="l">SIP-01 observations</div>
        <div class="sub">+${fmtNum(stats.observations_24h)} last 24h</div></div>
      <div class="stat"><div class="v">${fmtNum(stats.documents)}</div><div class="l">unique documents</div>
        <div class="sub">grouped by d (URL identity)</div></div>
      <div class="stat"><div class="v">${fmtNum(stats.indexers)}</div><div class="l">independent indexers</div>
        <div class="sub">distinct signing keys</div></div>
      <div class="stat"><div class="v">${fmtBytes(stats.database_size_bytes)}</div><div class="l">database size</div>
        <div class="sub">D1 capacity 10 GB</div></div>
    </div>

    <div class="grid cols-4 mb">
      <div class="stat"><div class="v">${fmtNum(m.events_accepted)}</div><div class="l">events accepted</div></div>
      <div class="stat"><div class="v">${escapeHtml(rejectRate)}%</div><div class="l">validation reject rate</div>
        <div class="sub">${fmtNum(rejected)} rejected · ${fmtNum(dupes)} duplicates</div></div>
      <div class="stat"><div class="v">${fmtNum((m.search_queries_ws ?? 0) + (m.search_queries_http ?? 0))}</div><div class="l">search queries</div></div>
      <div class="stat"><div class="v">${fmtNum(m.neg_sessions)}</div><div class="l">NIP-77 sync sessions</div>
        <div class="sub">${fmtNum(m.count_queries)} COUNT queries</div></div>
    </div>

    <div class="grid cols-2">
      <section class="panel">
        <h2>// top domains</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>host</th><th style="text-align:right">docs</th></tr></thead>
          <tbody>${topList(stats.top_hosts, 'url_host', 'domains')}</tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>// top indexers</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>indexer</th><th>software</th><th style="text-align:right">observations</th></tr></thead>
          <tbody>
            ${(stats.top_indexers || []).map((i) => `
              <tr>
                <td class="mono-cell" title="${escapeHtml(i.pubkey)}">${escapeHtml(shortHex(i.pubkey))}</td>
                <td class="mono-cell">${escapeHtml(i.software ? `${i.software}${i.software_version ? '/' + i.software_version : ''}` : '—')}</td>
                <td class="mono-cell" style="text-align:right">${fmtNum(i.observation_count)}</td>
              </tr>`).join('') || '<tr><td colspan="3" class="faint">no indexers yet</td></tr>'}
          </tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>// languages</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>lang</th><th style="text-align:right">docs</th></tr></thead>
          <tbody>${topList(stats.top_languages, 'language', 'languages')}</tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>// mime types</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>mime</th><th style="text-align:right">docs</th></tr></thead>
          <tbody>${topList(stats.top_mime_types, 'content_type', 'mime types')}</tbody>
        </table></div>
      </section>
    </div>

    <section class="panel">
      <h2>// indexer software families</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>software</th><th style="text-align:right">indexers</th><th style="text-align:right">observations</th></tr></thead>
        <tbody>
          ${(stats.indexer_software || []).map((s) => `
            <tr>
              <td class="mono-cell">${escapeHtml(s.software ?? '—')}</td>
              <td class="mono-cell" style="text-align:right">${fmtNum(s.n)}</td>
              <td class="mono-cell" style="text-align:right">${fmtNum(s.observations)}</td>
            </tr>`).join('') || '<tr><td colspan="3" class="faint">no crawler software seen yet</td></tr>'}
        </tbody></table>
      </div>
      <p class="faint small mt">Statistics are informational only — this relay assigns no authority score.
         Last generated: ${escapeHtml(new Date((stats.generated_at || 0) * 1000).toISOString())}</p>
    </section>
  `;
}
