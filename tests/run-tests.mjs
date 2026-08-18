#!/usr/bin/env node
/**
 * Node test runner — executes the shared self-test suite against the
 * production modules. Zero dependencies; plain `npm test`.
 *
 * Exit code 0 when every test passes, 1 otherwise.
 */
import { runAllTests, summarize } from '../shared/selftest.js';

const results = await runAllTests((line) => console.log(line));
const summary = summarize(results);

console.log(`\n${summary}`);

if (results.some((r) => !r.pass)) {
  console.error('\nFAILURES:');
  for (const r of results.filter((r) => !r.pass)) {
    console.error(`  ✗ ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
