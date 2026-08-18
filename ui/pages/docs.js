/**
 * Docs — renders the repository's markdown documentation in-app.
 * Falls back to GitHub links when the markdown isn't served (static preview
 * builds that don't copy docs/).
 *
 * @module ui/pages/docs
 */

import { pageHeader, routeParams } from '../app.js';
import { escapeHtml } from '../api.js';

const DOCS = [
  ['README', 'Overview & quickstart'],
  ['ARCHITECTURE', 'System design'],
  ['DEPLOYMENT', 'Deployment guide'],
  ['CONFIGURATION', 'Every config option'],
  ['SIP01', 'SIP-01 support profile'],
  ['NIP-COMPATIBILITY', 'NIP support matrix'],
  ['SECURITY', 'Security model'],
  ['FEDERATION', 'NIP-77 relay-to-relay sync'],
  ['OPERATIONS', 'Running the relay'],
  ['UPSTREAM', 'Nosflare lineage'],
  ['TROUBLESHOOTING', 'Common problems'],
  ['API', 'HTTP + WebSocket API reference'],
  ['TESTING', 'Test suite'],
];

const GH_BASE = 'https://github.com/NostrDanish/SIP-Booster-Relay/blob/main';

/** Small, safe markdown renderer (headings, fences, tables, lists, links). */
export function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let inList = false;
  let inTable = false;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };
  const closeTable = () => {
    if (inTable) { out.push('</tbody></table>'); inTable = false; }
  };

  const inline = (text) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushParagraph(); closeList(); closeTable();
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line) + '\n');
      continue;
    }

    const trimmed = line.trim();

    // Tables
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushParagraph(); closeList();
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
      if (!inTable) {
        out.push('<table><tbody>');
        inTable = true;
      }
      out.push('<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      continue;
    }
    closeTable();

    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushParagraph(); closeList();
      const level = Math.min(4, h[1].length);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(trimmed.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    closeList();

    if (trimmed.startsWith('> ')) {
      flushParagraph();
      out.push(`<blockquote>${inline(trimmed.slice(2))}</blockquote>`);
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      out.push('<hr>');
      continue;
    }

    if (trimmed === '') {
      flushParagraph();
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph(); closeList(); closeTable();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

export async function renderDocs(root, ctx) {
  const doc = routeParams().get('doc') || 'README';
  const base = location.pathname.replace(/[^/]*$/, '');

  const links = DOCS.map(([name, desc]) => {
    const active = name === doc;
    return `<a href="#/docs?doc=${name}" class="pill ${active ? 'amber' : ''}" title="${escapeHtml(desc)}">${escapeHtml(name)}</a>`;
  }).join(' ');

  root.innerHTML = pageHeader('Documentation', 'Every document ships in the repository under docs/ and at the project root.') + `
    <div class="mb flex">${links}</div>
    <div class="panel docs-body" id="doc-body"><p class="muted">loading ${escapeHtml(doc)}.md…</p></div>
  `;

  const body = root.querySelector('#doc-body');
  const path = doc === 'README' || doc === 'UPSTREAM' ? `${base}${doc}.md` : `${base}docs/${doc}.md`;

  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
      throw new Error('not markdown (SPA fallback)');
    }
    body.innerHTML = mdToHtml(text);
  } catch (error) {
    body.innerHTML = `
      <div class="notice info">
        <strong>${escapeHtml(doc)}.md is not served by this preview.</strong>
        Read it on GitHub:
        <a href="${GH_BASE}/${doc === 'README' || doc === 'UPSTREAM' ? '' : 'docs/'}${escapeHtml(doc)}.md" target="_blank" rel="noopener">
          ${escapeHtml(doc)}.md ↗</a>
        <div class="faint small mt">(${escapeHtml(error.message)})</div>
      </div>`;
  }
}
