// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';

// COMMONPOST_MCP_READ_ONLY: with 1 or true, the bridge lists only the tools the add-on marks read-only, plus
// getMessage and getMessages without saveAttachments, and refuses any other tools/call before it reaches the add-on.
// Runs the real bridge against a fake add-on that records what it receives.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { readOnlyToolList, SERVER_INSTRUCTIONS } = require('../mcp-bridge.cjs');

const BRIDGE_PATH = path.resolve(__dirname, '..', 'mcp-bridge.cjs');
const TOKEN = 'b'.repeat(64);
const TOOL_RESULT = { content: [{ type: 'text', text: '{"ok":true}' }] };

const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const sideEffect = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const TOOLS = [
  { name: 'listAccounts', description: 'List accounts', inputSchema: { type: 'object', properties: {} }, annotations: ro },
  {
    name: 'getMessage', description: 'Read one message',
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string' }, folderPath: { type: 'string' }, saveAttachments: { type: 'boolean' } },
      required: ['messageId', 'folderPath'],
    },
    annotations: sideEffect,
  },
  {
    name: 'getMessages', description: 'Read several messages',
    inputSchema: { type: 'object', properties: { messages: { type: 'array' }, saveAttachments: { type: 'boolean' } }, required: ['messages'] },
    annotations: sideEffect,
  },
  { name: 'displayMessage', description: 'Show a message', inputSchema: { type: 'object', properties: {} }, annotations: sideEffect },
  {
    name: 'sendMail', description: 'Compose a message',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, attachments: { type: 'array' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  { name: 'deleteContact', description: 'Delete a contact', inputSchema: { type: 'object', properties: {} } },
];

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()();
  }
});

// A fake add-on: lists TOOLS, answers every tools/call, records the calls. The version probe (initialize) gets
// -32601, so no version notice mixes into the results.
async function startFake() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      if (message.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
        return;
      }
      if (message.method === 'tools/call') calls.push(message.params);
      const result = message.method === 'tools/list' ? { tools: JSON.parse(JSON.stringify(TOOLS)) } : TOOL_RESULT;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  cleanups.push(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { port: server.address().port, calls };
}

