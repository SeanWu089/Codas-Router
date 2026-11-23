// Ephemeral loopback server for the Swift device directory client contract.
const http = require('node:http');
const fs = require('node:fs');
const [portFile, mode, token] = process.argv.slice(2);

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/probe/')) {
    if (req.headers.authorization) { res.writeHead(403); res.end('{}'); return; }
    if (req.url === '/probe/hang') return;
    if (req.url === '/probe/down') { res.writeHead(503); res.end('{}'); return; }
    res.writeHead(200, { 'cache-control': 'public, max-age=3600' });
    res.end(JSON.stringify({ ok: true, backendReachable: req.url !== '/probe/backend-down' })); return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
  }
  if (mode === 'legacy') {
    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return;
  }
  if (req.method === 'GET' && req.url === '/_codassol/usage') {
    res.writeHead(200); res.end(JSON.stringify({version:1,since:1000,sampledAt:3000,
      httpsRequests:42,receivedBytes:2048,sentBytes:4096,persistenceError:false,classifiedSince:2000,
      categories:[{id:'historical',requests:30,receivedBytes:1024,sentBytes:2048},{id:'mcp',requests:5,receivedBytes:1024,sentBytes:2048},{id:'health',requests:7,receivedBytes:0,sentBytes:0}],
      recentRequests:[{id:42,startedAt:2900,category:'mcp',method:'POST',receivedBytes:10,sentBytes:20,statusCode:200,durationMs:100,outcome:'complete'}]})); return;
  }
  if (req.method === 'GET' && req.url === '/_codassol/devices') {
    res.writeHead(200); res.end(JSON.stringify({
      version: 1, localDeviceId: 'mac-id', devices: [
        { id: 'win-id', installationId: 'stable-windows-uuid', name: 'GPU PC',
          platform: 'win32', kind: 'router', isThisDevice: false, status: 'offline',
          online: false, backendReachable: false, lastSeenAt: 0 },
        { id: 'mac-id', installationId: 'stable-mac-uuid', name: 'My Mac',
          platform: 'darwin', kind: 'router', isThisDevice: true, status: 'online',
          online: true, backendReachable: true, lastSeenAt: Date.now() }
      ]
    })); return;
  }
  if (req.method === 'PATCH' && req.url === '/_codassol/devices/win-id') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (data.name !== 'Home GPU') { res.writeHead(400); res.end('{}'); return; }
      res.writeHead(200); res.end(JSON.stringify({ok: true, device: {id: 'win-id', name: data.name}, sync: { attempted: 2, delivered: 1 }}));
    }); return;
  }
  res.writeHead(404); res.end('{}');
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
