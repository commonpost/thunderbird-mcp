'use strict';

// The released 0.11.0 bridge (test/fixtures/mcp-bridge-v0.11.0.cjs.txt, byte for byte) against the add-on's bridge
// rules. The fake add-on is an HTTP server that runs the production BRIDGE COMPAT and COMPOSE HELPERS functions
// extracted from api.js, in the order the real handler calls them. It shows what a user of that old bridge sees:
// the notice, the refusal of mode "send", the security floor, and what an unmodified relay does with them.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const { BRIDGE_HEADER } = require('../mcp-bridge.cjs');

const FIXTURE = path.resolve(__dirname, 'fixtures/mcp-bridge-v0.11.0.cjs.txt');
const FIXTURE_SHA256 = '349026b427f9823913ce48ad43d68935f704f74a28e0a9a485459f455da12fa7';
const CURRENT_BRIDGE = path.resolve(__dirname, '..', 'mcp-bridge.cjs');
const CURRENT_VERSION = /^const BRIDGE_VERSION = '([^']*)';$/m.exec(fs.readFileSync(CURRENT_BRIDGE, 'utf8'))[1];
const TOKEN = 'b'.repeat(64);
const MINUTE = 60 * 1000;

const apiSource = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');
function snippet(name) {
  const start = apiSource.indexOf(`// BEGIN ${name}`);
  const end = apiSource.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `marker missing: ${name}`);
  return apiSource.slice(start, end);
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${['COMPOSE HELPERS', 'BRIDGE COMPAT'].map(snippet).join('\n')}
this.x = {
  versionCoreOf, parseBridgeHeader, bridgeCompatDecision, bridgeRefusalText, bridgeModeRefusal, rememberBridge,
  armBridgeNotice, appendBridgeNotice,
};`, sandbox);
const x = sandbox.x;

const T0 = { minBridge: '0.12.0', modeMin: '0.12.0', floor: '0.0.0' };
const T1 = { minBridge: '0.12.1', modeMin: '0.12.0', floor: '0.12.1' };
const PREFS = { skipReviewBlocked: false, saveDraftEnabled: true };
const TAG = 'https://github.com/commonpost/thunderbird-mcp/releases/tag/v';
const ADVICE_FILE = 'Replace mcp-bridge.cjs with the one from the release page below (or install the .mcpb bundle from it in Claude Desktop), then restart the MCP client.';
const G1 = `Commonpost notice (please tell the user): the MCP bridge does not report its version (0.11 or older); this Thunderbird add-on (version 0.12.0) recommends bridge 0.12.0 or newer. ${ADVICE_FILE} Release page: ${TAG}0.12.0`;
const G5 = `Commonpost (please tell the user): mode "send" needs an MCP bridge of version 0.12.0 or newer, and this bridge does not report its version (0.11 or older): an older bridge stops waiting after 30 s and can report a failure while Thunderbird is still working, which can lead to a second message or draft. Nothing was sent or saved. Use mode "window" for now. ${ADVICE_FILE} Release page: ${TAG}0.12.0`;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()();
  }
});

// The add-on side: what the handler of api.js does with the header, the thresholds and the arguments.
async function startAddOn({ thresholds, extVersion, probeVersion = extVersion }) {
  const clock = { now: 0 };
  const seen = new Map();
  const actions = [];
  const headers = [];
  const extCore = x.versionCoreOf(extVersion);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 403;
        res.end();
        return;
      }
      const message = JSON.parse(body);
      const { id, method, params } = message;
      const raw = req.headers['x-commonpost-bridge'];
      headers.push({ method, header: raw });
      const info = x.parseBridgeHeader(raw);
      const entry = x.rememberBridge(seen, info, clock.now);
      let result;
      if (method === 'initialize') {
        result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'commonpost-mcp', version: probeVersion } };
      } else if (method === 'tools/list') {
        x.armBridgeNotice(entry, clock.now);
        result = { tools: [] };
      } else if (method === 'tools/call') {
        const fail = (text) => ({ content: [{ type: 'text', text: JSON.stringify({ error: text }) }], isError: true });
        if (x.bridgeCompatDecision(info, extCore, thresholds) === 'refuse') {
          result = fail(x.bridgeRefusalText(info, extCore, thresholds));
        } else {
          const refusal = x.bridgeModeRefusal(params.name, params.arguments, info, extCore, thresholds, PREFS);
          if (refusal) {
            result = fail(refusal);
          } else {
            actions.push(params.name);
            result = { content: [{ type: 'text', text: '{"ok":true}' }] };
            x.appendBridgeNotice(result, params.name, params.arguments, info, entry, extCore, thresholds, clock.now);
          }
        }
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result === undefined
        ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }
        : { jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { port: server.address().port, clock, seen, actions, headers };
}

function startBridge(bridgePath, port, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-v0110-'));
  const file = path.join(dir, 'connection.json');
  // 0600: no pid check, as for a connection file written by a host that does not run the add-on process
  fs.writeFileSync(file, JSON.stringify({ port, token: TOKEN }), { mode: 0o600 });
  const cleanEnv = { ...process.env };
  for (const name of ['COMMONPOST_MCP_PACKAGING', 'COMMONPOST_MCP_PROFILE', 'COMMONPOST_MCP_DEBUG']) delete cleanEnv[name];
  const child = spawn(process.execPath, [bridgePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...cleanEnv, COMMONPOST_MCP_CONNECTION_FILE: file, ...env },
  });
  const waiting = new Map();
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    let idx;
    while ((idx = out.indexOf('\n')) !== -1) {
      const response = JSON.parse(out.slice(0, idx));
      out = out.slice(idx + 1);
      waiting.get(response.id)?.(response);
    }
  });
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
    call: (name, args = {}) => send('tools/call', { name, arguments: args }),
  };
}

function oldBridge(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-v0110-file-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridgePath = path.join(dir, 'mcp-bridge.cjs');
  fs.copyFileSync(FIXTURE, bridgePath);
  return startBridge(bridgePath, port);
}

const REPLY = { messageId: 'm', folderPath: 'f', body: 'b' };
const errorOf = (response) => JSON.parse(response.result.content[0].text).error;

describe('the released 0.11.0 bridge', () => {
  it('is the published file, byte for byte', () => {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex'), FIXTURE_SHA256);
  });

  it('sends no header; the notice reaches the user once, then again after a new session and the cooldown', async () => {
    const addOn = await startAddOn({ thresholds: T0, extVersion: '0.12.0' });
    const bridge = oldBridge(addOn.port);
    const first = await bridge.call('listAccounts');
    assert.ok(addOn.headers.length > 0);
    assert.ok(addOn.headers.every((h) => h.header === undefined));
    assert.equal(first.result.content.length, 2);
    assert.equal(first.result.content[1].text, G1);
    assert.equal((await bridge.call('listAccounts')).result.content.length, 1);
    addOn.clock.now = 5 * MINUTE;
    await bridge.list();
    assert.equal((await bridge.call('listAccounts')).result.content.length, 1);
    addOn.clock.now = 11 * MINUTE;
    await bridge.list();
    const again = await bridge.call('listAccounts');
    assert.equal(again.result.content.length, 2);
    assert.equal(again.result.content[1].text, G1);
  });

  it('has mode "send" refused before anything acts, while a direct send and other modes go through', async () => {
    const addOn = await startAddOn({ thresholds: T0, extVersion: '0.12.0' });
    const bridge = oldBridge(addOn.port);
    const refused = await bridge.call('replyToMessage', { ...REPLY, mode: 'send' });
    assert.equal(refused.result.isError, true);
    assert.equal(refused.result.content.length, 1);
    assert.equal(errorOf(refused), G5);
    assert.deepEqual(addOn.actions, []);
    const direct = await bridge.call('replyToMessage', { ...REPLY, mode: 'send', skipReview: true });
    assert.equal(direct.result.isError, undefined);
    assert.equal(direct.result.content.length, 1);
    assert.deepEqual(addOn.actions, ['replyToMessage']);
  });

  it('is refused entirely by an armed security floor, but tools/list still answers', async () => {
    const addOn = await startAddOn({ thresholds: T1, extVersion: '0.12.1' });
    const bridge = oldBridge(addOn.port);
    for (const [name, args] of [['listAccounts', {}], ['sendMail', { to: 'a@example.com', subject: 's', body: 'b', skipReview: true }]]) {
      const response = await bridge.call(name, args);
      assert.equal(response.result.isError, true, name);
      assert.match(errorOf(response), /Nothing was done/);
    }
    assert.deepEqual(addOn.actions, []);
    assert.deepEqual(await bridge.list().then((r) => ({ ...r.result })), { tools: [] });
  });
});

describe('the current bridge', () => {
  const core = CURRENT_VERSION.replace(/[-+].*$/, '');
  const thresholds = { minBridge: core, modeMin: core, floor: '0.0.0' };

  async function run(env) {
    const addOn = await startAddOn({ thresholds, extVersion: '99.0.0' });
    const bridge = startBridge(CURRENT_BRIDGE, addOn.port, env);
    assert.deepEqual({ ...(await bridge.list()).result }, { tools: [] });
    const first = await bridge.call('listAccounts');
    assert.equal(first.result.content.length, 1);
    const sent = await bridge.call('replyToMessage', { ...REPLY, mode: 'send' });
    assert.equal(sent.result.isError, undefined);
    assert.equal(sent.result.content.length, 1);
    assert.deepEqual(addOn.actions, ['listAccounts', 'replyToMessage']);
    assert.ok(addOn.headers.length >= 3);
    return addOn;
  }

  it('announces itself, is judged up to date and may use mode "send"', async () => {
    const addOn = await run({});
    assert.ok(addOn.headers.every((h) => h.header === BRIDGE_HEADER), JSON.stringify(addOn.headers));
    assert.ok([...addOn.seen.values()].every((entry) => entry.packaging === 'file'));
  });

  it('is remembered as installed from the .mcpb bundle when the bundle says so', async () => {
    const addOn = await run({ COMMONPOST_MCP_PACKAGING: 'mcpb' });
    assert.ok([...addOn.seen.values()].every((entry) => entry.packaging === 'mcpb'));
  });
});
