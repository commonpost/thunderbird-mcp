'use strict';

// The bridge announces itself on every request to the add-on in X-Commonpost-Bridge:
// "<X.Y.Z>; packaging=<mcpb|file>[; profile=<name>]". Only a valid profile is sent, and its value never reaches
// the logs or changes anything else.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { versionCore, BRIDGE_HEADER } = require('../mcp-bridge.cjs');

const BRIDGE_PATH = path.resolve(__dirname, '..', 'mcp-bridge.cjs');
const BRIDGE_SOURCE = fs.readFileSync(BRIDGE_PATH, 'utf8');
const BRIDGE_VERSION = /^const BRIDGE_VERSION = '([^']*)';$/m.exec(BRIDGE_SOURCE)[1];
const TOKEN = 'a'.repeat(64);
const TOOL_RESULT = { content: [{ type: 'text', text: '{"ok":true}' }] };
const HEADER_PATTERN = /^\d+\.\d+\.\d+; packaging=(mcpb|file)(; profile=[a-z0-9][a-z0-9-]{0,31})?$/;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()();
  }
});

// A fake add-on that records the header and the received tool arguments. The probe (initialize) is answered with
// -32601, so no version notice of the bridge ever mixes into the results.
async function startFake() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body);
      requests.push({ method: message.method, header: req.headers['x-commonpost-bridge'], params: message.params });
      res.setHeader('Content-Type', 'application/json');
      if (message.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
        return;
      }
      const result = message.method === 'tools/list' ? { tools: [] } : TOOL_RESULT;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { port: server.address().port, requests };
}

// A running bridge against the fake add-on. `env` is added to a clean environment.
function startBridge(port, env = {}, bridgePath = BRIDGE_PATH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-header-'));
  const file = path.join(dir, 'connection.json');
  // 0600: the bridge refuses a connection file that others can read
  fs.writeFileSync(file, JSON.stringify({ port, token: TOKEN, pid: 4242 }), { mode: 0o600 });
  const cleanEnv = { ...process.env };
  delete cleanEnv.COMMONPOST_MCP_PACKAGING;
  delete cleanEnv.COMMONPOST_MCP_PROFILE;
  delete cleanEnv.COMMONPOST_MCP_DEBUG;
  const child = spawn(process.execPath, [bridgePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...cleanEnv, COMMONPOST_MCP_CONNECTION_FILE: file, ...env },
  });
  const waiting = new Map();
  let out = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    let idx;
    while ((idx = out.indexOf('\n')) !== -1) {
      const response = JSON.parse(out.slice(0, idx));
      out = out.slice(idx + 1);
      waiting.get(response.id)?.(response);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  cleanups.push(() => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error('no answer from the bridge')), 10000);
    waiting.set(id, (response) => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    list: () => send('tools/list', {}),
    call: (name = 'listAccounts', args = {}) => send('tools/call', { name, arguments: args }),
    stderrText: () => stderr,
  };
}

// The header of the first request of a kind, once the fake add-on has seen it.
async function headerOf(fake, method) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = fake.requests.find((request) => request.method === method);
    if (found) return found.header;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the add-on never received ${method}`);
}

async function headerFor(env) {
  const fake = await startFake();
  const bridge = startBridge(fake.port, env);
  await bridge.call();
  return { header: await headerOf(fake, 'tools/call'), bridge, fake };
}

describe('X-Commonpost-Bridge header', () => {
  const defaultHeader = `${versionCore(BRIDGE_VERSION)}; packaging=file`;

  it('is sent on tools/list, tools/call and the version probe, with the default value', async () => {
    const fake = await startFake();
    const bridge = startBridge(fake.port);
    await bridge.list();
    await bridge.call();
    assert.equal(await headerOf(fake, 'tools/list'), defaultHeader);
    assert.equal(await headerOf(fake, 'tools/call'), defaultHeader);
    assert.equal(await headerOf(fake, 'initialize'), defaultHeader);
  });

  it('says packaging=mcpb only for the exact value mcpb', async () => {
    assert.equal((await headerFor({ COMMONPOST_MCP_PACKAGING: 'mcpb' })).header, `${versionCore(BRIDGE_VERSION)}; packaging=mcpb`);
    for (const value of ['MCPB', ' mcpb', 'mcpb ', '${user_config.packaging}', '']) {
      assert.equal((await headerFor({ COMMONPOST_MCP_PACKAGING: value })).header, defaultHeader, JSON.stringify(value));
    }
  });

  it('adds a valid profile', async () => {
    assert.equal((await headerFor({ COMMONPOST_MCP_PROFILE: 'cursor' })).header, `${defaultHeader}; profile=cursor`);
    const longest = 'a'.repeat(32);
    assert.equal((await headerFor({ COMMONPOST_MCP_PROFILE: longest })).header, `${defaultHeader}; profile=${longest}`);
  });

  for (const value of ['a'.repeat(33), 'Cursor', 'a;b', 'a=b', '-x', 'a\nb', '${user_config.profile}']) {
    it(`omits the profile ${JSON.stringify(value)} and never logs its value`, async () => {
      const { header, bridge } = await headerFor({ COMMONPOST_MCP_PROFILE: value, COMMONPOST_MCP_DEBUG: '1' });
      assert.equal(header, defaultHeader);
      assert.ok(bridge.stderrText().includes('COMMONPOST_MCP_PROFILE ignored'), bridge.stderrText());
      assert.ok(!bridge.stderrText().includes(value), 'the value must not be logged');
    });
  }

  it('changes nothing else with a profile: same arguments, same result', async () => {
    const args = { accountId: 'acc1', nested: { a: [1, 2] } };
    const runs = [];
    for (const env of [{}, { COMMONPOST_MCP_PROFILE: 'cursor' }]) {
      const fake = await startFake();
      const bridge = startBridge(fake.port, env);
      const response = await bridge.call('listAccounts', args);
      const received = fake.requests.find((request) => request.method === 'tools/call');
      runs.push({ result: response.result, args: received.params.arguments });
    }
    assert.deepEqual(runs[0].args, args);
    assert.deepEqual(runs[1].args, args);
    assert.deepEqual(runs[0].result, runs[1].result);
  });

  it('says 0.0.0 when the bridge version is unreadable (a development build)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-header-dev-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const copy = path.join(dir, 'mcp-bridge.cjs');
    const edited = BRIDGE_SOURCE.replace(/^const BRIDGE_VERSION = '[^']*';$/m, "const BRIDGE_VERSION = 'dev';");
    assert.notEqual(edited, BRIDGE_SOURCE);
    fs.writeFileSync(copy, edited);
    const fake = await startFake();
    const bridge = startBridge(fake.port, {}, copy);
    await bridge.call();
    assert.ok((await headerOf(fake, 'tools/call')).startsWith('0.0.0; packaging='));
  });

  it('exports BRIDGE_HEADER in the documented shape', () => {
    assert.match(BRIDGE_HEADER, HEADER_PATTERN);
  });
});
