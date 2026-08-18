/**
 * Tests — runs the canonical SIP-01/NIP-50/NIP-77 self-test suite in the
 * browser, against the exact modules the relay executes. Results are also
 * logged to the console with a [TEST] prefix.
 *
 * @module ui/pages/tests
 */

import { pageHeader } from '../app.js';
import { escapeHtml } from '../api.js';
import { runAllTests, summarize } from '../../shared/selftest.js';

export async function renderTests(root, ctx) {
  root.innerHTML = pageHeader(
    'Conformance tests',
    'The canonical SIP-01 test vectors (spec §13), validation negatives, NIP-50 operator semantics, and NIP-77 negentropy convergence — executed against the relay’s own modules.'
  ) + `
    <div class="panel">
      <button class="btn" id="run">Run test suite</button>
      <span class="test-summary" id="summary"></span>
      <div id="results"></div>
    </div>
    <p class="faint small">The same suite runs server-side with <code>npm test</code> (tests/run-tests.mjs)
       — one shared implementation, no drift.</p>
  `;

  const resultsEl = root.querySelector('#results');
  const summaryEl = root.querySelector('#summary');

  root.querySelector('#run').addEventListener('click', async () => {
    resultsEl.innerHTML = '';
    summaryEl.textContent = 'running…';
    console.log('[TEST] === suite starting ===');

    const results = await runAllTests((line) => console.log(line));

    resultsEl.innerHTML = results.map((r) => `
      <div class="test-row">
        <span class="${r.pass ? 'badge-ok' : 'badge-fail'}">${r.pass ? '✓' : '✗'}</span>
        <span class="name">${escapeHtml(r.name)}</span>
        ${r.error ? `<span class="err">${escapeHtml(r.error)}</span>` : ''}
      </div>
    `).join('');

    const summary = summarize(results);
    summaryEl.textContent = summary;
    summaryEl.style.color = results.every((r) => r.pass) ? 'var(--green)' : 'var(--red)';
    console.log(`[TEST] === suite finished: ${summary} ===`);
  });

  // Auto-run on page open — the suite is fast.
  root.querySelector('#run').click();
}
