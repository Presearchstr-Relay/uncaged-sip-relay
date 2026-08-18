/**
 * Root worker entry — used by Shakespeare's Cloudflare deploy and by
 * `wrangler deploy` when pointing at this file. The implementation lives in
 * src/; this file only re-exports it.
 */
export { RelayWebSocket } from './src/durable-object';
export { default } from './src/relay-worker';
