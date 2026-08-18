/**
 * Indexers — who is feeding this relay: software, volume, recency.
 * Informational statistics only; no authority scoring.
 *
 * @module ui/pages/indexers
 */

import { relayBannerHtml, bindRelayBanner, pageHeader, relayContextLine } from '../app.js';
import { apiGet, escapeHtml, fmtNum, timeAgo, fmtTime, shortHex } from '../api.js';

export async function renderIndexers(root, ctx) {
  root.innerHTML = pageHeader(
    'Indexers',
    'Independent signing keys publishing SIP-01 observations to this relay.'
  ) + relayBannerHtml();
  bindRelayBanner(root);

  let data;
  try {
    data = await apiGet('/api/indexers?limit=200');
  } catch (error) {
    root.innerHTML += `<div class="notice info"><strong>No live data.</strong> ${escapeHtml(error.message)}</div>`;
    return;
  }

  const rows = data.indexers || [];

  root.innerHTML += `
    ${relayContextLine()}
    <section class="panel">
      <h2>// ${fmtNum(data.total)} known indexers</h2>
      <div class="table-wrap"><table>
        <thead>
          <tr>
            <th>pubkey</th><th>software</th><th style="text-align:right">observations</th>
            <th style="text-align:right">documents</th><th>first seen</th><th>last seen</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((i) => `
            <tr>
              <td class="mono-cell" title="${escapeHtml(i.pubkey)}">${escapeHtml(shortHex(i.pubkey, 10, 8))}</td>
              <td class="mono-cell">${escapeHtml(i.software ? `${i.software}${i.software_version ? '/' + i.software_version : ''}` : '—')}</td>
              <td class="mono-cell" style="text-align:right">${fmtNum(i.observation_count)}</td>
              <td class="mono-cell" style="text-align:right">${fmtNum(i.document_count)}</td>
              <td class="mono-cell" title="${escapeHtml(fmtTime(i.first_seen))}">${timeAgo(i.first_seen)}</td>
              <td class="mono-cell" title="${escapeHtml(fmtTime(i.last_seen))}">${timeAgo(i.last_seen)}</td>
            </tr>`).join('') || '<tr><td colspan="6" class="faint">No indexers yet — point Crawlstr/Indexstr at this relay.</td></tr>'}
        </tbody>
      </table></div>
      <p class="faint small mt">Statistics are computed from live observations and are informational only.
         A high observation count is not trust; independent agreement across different indexers is the signal
         (see a document's provenance view).</p>
    </section>
  `;
}
