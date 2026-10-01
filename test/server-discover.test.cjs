'use strict';

// server/discover is answered by the bridge itself, at once, with the plain JSON-RPC "Method not found", whether
// Thunderbird runs or not; the bridge then answers initialize as usual.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BRIDGE_PATH = path.resolve(__dirname, '..', 'mcp-bridge.cjs');
const TOKEN = 'a'.repeat(64);

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()();
  }
});

// A running bridge; `send` writes one request and resolves with the raw stdout line and the delay.
function startBridge(connectionFile) {
  const child = spawn(process.execPath, [BRIDGE_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, COMMONPOST_MCP_CONNECTION_FILE: connectionFile },
  });
  const waiting = new Map();
  let out = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    let idx;
    while ((idx = out.indexOf('\n')) !== -1) {
      const line = out.slice(0, idx);
      out = out.slice(idx + 1);
      waiting.get(JSON.parse(line).id)?.(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  cleanups.push(() => { child.kill(); });
  const send = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer from the bridge')), 10000);
    const started = Date.now();
    waiting.set(id, (line) => { clearTimeout(timer); resolve({ line, ms: Date.now() - started }); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { send, stderrText: () => stderr };
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-discover-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('server/discover', () => {
  it('answers "Method not found" at once with Thunderbird absent, then initializes normally', async () => {
    const bridge = startBridge(path.join(tempDir(), 'missing-connection.json'));
    await bridge.send(99, 'ping', {}); // the process is ready
    for (const id of [0, 7, 'abc']) {
      const { line, ms } = await bridge.send(id, 'server/discover', {});
      assert.ok(ms < 100, `answered in ${ms} ms`);
      assert.equal(line, `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"error":{"code":-32601,"message":"Method not found"}}`);
    }
    const { line } = await bridge.send(1, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(JSON.parse(line).result.serverInfo.name, 'commonpost-mcp');
    assert.ok(!bridge.stderrText().includes('Connection discovery'), bridge.stderrText());
  });

  it('never contacts Thunderbird for server/discover', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    const file = path.join(tempDir(), 'connection.json');
    // 0600: the bridge refuses a connection file that others can read
    fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token: TOKEN, pid: 4242 }), { mode: 0o600 });
    const bridge = startBridge(file);
    await bridge.send(99, 'ping', {});
    const { line } = await bridge.send(5, 'server/discover', {});
    assert.equal(JSON.parse(line).error.code, -32601);
    assert.equal(requests.length, 0);
  });
});
