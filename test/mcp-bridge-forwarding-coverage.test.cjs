// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';

// The bridge's handling of one JSON-RPC message, in the process of the test: what it answers itself, what it
// refuses before Thunderbird is even needed, how it forwards to the add-on (the token, the bridge header, the
// instances it moves on to when one does not answer) and what it says when the connection fails. The add-on is a
// stand-in HTTP server, and a stand-in for http.request where a failure cannot be made on a real socket.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../mcp-bridge.cjs');

const { handleMessage, clearConnectionCache, readConnectionInfo, tryRequest, SERVER_INSTRUCTIONS } = bridge;

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_C = 'c'.repeat(64);

const line = (message) => JSON.stringify(message);
const call = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const toolText = (response) => JSON.parse(response.result.content[0].text);

let workDir;
let savedConnectionFile;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.homedir() : os.tmpdir(), 'cp-forward-'));
  savedConnectionFile = process.env.COMMONPOST_MCP_CONNECTION_FILE;
  clearConnectionCache();
});

afterEach(() => {
  clearConnectionCache();
  if (savedConnectionFile === undefined) delete process.env.COMMONPOST_MCP_CONNECTION_FILE;
  else process.env.COMMONPOST_MCP_CONNECTION_FILE = savedConnectionFile;
  fs.rmSync(workDir, { recursive: true, force: true });
});

// An add-on that answers every request with `answer(message, request)`: an object (the JSON-RPC reply), a string
// (sent as the raw body), or { status, body }. `requests` records what it received.
async function startAddon(t, answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let message = null;
      try { message = JSON.parse(body); } catch { /* the answer decides */ }
      requests.push({ headers: req.headers, message, body });
      const reply = answer(message, req);
      if (reply && reply.status) {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(reply.body ?? '');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
      }
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { port: server.address().port, requests };
}

// A port nobody listens on.
async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve) => { server.close(resolve); });
  return port;
}

function writeConnection(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ...data }), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

// The connection file named by the environment, as a user who sets COMMONPOST_MCP_CONNECTION_FILE has it.
function pinConnection(data) {
  const file = path.join(workDir, 'pinned', 'connection.json');
  writeConnection(file, data);
  process.env.COMMONPOST_MCP_CONNECTION_FILE = file;
  return file;
}

// The tool calls an add-on stand-in received (leaving out the version probe the bridge starts on its own).
const toolCalls = (addon) => addon.requests.filter((r) => r.message && r.message.method === 'tools/call');

const echo = (message) => ({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });

