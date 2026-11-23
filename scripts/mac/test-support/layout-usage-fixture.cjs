// Owned test-only loopback fixture. Never contacts Router, DevSpace or a public URL.
const http = require('node:http');
const fs = require('node:fs');
const [portFile] = process.argv.slice(2);
if (!portFile) throw new Error('Usage: layout-usage-fixture.cjs <port-file>');

const recentRequests = Array.from({ length: 100 }, (_, id) => ({
  id, startedAt: 1_700_000_000_000 + id * 1000, category: 'mcp', method: 'POST',
  receivedBytes: 10, sentBytes: 20, statusCode: 200, durationMs: 5, outcome: 'completed',
}));
const body = JSON.stringify({
  version: 1, since: 1_700_000_000_000, sampledAt: 1_700_000_100_000,
  httpsRequests: 100, receivedBytes: 1000, sentBytes: 2000, persistenceError: false,
  classifiedSince: 1_700_000_000_000,
  categories: [{ id: 'mcp', requests: 100, receivedBytes: 1000, sentBytes: 2000 }],
  recentRequests,
});

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/_codassol/usage' ||
      request.headers.authorization !== 'Bearer layout-test-secret-not-a-real-admin-token') {
    response.writeHead(403);
    response.end('{}');
    return;
  }
  response.writeHead(200, {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
  });
  response.end(body);
});
server.on('error', (error) => {
  console.error('Layout fixture:', error.message);
  process.exit(1);
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port), { mode: 0o600 });
});
