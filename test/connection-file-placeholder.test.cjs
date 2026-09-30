'use strict';

// COMMONPOST_MCP_CONNECTION_FILE holding an unexpanded ${user_config.…} placeholder (a client that
// passes an empty optional field through as text) is ignored: automatic discovery runs instead of
// pinning the bridge to a path that cannot exist. A real path is still a hard pin.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { buildCandidateGroups } = require('../mcp-bridge.cjs');

function groupsFor(value) {
  return buildCandidateGroups({
    env: { COMMONPOST_MCP_CONNECTION_FILE: value },
    platform: 'linux',
    homeDir: path.join(os.tmpdir(), 'cp-placeholder-home'),
    runtimeDir: null,
    uid: 1000,
  });
}

function pinnedPaths(groups) {
  return groups
    .flatMap((g) => g.candidates)
    .filter((c) => c.label === 'COMMONPOST_MCP_CONNECTION_FILE')
    .map((c) => c.path);
}

describe('COMMONPOST_MCP_CONNECTION_FILE placeholder guard', () => {
  it('a real path is a hard pin: one group, stopOnFailure', () => {
    const groups = groupsFor('/home/me/connection.json');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].stopOnFailure, true);
    assert.deepEqual(pinnedPaths(groups), ['/home/me/connection.json']);
  });

  for (const placeholder of ['${user_config.connection_file}', '${user_config.x}']) {
    it(`${placeholder} is ignored and the automatic discovery runs`, () => {
      const groups = groupsFor(placeholder);
      assert.deepEqual(pinnedPaths(groups), []);
      assert.ok(groups.length >= 1);
      assert.ok(groups.some((g) => g.candidates.length > 0), 'automatic candidates expected');
      assert.ok(!groups.flatMap((g) => g.candidates).some((c) => String(c.path).includes('user_config')));
    });
  }

  it('only an exact placeholder is ignored: text around it stays a pinned path', () => {
    const value = '/x/${user_config.connection_file}';
    assert.deepEqual(pinnedPaths(groupsFor(value)), [value]);
  });
});