describe('what the bridge answers itself', () => {
  it('answers initialize with the version asked for when it is known, and the latest one when it is not', async () => {
    for (const version of ['2024-10-07', '2025-06-18', '2025-11-25']) {
      const response = await handleMessage(line({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version } }));
      assert.equal(response.result.protocolVersion, version);
      assert.equal(response.result.instructions, SERVER_INSTRUCTIONS);
      assert.deepEqual(response.result.capabilities, { tools: {} });
      assert.equal(response.result.serverInfo.name, 'commonpost-mcp');
    }
    const future = await handleMessage(line({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }));
    assert.equal(future.result.protocolVersion, '2025-11-25');
  });

  it('refuses initialize without a protocol version in text form', async () => {
    for (const params of [undefined, {}, { protocolVersion: 20251125 }, { protocolVersion: null }]) {
      const response = await handleMessage(line({ jsonrpc: '2.0', id: 3, method: 'initialize', params }));
      assert.deepEqual(response, { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Invalid params: protocolVersion must be a string' } });
    }
  });

  it('answers ping, the empty lists and server/discover without Thunderbird', async () => {
    assert.deepEqual(await handleMessage(line({ jsonrpc: '2.0', id: 4, method: 'ping' })), { jsonrpc: '2.0', id: 4, result: {} });
    assert.deepEqual(await handleMessage(line({ jsonrpc: '2.0', id: 5, method: 'resources/list' })), { jsonrpc: '2.0', id: 5, result: { resources: [] } });
    assert.deepEqual(await handleMessage(line({ jsonrpc: '2.0', id: 6, method: 'prompts/list' })), { jsonrpc: '2.0', id: 6, result: { prompts: [] } });
    assert.deepEqual(await handleMessage(line({ jsonrpc: '2.0', id: 0, method: 'server/discover' })), { jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'Method not found' } });
  });

  it('does not answer a notification, with or without an id, or a message with no id', async () => {
    assert.equal(await handleMessage(line({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
    assert.equal(await handleMessage(line({ jsonrpc: '2.0', id: 7, method: 'notifications/cancelled', params: {} })), null);
    assert.equal(await handleMessage(line({ jsonrpc: '2.0', method: 'tools/list' })), null);
  });

  it('rejects a line that is not JSON', async () => {
    await assert.rejects(handleMessage('{ not json'), SyntaxError);
  });
});

describe('attachments are checked before Thunderbird is needed', () => {
  const errorOf = (response) => {
    assert.equal(response.result.isError, true);
    return toolText(response).error;
  };

  it('refuses attachments that are neither a list nor JSON for one', async () => {
    for (const attachments of ['not json', '{"a":1}', 42, { 0: 'x' }]) {
      const response = await handleMessage(line(call('sendMail', { attachments })));
      assert.equal(errorOf(response), 'attachments must be an array', JSON.stringify(attachments));
    }
  });

  it('refuses a list of more than 20 attachments, given as a list or as JSON text', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `a${i}.txt`, base64: 'QQ==' }));
    assert.equal(errorOf(await handleMessage(line(call('sendMail', { attachments: many })))), 'Attachment count 21 exceeds the 20 attachment limit');
    assert.equal(errorOf(await handleMessage(line(call('saveDraft', { attachments: JSON.stringify(many) })))), 'Attachment count 21 exceeds the 20 attachment limit');
    assert.equal(errorOf(await handleMessage(line(call('replyToMessage', { attachments: Array.from({ length: 21 }, (_, i) => `/data/f${i}.txt`) })))), 'Attachment count 21 exceeds the 20 attachment limit');
  });

  it('refuses a sensitive path, and a path that is not text-safe, before looking for Thunderbird', async () => {
    const response = await handleMessage(line(call('forwardMessage', { attachments: ['/data/ok.txt', '/home/u/.ssh/id_rsa'] })));
    assert.match(errorOf(response), /^Sensitive attachment path blocked: \/home\/u\/\.ssh\/id_rsa$/);
    const empty = await handleMessage(line(call('sendMail', { attachments: ['/data/ok.txt', ''] })));
    assert.equal(errorOf(empty), 'Attachment path must be a non-empty string');
    const traversal = await handleMessage(line(call('sendMail', { attachments: ['/tmp/../etc/passwd'] })));
    assert.equal(errorOf(traversal), 'Sensitive attachment path blocked: /tmp/../etc/passwd');
  });

  it('leaves the attachments of a tool that does not send mail alone, and forwards inline attachments untouched', async (t) => {
    const addon = await startAddon(t, echo);
    pinConnection({ port: addon.port, token: TOKEN_A });
    const inline = { name: 'a.txt', base64: 'QQ==' };
    await handleMessage(line(call('searchMessages', { attachments: 'not json' })));
    await handleMessage(line(call('sendMail', { attachments: [inline, 7, null] })));
    assert.deepEqual(toolCalls(addon).map((r) => r.message.params.arguments), [{ attachments: 'not json' }, { attachments: [inline, 7, null] }]);
  });

  it('inlines a path attachment once Thunderbird is found, and the add-on receives the content', async (t) => {
    const addon = await startAddon(t, echo);
    pinConnection({ port: addon.port, token: TOKEN_A, protectedDirs: [path.join(workDir, 'elsewhere')] });
    const file = path.join(workDir, 'report.txt');
    fs.writeFileSync(file, 'hello');
    const response = await handleMessage(line(call('sendMail', { attachments: [file, { name: 'b.txt', base64: 'Qg==' }] })));
    assert.equal(response.result.isError, undefined);
    const sent = addon.requests.find((r) => r.message.method === 'tools/call').message.params.arguments.attachments;
    assert.deepEqual(sent, [{ name: 'report.txt', contentType: 'text/plain', base64: Buffer.from('hello').toString('base64') }, { name: 'b.txt', base64: 'Qg==' }]);
  });

  it('refuses a path inside a directory the connection file lists as protected', async (t) => {
    const addon = await startAddon(t, echo);
    pinConnection({ port: addon.port, token: TOKEN_A, protectedDirs: [workDir] });
    const file = path.join(workDir, 'mail.txt');
    fs.writeFileSync(file, 'x');
    const response = await handleMessage(line(call('sendMail', { attachments: [file] })));
    assert.match(toolText(response).error, /^Attachment path blocked: files of a Thunderbird profile or mail store can't be attached: /);
    assert.equal(addon.requests.length, 0, 'nothing was forwarded');
  });
});

describe('forwarding to the add-on', () => {
  it('sends the token and the bridge header, and returns the answer as it came', async (t) => {
    const addon = await startAddon(t, (message) => (message.method === 'tools/list'
      ? { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'listAccounts' }] } }
      : { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'commonpost-mcp', version: '0.18.1' } } }));
    pinConnection({ port: addon.port, token: TOKEN_A });
    const response = await handleMessage(line({ jsonrpc: '2.0', id: 9, method: 'tools/list' }));
    assert.deepEqual(response, { jsonrpc: '2.0', id: 9, result: { tools: [{ name: 'listAccounts' }] } });
    const first = addon.requests[0];
    assert.equal(first.headers.authorization, `Bearer ${TOKEN_A}`);
    assert.match(first.headers['x-commonpost-bridge'], /^\d+\.\d+\.\d+; packaging=(file|mcpb)(; profile=[a-z0-9-]+)?$/);
    assert.equal(first.headers['content-type'], 'application/json');
  });

  it('warms the version probe after tools/list only when the answer is a result', async (t) => {
    const withResult = await startAddon(t, (message) => (message.method === 'tools/list'
      ? { jsonrpc: '2.0', id: message.id, result: { tools: [] } }
      : { jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'commonpost-mcp', version: '0.18.1' } } }));
    pinConnection({ port: withResult.port, token: TOKEN_A, pid: 4001 });
    await handleMessage(line({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    for (let i = 0; i < 100 && withResult.requests.length < 2; i++) await new Promise((resolve) => { setTimeout(resolve, 10); });
    assert.deepEqual(withResult.requests.map((r) => r.message.method), ['tools/list', 'initialize']);

    clearConnectionCache();
    const failing = await startAddon(t, (message) => ({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'not ready' } }));
    pinConnection({ port: failing.port, token: TOKEN_B, pid: 4002 });
    const response = await handleMessage(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    assert.equal(response.error.message, 'not ready');
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.deepEqual(failing.requests.map((r) => r.message.method), ['tools/list'], 'no probe after an error');
  });

  it('adds one notice to a result when the add-on is older than the bridge needs, once per connection', async (t) => {
    const notices = [];
    const stderr = t.mock.method(process.stderr, 'write', (text) => { notices.push(String(text)); return true; });
    const addon = await startAddon(t, (message) => (message.method === 'initialize'
      ? { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'commonpost-mcp', version: '0.11.0' } } }
      : echo(message)));
    pinConnection({ port: addon.port, token: TOKEN_A, pid: 4101 });
    const first = await handleMessage(line(call('getMessage', { messageId: 'x' })));
    assert.equal(first.result.content.length, 2);
    assert.match(first.result.content[1].text, /^Commonpost notice \(please tell the user\): the Thunderbird add-on is version 0\.11\.0, older than 0\.12\.0/);
    const second = await handleMessage(line(call('getMessage', { messageId: 'y' }), 2));
    assert.equal(second.result.content.length, 1, 'said once');
    assert.equal(notices.filter((n) => n.includes('Commonpost notice')).length, 1);
    stderr.mock.restore();
  });

  it('says nothing about an add-on that is recent enough, is not the add-on, or does not answer sensibly', async (t) => {
    const cases = [
      { serverInfo: { name: 'commonpost-mcp', version: '0.13.0' } },
      { serverInfo: { name: 'something-else', version: '0.1.0' } },
      { serverInfo: { name: 'commonpost-mcp', version: 'not a version' } },
      { serverInfo: { name: 'commonpost-mcp', version: '0.0.0' } },
      { serverInfo: null },
      null,
    ];
    let pid = 4200;
    for (const result of cases) {
      clearConnectionCache();
      const addon = await startAddon(t, (message) => (message.method === 'initialize' ? { jsonrpc: '2.0', id: 1, result } : echo(message)));
      pinConnection({ port: addon.port, token: TOKEN_A, pid: pid++ });
      const response = await handleMessage(line(call('getMessage', {})));
      assert.equal(response.result.content.length, 1, JSON.stringify(result));
    }
  });

  it('adds no notice to a result without content, and none to a direct send, which stays exactly as Thunderbird said', async (t) => {
    const addon = await startAddon(t, (message) => (message.method === 'initialize'
      ? { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'commonpost-mcp', version: '0.11.0' } } }
      : { jsonrpc: '2.0', id: message.id, result: message.params.name === 'listEvents' ? { events: [] } : { content: [{ type: 'text', text: '{"sent":true}' }] } }));
    pinConnection({ port: addon.port, token: TOKEN_A, pid: 4301 });
    const bare = await handleMessage(line(call('listEvents', {})));
    assert.deepEqual(bare.result, { events: [] });
    const sent = await handleMessage(line(call('sendMail', { skipReview: true, to: 'a@example.com' })));
    assert.deepEqual(sent.result.content, [{ type: 'text', text: '{"sent":true}' }]);
    assert.equal(addon.requests.filter((r) => r.message.method === 'initialize').length, 0, 'a direct send starts no probe');
  });

  it('forwards a tool call that has no arguments at all, for a tool that takes attachments', async (t) => {
    const addon = await startAddon(t, echo);
    pinConnection({ port: addon.port, token: TOKEN_A });
    for (const params of [{ name: 'sendMail' }, { name: 'saveDraft', arguments: null }]) {
      const response = await handleMessage(line({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }));
      assert.equal(response.result.isError, undefined);
    }
    assert.deepEqual(toolCalls(addon).map((r) => r.message.params.name), ['sendMail', 'saveDraft']);
  });

  it('leaves the text of a result alone when it is not JSON, or already compact', () => {
    const plainText = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'first line\nsecond line' }] } };
    assert.equal(bridge.compactToolResultJsonText(plainText), plainText);
    const pretty = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{\n  "a": 1\n}' }, { type: 'image', data: 'x' }] } };
    assert.equal(bridge.compactToolResultJsonText(pretty).result.content[0].text, '{"a":1}');
    assert.equal(bridge.compactToolResultJsonText({ result: {} }).result.content, undefined);
    assert.equal(bridge.compactToolResultJsonText(null), null);
  });

  it('forwards a message with no method of its own (a client answer) like any other', async (t) => {
    const addon = await startAddon(t, (message) => ({ jsonrpc: '2.0', id: message.id, result: {} }));
    pinConnection({ port: addon.port, token: TOKEN_A });
    const response = await handleMessage(line({ jsonrpc: '2.0', id: 'srv-1', result: { roots: [] } }));
    assert.deepEqual(response, { jsonrpc: '2.0', id: 'srv-1', result: {} });
    assert.equal(addon.requests[0].message.result.roots.length, 0);
  });
});

