/**
 * MCP protocol surface: server instructions, tools/list entries, isError results.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
this.api = { MCP_SERVER_INSTRUCTIONS, toolListEntry, isToolErrorResult, toolCallResult, toolCallError, stripInvisibleUnicode, buildToolResultContent };`, sandbox);
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
    assert.equal(entry('createFilter', 'create').annotations.destructiveHint, false);
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

describe('invisible Unicode in results', () => {
  it('removes zero-width, bidi, BOM and tag characters', () => {
    const hidden = 'Pay\u200Bnow\u2060 \uFEFFplease\u202Egnp.exe\u202C \u2066x\u2069 ok\u{E0049}\u{E0067}\u{E0101}';
    assert.equal(api.stripInvisibleUnicode(hidden), 'Paynow pleasegnp.exe x ok');
  });

  it('keeps ZWJ, ZWNJ and emoji variation selectors', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const persian = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
    const heart = '\u2764\uFE0F';
    assert.equal(api.stripInvisibleUnicode(family + persian + heart), family + persian + heart);
  });

  it('applies to the tool result text and keeps it valid JSON', () => {
    const [block] = api.buildToolResultContent({ subject: 'Hi\u200B there\u202E', n: 1 });
    assert.deepEqual(JSON.parse(block.text), { subject: 'Hi there', n: 1 });
    assert.equal(block.text.includes('\n'), false);
  });
});