// The real bridge against the fake add-on (or against a closed port), `env` added to a clean environment.
function startBridge(port, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-read-only-'));
  const file = path.join(dir, 'connection.json');
  fs.writeFileSync(file, JSON.stringify({ port, token: TOKEN, pid: 4242 }), { mode: 0o600 });
  const cleanEnv = { ...process.env };
  for (const name of ['COMMONPOST_MCP_PACKAGING', 'COMMONPOST_MCP_PROFILE', 'COMMONPOST_MCP_DEBUG', 'COMMONPOST_MCP_READ_ONLY']) {
    delete cleanEnv[name];
  }
  const child = spawn(process.execPath, [BRIDGE_PATH], {
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
    const timer = setTimeout(() => reject(new Error('no answer from the bridge')), 15000);
    waiting.set(id, (response) => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    initialize: () => send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
    list: async () => (await send('tools/list', {})).result.tools,
    call: (name, args = {}) => send('tools/call', { name, arguments: args }),
    stderrText: () => stderr,
  };
}

const errorText = (response) => {
  assert.equal(response.result?.isError, true, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text).error;
};

describe('COMMONPOST_MCP_READ_ONLY', () => {
  it('is off by default: every tool is listed and every call reaches the add-on', async () => {
    const fake = await startFake();
    const bridge = startBridge(fake.port);
    assert.deepEqual((await bridge.list()).map((t) => t.name), TOOLS.map((t) => t.name));
    assert.equal((await bridge.call('sendMail', { to: 'a@example.com' })).result.isError, undefined);
    assert.deepEqual(fake.calls.map((c) => c.name), ['sendMail']);
    assert.equal((await bridge.initialize()).result.instructions, SERVER_INSTRUCTIONS);
  });

  for (const value of ['1', 'true']) {
    it(`with ${value}, lists the read-only tools and the reading tools without saveAttachments`, async () => {
      const fake = await startFake();
      const bridge = startBridge(fake.port, { COMMONPOST_MCP_READ_ONLY: value });
      const tools = await bridge.list();
      assert.deepEqual(tools.map((t) => t.name), ['listAccounts', 'getMessage', 'getMessages']);
      const getMessage = tools.find((t) => t.name === 'getMessage');
      assert.deepEqual(Object.keys(getMessage.inputSchema.properties), ['messageId', 'folderPath']);
      assert.deepEqual(getMessage.inputSchema.required, ['messageId', 'folderPath']);
      assert.deepEqual(getMessage.annotations, ro);
      assert.match(getMessage.description, /^Read one message Read-only mode \(COMMONPOST_MCP_READ_ONLY\)/);
      assert.equal(tools.find((t) => t.name === 'getMessages').inputSchema.properties.saveAttachments, undefined);
      assert.equal(bridge.stderrText(), '');
    });
  }

  it('refuses a tool that may change something before it reaches the add-on, naming the variable', async () => {
    const fake = await startFake();
    const bridge = startBridge(fake.port, { COMMONPOST_MCP_READ_ONLY: '1' });
    for (const name of ['sendMail', 'displayMessage', 'deleteContact', 'noSuchTool']) {
      const text = errorText(await bridge.call(name, {}));
      assert.match(text, new RegExp(`^The tool ${name} is not available: the bridge runs in read-only mode \\(COMMONPOST_MCP_READ_ONLY\\)`));
    }
    assert.match(errorText(await bridge.call({ not: 'a name' })), /^This tool is not available/);
    assert.deepEqual(fake.calls, []);
  });

  it('refuses the read-only check before reading an attachment path', async () => {
    const fake = await startFake();
    const bridge = startBridge(fake.port, { COMMONPOST_MCP_READ_ONLY: '1' });
    const text = errorText(await bridge.call('sendMail', { to: 'a@example.com', attachments: [path.join(os.homedir(), '.ssh', 'id_rsa')] }));
    assert.match(text, /read-only mode/);
    assert.deepEqual(fake.calls, []);
  });

  it('lets a read-only tool through, and getMessage or getMessages only without saveAttachments', async () => {
    const fake = await startFake();
    const bridge = startBridge(fake.port, { COMMONPOST_MCP_READ_ONLY: 'true' });
    assert.equal((await bridge.call('listAccounts')).result.isError, undefined);
    assert.equal((await bridge.call('getMessage', { messageId: 'm', folderPath: 'f', saveAttachments: false })).result.isError, undefined);
    assert.equal((await bridge.call('getMessages', { messages: [] })).result.isError, undefined);
    for (const value of [true, 'true', 1]) {
      assert.match(errorText(await bridge.call('getMessage', { messageId: 'm', folderPath: 'f', saveAttachments: value })),
        /^saveAttachments is not available: the bridge runs in read-only mode/);
    }
    assert.match(errorText(await bridge.call('getMessages', { messages: [], saveAttachments: true })), /^saveAttachments is not available/);
    assert.deepEqual(fake.calls.map((c) => c.name), ['listAccounts', 'getMessage', 'getMessages']);
  });

  it('adds one line to the instructions', async () => {
    const fake = await startFake();
    const bridge = startBridge(fake.port, { COMMONPOST_MCP_READ_ONLY: '1' });
    const { instructions } = (await bridge.initialize()).result;
    assert.ok(instructions.startsWith(`${SERVER_INSTRUCTIONS}\nRead-only mode: only tools that change nothing are available`), instructions);
  });

  it('refuses the call when the add-on cannot be asked for its tools', async () => {
    const fake = await startFake();
    const port = fake.port;
    await cleanups.pop()(); // closes the fake: nothing listens on the port any more
    const bridge = startBridge(port, { COMMONPOST_MCP_READ_ONLY: '1' });
    assert.match(errorText(await bridge.call('listAccounts')),
      /^Read-only mode \(COMMONPOST_MCP_READ_ONLY\) could not check this tool, so the call was not made: /);
  });

  it('stays off for 0, false or empty, in silence', async () => {
    for (const value of ['0', 'false', '']) {
      const fake = await startFake();
      const bridge = startBridge(fake.port, { COMMONPOST_MCP_READ_ONLY: value });
      assert.equal((await bridge.list()).length, TOOLS.length, JSON.stringify(value));
      assert.equal(bridge.stderrText(), '', JSON.stringify(value));
    }
  });

  it('stays off for any other value, and says so on stderr without the value, even without debug', async () => {
    for (const value of ['yes', 'TRUE', ' 1', 'on', '${user_config.read_only}', 'value-not-logged-42']) {
      const fake = await startFake();
      const bridge = startBridge(fake.port, { COMMONPOST_MCP_READ_ONLY: value });
      assert.equal((await bridge.list()).length, TOOLS.length, JSON.stringify(value));
      const stderr = bridge.stderrText();
      assert.ok(stderr.includes('COMMONPOST_MCP_READ_ONLY ignored: 1 or true turns read-only mode on; read-only mode is OFF'), stderr);
      assert.ok(!stderr.includes('user_config') && !stderr.includes('value-not-logged-42'), stderr);
    }
  });
});

describe('readOnlyToolList', () => {
  it('keeps read-only tools, rewrites the attachment-saving readers, drops the rest and malformed entries', () => {
    const kept = readOnlyToolList([...TOOLS, null, 'x', { description: 'no name' }, { name: 'r', annotations: { readOnlyHint: 'yes' } }]);
    assert.deepEqual(kept.map((t) => t.name), ['listAccounts', 'getMessage', 'getMessages']);
    assert.equal(kept[0], TOOLS[0], 'a read-only tool is passed on as it is');
    assert.deepEqual(TOOLS[1].inputSchema.properties.saveAttachments, { type: 'boolean' }, 'the original is not changed');
  });

  it('takes anything but an array as no tools, and keeps a reader without a schema or description', () => {
    assert.deepEqual(readOnlyToolList(undefined), []);
    assert.deepEqual(readOnlyToolList({ tools: [] }), []);
    const [bare] = readOnlyToolList([{ name: 'getMessage' }]);
    assert.deepEqual(bare.inputSchema, { type: 'object', properties: {} });
    assert.match(bare.description, /^Read-only mode/);
    assert.equal(bare.annotations.readOnlyHint, true);
  });
});