describe('a connection file that cannot be used', () => {
  for (const [label, data, message] of [
    ['a port given as text', { port: '8780', token: TOKEN_A }, /port must be an integer between 1 and 65535/],
    ['a port past 65535', { port: 70000, token: TOKEN_A }, /port must be an integer between 1 and 65535/],
    ['a port that is not whole', { port: 8780.5, token: TOKEN_A }, /port must be an integer between 1 and 65535/],
    ['a negative port', { port: -1, token: TOKEN_A }, /port must be an integer between 1 and 65535/],
    ['a token that is not 64 lowercase hex characters', { port: 8780, token: 'ABC' }, /token must be 64 lowercase hex characters/],
  ]) {
    it(`is refused for ${label}, as an error result for a tool call and as a failure for anything else`, async () => {
      pinConnection(data);
      const response = await handleMessage(line(call('listAccounts', {})));
      assert.equal(response.result.isError, true);
      assert.match(toolText(response).error, message);
      await assert.rejects(handleMessage(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' })), message);
    });
  }

  it('does not forward anything to a port that was refused', async (t) => {
    const addon = await startAddon(t, echo);
    pinConnection({ port: String(addon.port), token: TOKEN_A });
    await handleMessage(line(call('listAccounts', {})));
    assert.equal(addon.requests.length, 0);
  });
});

describe('failures that are and are not retried', () => {
  it('passes on a failure that is no refusal of the connection: an answer that is not JSON', async (t) => {
    const addon = await startAddon(t, () => 'this is not json');
    pinConnection({ port: addon.port, token: TOKEN_A });
    const response = await handleMessage(line(call('listAccounts', {})));
    assert.match(toolText(response).error, /^Invalid JSON from Thunderbird: /);
    assert.equal(addon.requests.length, 1, 'tried once');
  });

  it('sends a request again to the next instance found when the first refuses the connection, or answers 403', async (t) => {
    const live = await startAddon(t, echo);
    const stale = await startAddon(t, () => ({ status: 403, body: '{}' }));
    for (const [label, firstPort, token] of [['refused', await closedPort(), TOKEN_B], ['403', stale.port, TOKEN_C]]) {
      clearConnectionCache();
      const root = fs.mkdtempSync(path.join(workDir, `two-${label}-`));
      const nativeDir = path.join(root, 'native');
      const runtime = path.join(root, 'runtime');
      writeConnection(path.join(nativeDir, 'commonpost-mcp', 'connection.json'), { port: firstPort, token });
      writeConnection(path.join(runtime, 'app', 'org.mozilla.thunderbird', 'commonpost-mcp', 'connection.json'), { port: live.port, token: TOKEN_A });
      delete process.env.COMMONPOST_MCP_CONNECTION_FILE;
      const discovered = readConnectionInfo({
        env: {}, fsImpl: fs, osImpl: { tmpdir: () => nativeDir, homedir: () => '/nonexistent' }, platform: 'linux',
        homeDir: null, runtimeDir: runtime, procRoot: path.join(root, 'noproc'), uid: process.getuid ? process.getuid() : 0,
      });
      assert.equal(discovered.port, firstPort, `${label}: the first instance found is tried first`);
      const before = toolCalls(live).length;
      const response = await handleMessage(line(call('listAccounts', {})));
      assert.equal(response.result.isError, undefined, `${label}: ${JSON.stringify(response)}`);
      assert.equal(toolCalls(live).length, before + 1, `${label}: the next instance answered`);
      assert.equal(toolCalls(live).at(-1).headers.authorization, `Bearer ${TOKEN_A}`);
    }
  });

  it('lists a protected directory once when several instances name it, and covers every instance found', async (t) => {
    const live = await startAddon(t, echo);
    const root = fs.mkdtempSync(path.join(workDir, 'shared-'));
    const nativeDir = path.join(root, 'native');
    const runtime = path.join(root, 'runtime');
    const shared = path.join(root, 'profile');
    writeConnection(path.join(nativeDir, 'commonpost-mcp', 'connection.json'), { port: live.port, token: TOKEN_A, protectedDirs: [shared, '/data/one', 'relative/ignored'] });
    writeConnection(path.join(runtime, 'app', 'org.mozilla.thunderbird', 'commonpost-mcp', 'connection.json'), { port: live.port, token: TOKEN_B, protectedDirs: [shared, '/data/two'] });
    delete process.env.COMMONPOST_MCP_CONNECTION_FILE;
    readConnectionInfo({
      env: {}, fsImpl: fs, osImpl: { tmpdir: () => nativeDir, homedir: () => '/nonexistent' }, platform: 'linux',
      homeDir: null, runtimeDir: runtime, procRoot: path.join(root, 'noproc'), uid: process.getuid ? process.getuid() : 0,
    });
    const { protectedDirs, checkedKeys } = bridge.candidatesProtectedDirs();
    assert.deepEqual(protectedDirs, [shared, '/data/one', '/data/two']);
    assert.deepEqual([...checkedKeys].sort(), [`${live.port}:${TOKEN_A}`, `${live.port}:${TOKEN_B}`].sort());
  });

  it('looks for Thunderbird again once, then says it cannot be reached, with the way to check the add-on', async (t) => {
    const file = pinConnection({ port: await closedPort(), token: TOKEN_A });
    const realRequest = http.request;
    const attempts = [];
    t.mock.method(http, 'request', (...args) => {
      attempts.push(args[0].port);
      return realRequest(...args);
    });
    const response = await handleMessage(line(call('listAccounts', {})));
    assert.match(toolText(response).error, /^Connection failed: connect ECONNREFUSED 127\.0\.0\.1:\d+\. Is Thunderbird running with the MCP extension\? If Thunderbird is running, check that the add-on is enabled;/);
    assert.equal(attempts.length, 2, 'the first try and one after a new look');
    assert.ok(fs.existsSync(file));
  });

  it('says it cannot be reached when the connection file is gone by the time Thunderbird is looked for again', async (t) => {
    const file = pinConnection({ port: await closedPort(), token: TOKEN_A });
    const realRequest = http.request;
    t.mock.method(http, 'request', (...args) => {
      fs.rmSync(file, { force: true });
      return realRequest(...args);
    });
    const response = await handleMessage(line(call('listAccounts', {})));
    assert.match(toolText(response).error, /^Connection failed: connect ECONNREFUSED .* Is Thunderbird running with the MCP extension\?/);
  });

  it('follows an instance that appears at the time of the new look, and checks the attachments against its directories', async (t) => {
    const live = await startAddon(t, echo);
    const strict = await startAddon(t, echo);
    const attachmentDir = path.join(workDir, 'documents');
    fs.mkdirSync(attachmentDir);
    const report = path.join(attachmentDir, 'report.txt');
    fs.writeFileSync(report, 'hello');
    for (const [label, newInstance, refused] of [
      ['unrelated directories', { port: live.port, token: TOKEN_B, protectedDirs: [path.join(workDir, 'profile')] }, false],
      ['the attachment\'s directory', { port: strict.port, token: TOKEN_C, protectedDirs: [attachmentDir] }, true],
    ]) {
      clearConnectionCache();
      const file = pinConnection({ port: await closedPort(), token: TOKEN_A, protectedDirs: [] });
      const realRequest = http.request;
      let swapped = false;
      const mocked = t.mock.method(http, 'request', (...args) => {
        if (!swapped) {
          swapped = true;
          writeConnection(file, newInstance); // a Thunderbird restarted with another profile
        }
        return realRequest(...args);
      });
      const before = { live: toolCalls(live).length, strict: toolCalls(strict).length };
      const response = await handleMessage(line(call('sendMail', { attachments: [report] })));
      mocked.mock.restore();
      if (refused) {
        assert.match(toolText(response).error, /^Attachment path blocked: files of a Thunderbird profile or mail store can't be attached: .* \(resolves to /, label);
        assert.deepEqual({ live: toolCalls(live).length, strict: toolCalls(strict).length }, before, `${label}: nothing reached the new instance`);
      } else {
        assert.equal(response.result.isError, undefined, `${label}: ${JSON.stringify(response)}`);
        assert.equal(toolCalls(live).length, before.live + 1, label);
        assert.equal(toolCalls(strict).length, before.strict, label);
      }
    }
  });
});

// A stand-in for http.request: `plan(call, index)` decides how each request ends.
function mockHttpRequest(t, plan) {
  const calls = [];
  t.mock.method(http, 'request', (options, onResponse) => {
    const req = new EventEmitter();
    const record = { options, body: '', req, onResponse, timeoutMs: null, onTimeout: null, destroyed: false };
    calls.push(record);
    req.write = (data) => { record.body += data; };
    req.setTimeout = (ms, callback) => { record.timeoutMs = ms; record.onTimeout = callback; };
    req.destroy = () => { record.destroyed = true; };
    req.end = () => { setImmediate(() => plan(record, calls.length - 1)); };
    return req;
  });
  return calls;
}

function respond(record, { status = 200, body = '{}', chunks, complete = true }) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.complete = complete;
  record.onResponse(res);
  for (const chunk of chunks || [Buffer.from(body)]) res.emit('data', chunk);
  return res;
}

describe('tryRequest', () => {
  const send = (record) => tryRequest('127.0.0.1', '{"jsonrpc":"2.0","id":1,"method":"ping"}', 8780, TOKEN_A, record);

  it('leaves out the Authorization header when there is no token', async (t) => {
    const addon = await startAddon(t, echo);
    const answer = await tryRequest('127.0.0.1', '{"jsonrpc":"2.0","id":4,"method":"ping"}', addon.port, '');
    assert.equal(answer.id, 4);
    assert.equal('authorization' in addon.requests[0].headers, false);
    assert.ok(addon.requests[0].headers['x-commonpost-bridge']);
  });

  it('says "connection closed" when a direct send loses the connection with an error that says nothing', async (t) => {
    mockHttpRequest(t, (record) => {
      record.req.emit('socket', { connecting: false });
      record.req.emit('error', new Error(''));
    });
    await assert.rejects(send({ timeoutMs: 1000, directSend: true }), /^Error: Connection to Thunderbird was lost \(connection closed\) while sending a message\. The outcome is UNKNOWN/);
  });

  it('names the failure of a direct send by its code, else by its message', async (t) => {
    mockHttpRequest(t, (record, index) => {
      record.req.emit('socket', { connecting: false });
      record.req.emit('error', index === 0 ? Object.assign(new Error('read failed'), { code: 'ECONNRESET' }) : new Error('socket hang up'));
    });
    await assert.rejects(send({ timeoutMs: 1000, directSend: true }), /lost \(ECONNRESET\)/);
    await assert.rejects(send({ timeoutMs: 1000, directSend: true }), /lost \(socket hang up\)/);
  });

  it('only calls the outcome unknown once the connection was made, and not for a request that is no direct send', async (t) => {
    mockHttpRequest(t, (record) => {
      record.req.emit('socket', { connecting: true, once() {} }); // never connects
      record.req.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    });
    await assert.rejects(send({ timeoutMs: 1000, directSend: true }), (e) => e.code === 'ECONNREFUSED');
    await assert.rejects(send({ timeoutMs: 1000, directSend: false }), (e) => e.code === 'ECONNREFUSED');
  });

  it('marks the connection as made when the socket connects later', async (t) => {
    mockHttpRequest(t, (record) => {
      const socket = new EventEmitter();
      socket.connecting = true;
      record.req.emit('socket', socket);
      socket.emit('connect');
      record.req.emit('error', new Error('reset'));
    });
    await assert.rejects(send({ timeoutMs: 1000, directSend: true }), /lost \(reset\)/);
  });

  it('settles once: a timeout after a failure, or a second failure, changes nothing', async (t) => {
    const calls = mockHttpRequest(t, (record) => {
      record.req.emit('socket', { connecting: false });
      record.req.emit('error', new Error('first'));
      record.req.emit('error', new Error('second'));
      record.onTimeout();
    });
    await assert.rejects(send({ timeoutMs: 1000, directSend: false }), /^Error: first$/);
    assert.equal(calls[0].destroyed, true, 'the late timeout still closes the request');
  });

  it('gives a timeout its own wording, for a direct send, a draft and any other call', async (t) => {
    mockHttpRequest(t, (record) => { record.onTimeout(); });
    await assert.rejects(send({ timeoutMs: 30000, directSend: false }), /^Error: Request to Thunderbird timed out$/);
    await assert.rejects(send({ timeoutMs: 180000, directSend: true }), /timed out after 180 s while sending a message\. The outcome is UNKNOWN/);
    await assert.rejects(send({ timeoutMs: 180000, directSend: false, draft: true }), /timed out after 180 s while saving a draft\. The draft may still appear/);
  });

  it('reports a response that stops in the middle, for a direct send only', async (t) => {
    mockHttpRequest(t, (record) => {
      record.req.emit('socket', { connecting: false });
      const res = respond(record, { chunks: [Buffer.from('{"jsonrpc"')], complete: false });
      res.emit('close');
    });
    await assert.rejects(send({ timeoutMs: 1000, directSend: true }), /lost \(response interrupted\)/);
  });

  it('reports an error in the middle of the response of a direct send', async (t) => {
    mockHttpRequest(t, (record) => {
      record.req.emit('socket', { connecting: false });
      const res = respond(record, { chunks: [Buffer.from('{"json')], complete: false });
      res.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    });
    await assert.rejects(send({ timeoutMs: 1000, directSend: true }), /lost \(ECONNRESET\)/);
  });

  it('accepts an answer that has a control character in it, and says what is wrong with one that cannot be parsed', async (t) => {
    mockHttpRequest(t, (record, index) => {
      const res = respond(record, { body: index === 0 ? '{"jsonrpc":"2.0","id":1,"result":{"text":"a\u0001b\nc"}}' : '{"truncated":' });
      res.emit('end');
    });
    const ok = await send({ timeoutMs: 1000, directSend: false });
    assert.equal(ok.result.text, 'ab\nc');
    await assert.rejects(send({ timeoutMs: 1000, directSend: false }), /^Error: Invalid JSON from Thunderbird: /);
  });

  it('gives up on an answer larger than the limit asked for, and closes the request', async (t) => {
    const calls = mockHttpRequest(t, (record) => {
      respond(record, { chunks: [Buffer.alloc(40), Buffer.alloc(40)] });
    });
    await assert.rejects(send({ timeoutMs: 1000, directSend: false, maxBytes: 64 }), /^Error: response too large$/);
    assert.equal(calls[0].destroyed, true);
  });

  it('retries on the other retryable codes: the address cannot be used, the family is not supported', async (t) => {
    const calls = mockHttpRequest(t, (record) => {
      record.req.emit('error', Object.assign(new Error('address unavailable'), { code: record.options.port === 1 ? 'EADDRNOTAVAIL' : 'EAFNOSUPPORT' }));
    });
    await assert.rejects(tryRequest('127.0.0.1', '{}', 1, TOKEN_A), (e) => e.code === 'EADDRNOTAVAIL');
    await assert.rejects(tryRequest('127.0.0.1', '{}', 2, TOKEN_A), (e) => e.code === 'EAFNOSUPPORT');
    assert.equal(calls.length, 2);
  });
});

describe('forwarding when the connection keeps failing in other ways', () => {
  for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
    it(`looks again, then gives up, after ${code}`, async (t) => {
      pinConnection({ port: 49999, token: TOKEN_A });
      const calls = mockHttpRequest(t, (record) => {
        record.req.emit('error', Object.assign(new Error(`socket error ${code}`), { code }));
      });
      const response = await handleMessage(line(call('listAccounts', {})));
      assert.match(toolText(response).error, new RegExp(`^Connection failed: socket error ${code}\\. Is Thunderbird running`));
      assert.equal(calls.length, 2);
    });
  }

  it('does not retry an answer of 403 more than the instances it knows: the failure names the stale token', async (t) => {
    pinConnection({ port: 49998, token: TOKEN_A });
    mockHttpRequest(t, (record) => { respond(record, { status: 403 }).emit('end'); });
    const response = await handleMessage(line(call('listAccounts', {})));
    assert.match(toolText(response).error, /^Connection failed: Authentication failed \(403\)\. Token may be stale\./);
  });

  it('gives a long-running call its own extra sentence when it times out', async (t) => {
    pinConnection({ port: 49997, token: TOKEN_A });
    mockHttpRequest(t, (record) => { record.onTimeout(); });
    const response = await handleMessage(line(call('searchMessages', { query: 'x' })));
    assert.equal(toolText(response).error, 'Request to Thunderbird timed out. The operation may still complete in Thunderbird.');
  });
});
