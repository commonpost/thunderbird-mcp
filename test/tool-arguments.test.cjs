/**
 * Argument coercion and validation as tools/call runs them: the production
 * coerceToolArgs + validateToolArgs against the production tool schemas.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const apiSource = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');

function snippet(name) {
  const start = apiSource.indexOf(`// BEGIN ${name}`);
  const end = apiSource.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `marker missing: ${name}`);
  return apiSource.slice(start, end);
}

const sandbox = { getConfiguredGetMessagesLimit: () => 20, console: { warn() {} } };
vm.createContext(sandbox);
vm.runInContext(`${[
  'INLINE ATTACHMENT BASE64 HELPERS', 'OUTBOUND ATTACHMENT LIMITS', 'CONTACT FIELD CONSTANTS', 'FILTER SEARCH TERM HELPERS',
  'MESSAGE SEARCH HELPERS', 'TOOL SCHEMA BUILDER', 'TOOL SCHEMA VALIDATOR', 'TOOL ARGUMENT CHECKS',
].map(snippet).join('\n')}
this.coerceToolArgs = coerceToolArgs;
this.validateToolArgs = validateToolArgs;`, sandbox);

// What the handler receives, or the errors the caller gets back
function call(name, args) {
  const coerced = sandbox.coerceToolArgs(name, { ...args });
  const errors = [...sandbox.validateToolArgs(name, coerced)];
  return { args: { ...coerced }, errors };
}

const TASK = { taskId: 't1', calendarId: 'c1' };

describe('argument coercion', () => {
  it('turns "true" / "false" into booleans', () => {
    assert.deepEqual(call('searchMessages', { query: 'x', unreadOnly: 'true', flaggedOnly: 'false' }).args,
      { query: 'x', unreadOnly: true, flaggedOnly: false });
  });

  it('turns numeric strings into numbers, but not blank ones', () => {
    assert.equal(call('listEvents', { maxResults: '50' }).args.maxResults, 50);
    const blank = call('listEvents', { maxResults: ' ' });
    assert.equal(blank.args.maxResults, ' ');
    assert.match(blank.errors.join(), /maxResults.*integer/);
  });

  it('parses arrays and objects passed as JSON strings', () => {
    assert.deepEqual([...call('updateMessage', { messageId: 'm', folderPath: 'f', addTags: '["$label1","todo"]' }).args.addTags], ['$label1', 'todo']);
    const messages = call('getMessages', { messages: '[{"messageId":"m","folderPath":"f"}]' });
    assert.deepEqual(Array.from(messages.args.messages, m => ({ ...m })), [{ messageId: 'm', folderPath: 'f' }]);
    assert.deepEqual(messages.errors, []);
    // No tool on main takes a top-level object yet
    const objectTool = vm.createContext({ console: { warn() {} }, buildTools: () => [{ name: 't', inputSchema: {
      type: 'object', properties: { ref: { type: 'object', properties: { id: { type: 'string' } } } },
    } }] });
    vm.runInContext(`${snippet('TOOL SCHEMA VALIDATOR')}\n${snippet('TOOL ARGUMENT CHECKS')}\nthis.coerceToolArgs = coerceToolArgs;`, objectTool);
    assert.deepEqual({ ...objectTool.coerceToolArgs('t', { ref: '{"id":"x"}' }).ref }, { id: 'x' });
    assert.equal(objectTool.coerceToolArgs('t', { ref: '["x"]' }).ref, '["x"]');
    assert.equal(objectTool.coerceToolArgs('t', { ref: '{oops' }).ref, '{oops');
  });

  it('matches enum values case-insensitively', () => {
    const base = { title: 'x', startDate: '2026-01-01T10:00:00Z' };
    assert.deepEqual(call('createEvent', { ...base, status: 'CONFIRMED' }), { args: { ...base, status: 'confirmed' }, errors: [] });
    assert.match(call('createEvent', { ...base, status: 'maybe' }).errors.join(), /status.*one of/);
  });
});

describe('numeric bounds', () => {
  it('clamp a limit above its maximum and floor a fractional one', () => {
    assert.deepEqual(call('listEvents', { maxResults: 5000 }), { args: { maxResults: 500 }, errors: [] });
    assert.deepEqual(call('listTasks', { maxResults: 12.9 }), { args: { maxResults: 12 }, errors: [] });
  });

  it('reject a limit below its minimum', () => {
    assert.deepEqual(call('listEvents', { maxResults: 0 }).errors, ["Parameter 'maxResults' must be >= 1, got 0"]);
  });

  it('reject other out-of-range values instead of clamping them', () => {
    const priority = call('createTask', { title: 'x', priority: 12 });
    assert.equal(priority.args.priority, 12);
    assert.deepEqual(priority.errors, ["Parameter 'priority' must be <= 9, got 12"]);
    assert.deepEqual(call('updateTask', { ...TASK, percentComplete: 150 }).errors, ["Parameter 'percentComplete' must be <= 100, got 150"]);
    assert.deepEqual(call('updateTask', { ...TASK, percentComplete: -1 }).errors, ["Parameter 'percentComplete' must be >= 0, got -1"]);
    assert.deepEqual(call('updateTask', { ...TASK, priority: '12' }).errors, ["Parameter 'priority' must be <= 9, got 12"]);
  });

  it('reject a fractional value that is not a limit', () => {
    assert.match(call('updateTask', { ...TASK, priority: 2.5 }).errors.join(), /priority.*integer/);
  });

  it('accept values on the bounds', () => {
    assert.deepEqual(call('updateTask', { ...TASK, priority: 9, percentComplete: 0 }).errors, []);
    assert.deepEqual(call('updateTask', { ...TASK, priority: 0, percentComplete: 100 }).errors, []);
  });
});
