/**
 * Minimal inline landing page, served when the static assets binding is not
 * configured (single-script paste deploys into the Cloudflare dashboard).
 * The full operator UI lives in the repository's static assets and is served
 * automatically when deployed with wrangler/Shakespeare.
 *
 * @module src/mini-landing
 */

import { relayInfo } from './config';

export function serveMiniLanding(host: string): Response {
  const wsUrl = `wss://${host}`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(relayInfo.name)}</title>
<style>
  body { background:#0a0a0f; color:#e8e8f0; font-family: ui-monospace, Menlo, monospace;
         display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
  .box { max-width:640px; padding:2rem; border:1px solid #2a2a3a; border-radius:12px; background:#12121a; }
  h1 { color:#f0b45a; font-size:1.4rem; margin:0 0 .5rem; }
  code { display:block; background:#0a0a0f; border:1px solid #2a2a3a; border-radius:8px;
         padding:.75rem 1rem; color:#f0b45a; margin:1rem 0; word-break:break-all; }
  p { color:#9a9ab0; line-height:1.6; }
  a { color:#f0b45a; }
  small { color:#666; }
</style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(relayInfo.name)}</h1>
    <p>${escapeHtml(relayInfo.description)}</p>
    <p>Connect your Nostr client to:</p>
    <code>${escapeHtml(wsUrl)}</code>
    <p>
      <a href="/?" onclick="return false">NIP-11</a> relay info:
      <code style="display:inline">curl -H "Accept: application/nostr+json" https://${escapeHtml(host)}</code>
    </p>
    <small>Software: <a href="${escapeHtml(relayInfo.software)}">${escapeHtml(relayInfo.software)}</a> · v${escapeHtml(relayInfo.version)}<br>
    Minimal page: static assets binding not configured. Deploy with wrangler for the full dashboard.</small>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300' },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}
