/**
 * MCP protocol surface: server instructions, tools/list entries, isError results.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const bridge = require('../mcp-bridge.cjs');

const apiSource = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');

function snippet(name) {
  const start = apiSource.indexOf(`// BEGIN ${name}`);
  const end = apiSource.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `marker missing: ${name}`);
  return apiSource.slice(start, end);
}

const sandbox = { btoa: globalThis.btoa };
vm.createContext(sandbox);
vm.runInContext(`${snippet('SERVER INSTRUCTIONS')}
${snippet('INLINE IMAGE CONTENT HELPERS')}
${snippet('MCP TOOL PROTOCOL HELPERS')}
this.api = { MCP_SERVER_INSTRUCTIONS, toolListEntry, isToolErrorResult, toolCallResult, toolCallError, buildToolResultContent };`, sandbox);
const api = sandbox.api;

describe('server instructions', () => {
  it('are identical in the bridge and the extension', () => {
    assert.equal(bridge.SERVER_INSTRUCTIONS, api.MCP_SERVER_INSTRUCTIONS);
  });

  it('stay short enough to be kept in context', () => {
    assert.ok(api.MCP_SERVER_INSTRUCTIONS.length < 1500, `length ${api.MCP_SERVER_INSTRUCTIONS.length}`);
  });

  it('are returned by the bridge on initialize', async () => {
    const res = await bridge.handleMessage(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' },
    }));
    assert.equal(res.result.instructions, bridge.SERVER_INSTRUCTIONS);
  });
});

describe('tools/list entries', () => {
  const entry = (name, crud) => JSON.parse(JSON.stringify(api.toolListEntry({
    name, crud, group: 'messages', title: 'T', description: 'D', inputSchema: { type: 'object' },
  })));

  it('expose title and annotations, not group/crud', () => {
    const e = entry('searchMessages', 'read');
    assert.deepEqual(Object.keys(e).sort(), ['annotations', 'description', 'inputSchema', 'name', 'title']);
    assert.deepEqual(e.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it('set every hint explicitly per crud', () => {
    assert.equal(entry('createContact', 'create').annotations.destructiveHint, false);
    assert.equal(entry('updateFilter', 'update').annotations.destructiveHint, true);
    assert.equal(entry('deleteMessages', 'delete').annotations.destructiveHint, true);
    assert.equal(entry('deleteMessages', 'delete').annotations.readOnlyHint, false);
  });

  it('mark only outbound mail tools as open world', () => {
    for (const name of ['sendMail', 'replyToMessage', 'forwardMessage']) {
      assert.equal(entry(name, 'create').annotations.openWorldHint, true, name);
    }
    assert.equal(entry('saveDraft', 'create').annotations.openWorldHint, false);
  });
});

describe('tool results', () => {
  it('flag { error } results as isError', () => {
    assert.equal(api.toolCallResult({ error: 'Message not found' }).isError, true);
    assert.equal(api.toolCallResult({ success: true, count: 1 }).isError, undefined);
    assert.equal(api.toolCallResult([{ error: 'per item' }]).isError, undefined);
    assert.equal(api.toolCallResult({ success: true, error: 'partial' }).isError, undefined);
  });

  it('wrap messages as a JSON error text block', () => {
    const r = api.toolCallError('Invalid parameters');
    assert.equal(r.isError, true);
    assert.deepEqual(JSON.parse(r.content[0].text), { error: 'Invalid parameters' });
  });

  it('bridge returns attachment failures as isError results', async () => {
    const res = await bridge.handleMessage(JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'sendMail', arguments: { to: 'a@example.com', subject: 's', body: 'b', attachments: ['/etc/shadow'] } },
    }));
    assert.equal(res.id, 7);
    assert.equal(res.error, undefined);
    assert.equal(res.result.isError, true);
    assert.match(JSON.parse(res.result.content[0].text).error, /sensitive|not allowed|denied|blocked/i);
  });
});

describe('result text', () => {
  // Hidden characters are handled by the untrusted-content helpers
  // (test/untrusted-content.test.cjs), before the result is serialized.
  it('is compact, valid JSON, and the bridge leaves it as it is', () => {
    const [block] = api.buildToolResultContent({ subject: 'Hi there', body: 'line 1\nline 2', n: 1 });
    assert.deepEqual({ ...JSON.parse(block.text) }, { subject: 'Hi there', body: 'line 1\nline 2', n: 1 });
    assert.equal(block.text.includes('\n'), false);
    const response = { jsonrpc: '2.0', id: 1, result: { content: [block] } };
    assert.strictEqual(bridge.compactToolResultJsonText(response), response);
  });
});

describe('bridge JSON-RPC error codes', () => {
  // A bridge pinned to a connection file whose port refuses connections
  function runBridge(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codes-'));
    const file = path.join(dir, 'connection.json');
    // 0600: the bridge refuses a connection file that others can read
    fs.writeFileSync(file, JSON.stringify({ port: 1, token: 'a'.repeat(64) }), { mode: 0o600 });
    const child = spawn(process.execPath, [path.resolve(__dirname, '../mcp-bridge.cjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, COMMONPOST_MCP_CONNECTION_FILE: file },
    });
    return new Promise((resolve, reject) => {
      let out = '';
      const done = (fn, value) => { clearTimeout(timer); child.kill(); fs.rmSync(dir, { recursive: true, force: true }); fn(value); };
      const timer = setTimeout(() => done(reject, new Error(`bridge answered only: ${out}`)), 10000);
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const responses = out.split('\n').filter(Boolean);
        if (responses.length >= lines.length) done(resolve, responses.map(l => JSON.parse(l)));
      });
      child.stdin.write(lines.join('\n') + '\n');
    });
  }

  it('answer -32700 for unparsable input, -32603 for internal errors, isError for tool calls', async () => {
    const responses = await runBridge([
      '{"jsonrpc":"2.0","id":1,',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'completion/complete', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'listAccounts', arguments: {} } }),
    ]);
    const byId = new Map(responses.map(r => [r.id, r]));
    assert.equal(byId.get(null).error.code, -32700);
    assert.equal(byId.get(2).error.code, -32603);
    assert.match(byId.get(2).error.message, /ECONNREFUSED/);
    assert.equal(byId.get(3).error, undefined);
    assert.equal(byId.get(3).result.isError, true);
    assert.match(JSON.parse(byId.get(3).result.content[0].text).error, /ECONNREFUSED/);
  });
});
