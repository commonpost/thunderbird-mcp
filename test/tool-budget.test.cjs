/**
 * Tool budget: tools/list size, descriptions, result limits, README coverage and a
 * reviewed snapshot of what clients receive. Update the snapshot with
 * UPDATE_SNAPSHOTS=1 npm test and review the diff.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const apiSource = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');
const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
const snapshotPath = path.resolve(__dirname, 'fixtures/tools-list.snapshot.json');

function snippet(name) {
  const start = apiSource.indexOf(`// BEGIN ${name}`);
  const end = apiSource.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `marker missing: ${name}`);
  return apiSource.slice(start, end);
}

const sandbox = { btoa: globalThis.btoa, getConfiguredGetMessagesLimit: () => 20 };
vm.createContext(sandbox);
vm.runInContext(`${[
  'INLINE ATTACHMENT BASE64 HELPERS', 'OUTBOUND ATTACHMENT LIMITS', 'CONTACT FIELD CONSTANTS', 'FILTER SEARCH TERM HELPERS',
  'INLINE IMAGE CONTENT HELPERS', 'MCP TOOL PROTOCOL HELPERS', 'TOOL SCHEMA BUILDER',
].map(snippet).join('\n')}
this.toolsList = JSON.stringify({ tools: buildTools().map(toolListEntry) });`, sandbox);

const toolsList = JSON.parse(sandbox.toolsList);
const tools = toolsList.tools;
const byName = Object.fromEntries(tools.map(t => [t.name, t]));

// Cursor loads at most 40 tools; 0.10.0 added getFilterConfirmation as the 41st, so a
// Cursor user disables one in the add-on settings. Do not raise this further lightly.
const MAX_TOOLS = 41;
const MAX_TOOL_CHARS = 4000;
const MAX_TOTAL_CHARS = 52000;
const MIN_DESCRIPTION_CHARS = 30;
const BOUNDED_RESULT_TOOLS = {
  listEvents: 'maxResults', listTasks: 'maxResults',
};

describe('tools/list budget', () => {
  it(`exposes at most ${MAX_TOOLS} tools`, () => {
    assert.ok(tools.length <= MAX_TOOLS, `${tools.length} tools`);
  });

  it('keeps every tool and the whole list under the size limits', () => {
    for (const t of tools) {
      const size = JSON.stringify(t).length;
      assert.ok(size <= MAX_TOOL_CHARS, `${t.name}: ${size} chars`);
    }
    assert.ok(sandbox.toolsList.length <= MAX_TOTAL_CHARS, `tools/list: ${sandbox.toolsList.length} chars`);
  });

  it('gives every tool a title, annotations and a real description', () => {
    for (const t of tools) {
      assert.ok(t.title, `${t.name}: title`);
      assert.equal(Object.keys(t.annotations).length, 4, `${t.name}: annotations`);
      assert.ok(t.description.length >= MIN_DESCRIPTION_CHARS, `${t.name}: description too short`);
      assert.equal(t.group, undefined, `${t.name}: internal group leaked`);
      assert.equal(t.crud, undefined, `${t.name}: internal crud leaked`);
    }
  });

  it('describes every parameter', () => {
    for (const t of tools) {
      for (const [key, prop] of Object.entries(t.inputSchema.properties || {})) {
        assert.ok(prop.description, `${t.name}.${key}: description`);
      }
    }
  });

  it('bounds tools that can return large results', () => {
    for (const [name, key] of Object.entries(BOUNDED_RESULT_TOOLS)) {
      const prop = byName[name]?.inputSchema.properties?.[key];
      assert.ok(prop, `${name}.${key} missing`);
      assert.equal(prop.type, 'integer', `${name}.${key}: integer`);
      assert.ok(Number.isFinite(prop.maximum), `${name}.${key}: maximum`);
    }
  });
});

describe('annotations', () => {
  const hints = name => byName[name].annotations;

  it('treat sent mail and saved filter rules as irreversible', () => {
    for (const name of ['sendMail', 'replyToMessage', 'forwardMessage', 'createFilter', 'updateFilter', 'applyFilters']) {
      assert.equal(hints(name).destructiveHint, true, name);
      assert.equal(hints(name).openWorldHint, true, name);
    }
    for (const name of ['saveDraft', 'createContact', 'createEvent', 'createTask', 'createFolder']) {
      assert.equal(hints(name).destructiveHint, false, name);
      assert.equal(hints(name).openWorldHint, false, name);
    }
  });

  it('do not call tools with side effects read-only', () => {
    for (const name of ['getMessage', 'getMessages', 'displayMessage']) {
      assert.deepEqual({ ...hints(name) }, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, name);
    }
    for (const name of ['searchMessages', 'getRecentMessages', 'listFilters', 'listEvents']) {
      assert.equal(hints(name).readOnlyHint, true, name);
    }
  });
});

describe('README coverage', () => {
  it('lists every tool in a tool table', () => {
    for (const t of tools) {
      assert.ok(readme.includes(`| \`${t.name}\` |`), `README table misses ${t.name}`);
    }
  });

  it('states the tool count', () => {
    assert.match(readme, new RegExp(`exposes ${tools.length} tools`));
  });
});

describe('tools/list snapshot', () => {
  it('matches the reviewed snapshot', () => {
    const current = `${JSON.stringify(toolsList, null, 2)}\n`;
    if (process.env.UPDATE_SNAPSHOTS === '1') {
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
      fs.writeFileSync(snapshotPath, current);
      return;
    }
    assert.ok(fs.existsSync(snapshotPath), 'snapshot missing: run UPDATE_SNAPSHOTS=1 npm test');
    assert.equal(current, fs.readFileSync(snapshotPath, 'utf8'),
      'tools/list changed: review and run UPDATE_SNAPSHOTS=1 npm test');
  });
});
