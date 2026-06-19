// Long-running isolated server for manual poking (curl, or hand the URL to the
// operator's browser). Same isolation as the .test.mjs scripts — random free
// port, temp TP_DATA_FILE, TP_BUCKET='' — but it just stays up. Ctrl-C cleans
// the temp dir (startServer registers the SIGINT handler).
//
//   node tests/serve.mjs            # random port
//   node tests/serve.mjs --port 38400
import { startServer } from './lib/harness.mjs';

const i = process.argv.indexOf('--port');
const port = i >= 0 ? Number(process.argv[i + 1]) : undefined;

const { base } = await startServer({ port });
console.log(`\n→ serving (isolated, no S3)`);
console.log(`  admin   → ${base}/`);
console.log(`  viewer  → ${base}/view/`);
console.log(`  Ctrl-C to stop and clean the temp data dir.`);
await new Promise(() => {}); // hold the loop open
