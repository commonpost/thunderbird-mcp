// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';

// The MCP client may start before Thunderbird (issue #132). tools/list then answers from the tool cache, or, before the
// first live list, waits a little for Thunderbird and answers with an empty list; the bridge sends
// notifications/tools/list_changed once Thunderbird's list differs from the one answered. No real Thunderbird: a fake
// add-on, and a connection file that appears during the test.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const bridge = require('../mcp-bridge.cjs');

const BRIDGE_PATH = path.resolve(__dirname, '..', 'mcp-bridge.cjs');
const TOKEN = 'd'.repeat(64);
const posix = process.platform !== 'win32';
const BRIDGE_VERSION = /const BRIDGE_VERSION = '([^']+)'/.exec(fs.readFileSync(BRIDGE_PATH, 'utf8'))[1];

const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TOOLS = [
  { name: 'listAccounts', description: 'List accounts', inputSchema: { type: 'object', properties: {} }, annotations: ro },
  {
    name: 'sendMail', description: 'Compose a message', inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];
const MORE_TOOLS = [...TOOLS, { name: 'listFolders', description: 'List folders', inputSchema: { type: 'object' }, annotations: ro }];

const cleanups = [];
afterEach(async () => {
  bridge.stopWatchingForThunderbird();
  while (cleanups.length) {
    await cleanups.pop()();
  }
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake add-on that lists `tools` and records the tools/list requests it gets.
async function startAddon(tools) {
  const lists = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      if (message.method === 'tools/list') {
        lists.push(message.id);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: JSON.parse(JSON.stringify(tools)) } }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  cleanups.push(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { port: server.address().port, lists };
}

function writeConnectionFile(file, port) {
  fs.writeFileSync(file, JSON.stringify({ port, token: TOKEN, pid: process.pid }), { mode: 0o600 });
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await delay(10);
  }
}

const listRequest = (id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' });

describe('tools/list when the client starts before Thunderbird', () => {
  const saved = {};
  let connectionFile;
  let cacheDir;
  let notifications;

  beforeEach(() => {
    for (const name of ['COMMONPOST_MCP_CONNECTION_FILE', 'COMMONPOST_MCP_CACHE_DIR']) saved[name] = process.env[name];
    cleanups.push(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      bridge.coldStart.waitMs = 20000;
      bridge.coldStart.watchMs = 3000;
    });
    connectionFile = path.join(tempDir('commonpost-cold-conn-'), 'connection.json');
    cacheDir = path.join(tempDir('commonpost-cold-cache-'), 'cache');
    process.env.COMMONPOST_MCP_CONNECTION_FILE = connectionFile;
    process.env.COMMONPOST_MCP_CACHE_DIR = cacheDir;
    bridge.clearConnectionCache();
    bridge.resetColdStart();
    notifications = [];
    bridge.setClientNotifier(async (notification) => { notifications.push(notification); });
    cleanups.push(() => bridge.setClientNotifier(null));
  });

  const cacheFile = () => bridge.toolCacheFile(bridge.createDiscoveryContext());

  it('waits for Thunderbird on the first tools/list when nothing is cached, then caches its list', async () => {
    bridge.coldStart.waitMs = 5000;
    const addon = await startAddon(TOOLS);
    setTimeout(() => writeConnectionFile(connectionFile, addon.port), 300);
    const response = await bridge.handleMessage(listRequest(1));
    assert.deepEqual(response.result.tools, TOOLS);

    const written = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    assert.equal(written.format, 1);
    assert.equal(written.bridgeVersion, BRIDGE_VERSION);
    assert.deepEqual(written.tools, TOOLS);
    if (posix) {
      assert.equal(fs.statSync(cacheFile()).mode & 0o777, 0o600);
      assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700);
    }
  });

  it('answers with an empty list after the wait, and sends list_changed once Thunderbird answers', async () => {
    bridge.coldStart.waitMs = 300;
    bridge.coldStart.watchMs = 50;
    const started = Date.now();
    const response = await bridge.handleMessage(listRequest(2));
    assert.ok(Date.now() - started >= 250, 'the first tools/list waits for Thunderbird');
    assert.deepEqual(response, { jsonrpc: '2.0', id: 2, result: { tools: [] } });
    assert.deepEqual(notifications, []);

    const addon = await startAddon(TOOLS);
    writeConnectionFile(connectionFile, addon.port);
    await until(() => notifications.length > 0);
    assert.deepEqual(notifications, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).tools, TOOLS);

    // The watch stops once it has notified.
    const watched = addon.lists.length;
    await delay(200);
    assert.equal(addon.lists.length, watched);
    assert.equal(notifications.length, 1);
    // The client asks again and gets Thunderbird's list.
    assert.deepEqual((await bridge.handleMessage(listRequest(3))).result.tools, TOOLS);
  });

  it('waits only once per bridge process', async () => {
    bridge.coldStart.waitMs = 400;
    await bridge.handleMessage(listRequest(4));
    const started = Date.now();
    const response = await bridge.handleMessage(listRequest(5));
    assert.ok(Date.now() - started < 300, 'a later tools/list does not wait again');
    assert.deepEqual(response.result.tools, []);
  });

  it('makes concurrent first tools/list calls wait together', async () => {
    bridge.coldStart.waitMs = 400;
    const started = Date.now();
    const [first, second] = await Promise.all([bridge.handleMessage(listRequest(13)), bridge.handleMessage(listRequest(14))]);
    assert.ok(Date.now() - started >= 350, 'the second call waits for the same deadline');
    assert.deepEqual([first.result.tools, second.result.tools], [[], []]);
  });

  it('writes the cache again after it was deleted while the bridge runs', async () => {
    const addon = await startAddon(TOOLS);
    writeConnectionFile(connectionFile, addon.port);
    await bridge.handleMessage(listRequest(15));
    fs.rmSync(cacheDir, { recursive: true });
    await bridge.handleMessage(listRequest(16));
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).tools, TOOLS);
  });

  it('answers at once from the cache when Thunderbird is not running', async () => {
    bridge.saveToolCache(TOOLS);
    bridge.resetColdStart();
    bridge.coldStart.waitMs = 5000;
    const started = Date.now();
    const response = await bridge.handleMessage(listRequest(6));
    assert.ok(Date.now() - started < 1000, 'no wait with a cached list');
    assert.deepEqual(response.result.tools, TOOLS);
  });

  it('answers from the cache when the connection file is stale (nothing listening on its port)', async () => {
    bridge.saveToolCache(TOOLS);
    bridge.resetColdStart();
    const addon = await startAddon(TOOLS);
    await cleanups.pop()();
    writeConnectionFile(connectionFile, addon.port);
    const response = await bridge.handleMessage(listRequest(7));
    assert.deepEqual(response.result.tools, TOOLS);
  });

  it('sends no list_changed when Thunderbird lists the tools the client already has', async () => {
    bridge.saveToolCache(TOOLS);
    bridge.resetColdStart();
    bridge.coldStart.watchMs = 50;
    await bridge.handleMessage(listRequest(8));
    const addon = await startAddon(TOOLS);
    writeConnectionFile(connectionFile, addon.port);
    await until(() => addon.lists.includes('commonpost-tool-list-watch'));
    await delay(200);
    assert.deepEqual(notifications, []);
    assert.equal(addon.lists.length, 1, 'the watch stopped after Thunderbird answered');
  });

  it('sends list_changed when Thunderbird lists other tools than the cached ones', async () => {
    bridge.saveToolCache(TOOLS);
    bridge.resetColdStart();
    bridge.coldStart.watchMs = 50;
    assert.deepEqual((await bridge.handleMessage(listRequest(9))).result.tools, TOOLS);
    const addon = await startAddon(MORE_TOOLS);
    writeConnectionFile(connectionFile, addon.port);
    await until(() => notifications.length > 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).tools, MORE_TOOLS);
  });

  it('serves Thunderbird\'s live list over the cached one when it is running', async () => {
    bridge.saveToolCache(TOOLS);
    bridge.resetColdStart();
    const addon = await startAddon(MORE_TOOLS);
    writeConnectionFile(connectionFile, addon.port);
    assert.deepEqual((await bridge.handleMessage(listRequest(10))).result.tools, MORE_TOOLS);
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).tools, MORE_TOOLS);
  });

  it('keeps the error when Thunderbird refuses the token (HTTP 403): a Thunderbird is there', async () => {
    bridge.saveToolCache(TOOLS);
    bridge.resetColdStart();
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(403);
        res.end();
      });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    cleanups.push(() => new Promise((resolve) => { server.close(resolve); }));
    writeConnectionFile(connectionFile, server.address().port);
    await assert.rejects(bridge.handleMessage(listRequest(11)), /Connection failed/);
  });

  it('leaves tool calls failing with "Is Thunderbird running?"', async () => {
    bridge.saveToolCache(TOOLS);
    bridge.resetColdStart();
    const response = await bridge.handleMessage(JSON.stringify({
      jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'listAccounts', arguments: {} },
    }));
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /Is Thunderbird running/);
  });
});

describe('the tool cache file', () => {
  const ctx = (overrides = {}) => bridge.createDiscoveryContext(overrides);

  function cacheIn(dir, body, mode = 0o600) {
    const env = { COMMONPOST_MCP_CACHE_DIR: dir };
    const context = ctx({ env });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(bridge.toolCacheFile(context), typeof body === 'string' ? body : JSON.stringify(body), { mode });
    fs.chmodSync(bridge.toolCacheFile(context), mode);
    return context;
  }
  const good = (tools = TOOLS) => ({ format: 1, bridgeVersion: BRIDGE_VERSION, savedAt: '2026-11-06T00:00:00.000Z', tools });

  it('is read back when it is sound', () => {
    const dir = path.join(tempDir('commonpost-cache-read-'), 'c');
    assert.deepEqual(bridge.loadToolCache(cacheIn(dir, good())), TOOLS);
  });

  it('is read back whatever bridge version wrote it: the list is the add-on\'s', () => {
    const dir = path.join(tempDir('commonpost-cache-version-'), 'c');
    assert.deepEqual(bridge.loadToolCache(cacheIn(dir, { ...good(), bridgeVersion: '0.0.1' })), TOOLS);
  });

  it('is ignored when it does not hold a tool list in this format', () => {
    const cases = {
      'not JSON': '{"format":1,',
      'another format': { ...good(), format: 2 },
      'no tools array': { ...good(), tools: { listAccounts: {} } },
      'an empty list': good([]),
      'a tool without inputSchema': good([{ name: 'listAccounts' }]),
      'an array as inputSchema': good([{ name: 'listAccounts', inputSchema: [] }]),
      'a bad tool name': good([{ name: 'list accounts', inputSchema: {} }]),
      'two tools with one name': good([TOOLS[0], TOOLS[0]]),
      'null': 'null',
    };
    for (const [label, body] of Object.entries(cases)) {
      const dir = path.join(tempDir('commonpost-cache-bad-'), 'c');
      assert.equal(bridge.loadToolCache(cacheIn(dir, body)), null, label);
    }
  });

  it('is ignored when others could have written it (POSIX)', { skip: !posix }, () => {
    const fileDir = path.join(tempDir('commonpost-cache-mode-'), 'c');
    assert.equal(bridge.loadToolCache(cacheIn(fileDir, good(), 0o620)), null, 'group-writable file');

    const dir = path.join(tempDir('commonpost-cache-dirmode-'), 'c');
    const context = cacheIn(dir, good());
    fs.chmodSync(dir, 0o770);
    assert.equal(bridge.loadToolCache(context), null, 'group-writable folder');

    const otherDir = path.join(tempDir('commonpost-cache-uid-'), 'c');
    const other = cacheIn(otherDir, good());
    assert.equal(bridge.loadToolCache({ ...other, uid: other.uid + 1 }), null, 'another owner');
  });

  it('is ignored when it is a symbolic link (POSIX)', { skip: !posix }, () => {
    const root = tempDir('commonpost-cache-link-');
    const real = path.join(root, 'real.json');
    fs.writeFileSync(real, JSON.stringify(good()), { mode: 0o600 });
    const dir = path.join(root, 'c');
    fs.mkdirSync(dir, { mode: 0o700 });
    const context = ctx({ env: { COMMONPOST_MCP_CACHE_DIR: dir } });
    fs.symlinkSync(real, bridge.toolCacheFile(context));
    assert.equal(bridge.loadToolCache(context), null);
  });

  it('is not written for a list that is not worth caching', () => {
    const dir = path.join(tempDir('commonpost-cache-skip-'), 'c');
    const context = ctx({ env: { COMMONPOST_MCP_CACHE_DIR: dir } });
    bridge.resetColdStart();
    for (const tools of [undefined, [], [{ name: 'x' }], 'tools']) bridge.saveToolCache(tools, context);
    assert.equal(fs.existsSync(bridge.toolCacheFile(context)), false);
  });

  it('lives in the user\'s cache folder of each system', () => {
    const dir = (platform, env, homeDir) => bridge.toolCacheDir(ctx({ platform, env, homeDir }));
    assert.equal(dir('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\commonpost-mcp');
    assert.equal(dir('win32', {}, 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\commonpost-mcp');
    assert.equal(dir('win32', { LOCALAPPDATA: 'AppData' }, 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\commonpost-mcp');
    assert.equal(dir('win32', { LOCALAPPDATA: '\\\\server\\share\\u' }, 'C:\\Users\\u'), null, 'a UNC path turns the cache off');
    assert.equal(dir('darwin', {}, '/Users/u'), '/Users/u/Library/Caches/commonpost-mcp');
    assert.equal(dir('linux', {}, '/home/u'), '/home/u/.cache/commonpost-mcp');
    assert.equal(dir('linux', { XDG_CACHE_HOME: '/var/cache/u' }, '/home/u'), '/var/cache/u/commonpost-mcp');
    assert.equal(dir('linux', { XDG_CACHE_HOME: 'cache' }, '/home/u'), '/home/u/.cache/commonpost-mcp');
    assert.equal(dir('linux', { COMMONPOST_MCP_CACHE_DIR: '/tmp/c' }, '/home/u'), '/tmp/c');
    assert.equal(dir('linux', { COMMONPOST_MCP_CACHE_DIR: 'c' }, '/home/u'), null, 'a relative folder turns the cache off');
    assert.equal(dir('linux', {}, ''), null);
  });

  it('has one file for each connection file the bridge is pinned to', () => {
    const name = (env) => path.posix.basename(bridge.toolCacheFile(ctx({ platform: 'linux', env, homeDir: '/home/u' })));
    assert.equal(name({}), 'tools.json');
    const a = name({ COMMONPOST_MCP_CONNECTION_FILE: '/a/connection.json' });
    const b = name({ COMMONPOST_MCP_CONNECTION_FILE: '/b/connection.json' });
    assert.match(a, /^tools-[0-9a-f]{16}\.json$/);
    assert.notEqual(a, b);
  });
});

describe('a cold start through stdio', () => {
  it('lists the cached tools at once, filtered in read-only mode, then sends list_changed', async () => {
    const connectionFile = path.join(tempDir('commonpost-cold-stdio-conn-'), 'connection.json');
    const cacheDir = path.join(tempDir('commonpost-cold-stdio-cache-'), 'c');
    const env = { ...process.env, COMMONPOST_MCP_CONNECTION_FILE: connectionFile, COMMONPOST_MCP_CACHE_DIR: cacheDir, COMMONPOST_MCP_READ_ONLY: '1' };
    bridge.resetColdStart();
    bridge.saveToolCache(TOOLS, bridge.createDiscoveryContext({ env }));

    const child = spawn(process.execPath, [BRIDGE_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env });
    cleanups.push(() => { child.kill(); });
    const lines = [];
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        lines.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await until(() => lines.some((line) => line.id === 2), 5000);
    assert.deepEqual(lines.find((line) => line.id === 1).result.capabilities, { tools: { listChanged: true } });
    assert.deepEqual(lines.find((line) => line.id === 2).result.tools.map((tool) => tool.name), ['listAccounts']);
    // The reason reaches the client's log without COMMONPOST_MCP_DEBUG.
    await until(() => stderr.includes('[commonpost-mcp] tools/list answered with the cached list (1 tools): Connection discovery failed'), 5000);

    const addon = await startAddon(MORE_TOOLS);
    writeConnectionFile(connectionFile, addon.port);
    await until(() => lines.some((line) => line.method === 'notifications/tools/list_changed'), 10000);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    await until(() => lines.some((line) => line.id === 3), 5000);
    assert.deepEqual(lines.find((line) => line.id === 3).result.tools.map((tool) => tool.name), ['listAccounts', 'listFolders']);
  });
});
