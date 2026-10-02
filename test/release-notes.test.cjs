'use strict';

// The release page starts with a summary in plain words and the steps to update the add-on and the bridge, written
// by scripts/release-notes.cjs from the version, BRIDGE_VERSION and CHANGELOG.md.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts', 'release-notes.cjs');
const { changelogSection, splitSection, bridgeVersion, minBridgeVersion, releaseNotes, SUMMARY_REQUIRED_FROM } = require(script);

const CHANGELOG = [
  '# Changelog', '', 'Intro.', '',
  '## [Unreleased]', '', '- Not yet.', '',
  '## [1.3.0] - 2027-01-02', '', 'Drafts can be edited. One fix for long messages.', 'Nothing breaks.', '',
  '### Fixed', '', '- A fix in [brackets].', '',
  '## [1.2.0] - 2027-01-01', '', '### Changed', '', '- Older.', '',
].join('\n');
const api = min => `"use strict";\nconst MIN_BRIDGE_VERSION = "${min}";\n`;
const bridge = version => `'use strict';\nconst BRIDGE_VERSION = '${version}';\n`;

describe('release notes', () => {
  it('takes the section of the version from CHANGELOG.md, as the workflow did with awk', () => {
    assert.equal(changelogSection(CHANGELOG, '1.3.0'), 'Drafts can be edited. One fix for long messages.\nNothing breaks.\n\n### Fixed\n\n- A fix in [brackets].');
    assert.equal(changelogSection(CHANGELOG, '1.2.0'), '### Changed\n\n- Older.');
    assert.equal(changelogSection(CHANGELOG, '1.1.0'), '');
  });

  it('splits a section into its summary and its details', () => {
    assert.deepEqual({ ...splitSection('Two\nlines.\n\n### Fixed\n\n- x') }, { summary: 'Two\nlines.', details: '### Fixed\n\n- x' });
    assert.deepEqual({ ...splitSection('### Fixed\n\n- x') }, { summary: '', details: '### Fixed\n\n- x' });
    assert.deepEqual({ ...splitSection('Only a summary.') }, { summary: 'Only a summary.', details: '' });
  });

  it('reads BRIDGE_VERSION from the bridge', () => {
    assert.equal(bridgeVersion(bridge('1.2.0')), '1.2.0');
    assert.equal(bridgeVersion("const BRIDGE_VERSION = require('./package.json').version;"), null);
    assert.match(bridgeVersion(fs.readFileSync(path.join(root, 'mcp-bridge.cjs'), 'utf8')), /^\d+\.\d+\.\d+$/);
  });

  it('puts the summary first, then the update steps with the files of this release, then all changes', () => {
    const notes = releaseNotes('1.3.0', CHANGELOG, bridge('1.3.0'), api('1.3.0'));
    assert.ok(notes.startsWith('## In short\n\nDrafts can be edited. One fix for long messages.\nNothing breaks.\n\n## How to update\n'));
    assert.ok(notes.includes('`commonpost-mcp-v1.3.0.xpi`'));
    assert.ok(notes.includes('`commonpost-mcp-v1.3.0.mcpb`'));
    assert.ok(notes.includes('`mcp-bridge.cjs`'));
    assert.ok(notes.includes('Settings > Extensions > Advanced settings > Install Extension'));
    assert.ok(notes.includes('claude mcp get <server name>'));
    assert.ok(notes.endsWith('\n## All changes\n\n### Fixed\n\n- A fix in [brackets].\n'));
    assert.ok(!notes.includes('Older.') && !notes.includes('Not yet.'));
  });

  it(`refuses a release without a summary from ${SUMMARY_REQUIRED_FROM} on, and accepts the older ones`, () => {
    const bare = version => `## [${version}] - 2027-01-01\n\n### Fixed\n\n- x\n`;
    assert.throws(() => releaseNotes(SUMMARY_REQUIRED_FROM, bare(SUMMARY_REQUIRED_FROM), bridge('0.12.0'), api('0.12.0')), /has no summary: write a few plain lines for users/);
    assert.throws(() => releaseNotes('1.0.0', bare('1.0.0'), bridge('0.12.0'), api('0.12.0')), /has no summary/);
    const old = releaseNotes('0.12.0', bare('0.12.0'), bridge('0.12.0'), api('0.12.0'));
    assert.ok(old.startsWith('## How to update\n') && old.endsWith('## All changes\n\n### Fixed\n\n- x\n'));
  });

  it('says whether this release changes the bridge', () => {
    assert.match(releaseNotes('1.3.0', CHANGELOG, bridge('1.3.0'), api('1.3.0')), /\*\*This release changes the bridge: update it in every MCP client that uses it\.\*\*/);
    const same = releaseNotes('1.3.0', CHANGELOG, bridge('1.2.0'), api('1.2.0'));
    assert.match(same, /This release ships the same bridge as v1\.2\.0: a bridge of version 1\.2\.0 needs no update\./);
    assert.ok(!same.includes('This release changes the bridge'));
  });

  it('reads MIN_BRIDGE_VERSION from api.js', () => {
    assert.equal(minBridgeVersion(api('1.2.0')), '1.2.0');
    assert.equal(minBridgeVersion('const MIN_BRIDGE_VERSION = compute();'), null);
    assert.match(minBridgeVersion(fs.readFileSync(path.join(root, 'extension', 'mcp_server', 'api.js'), 'utf8')), /^\d+\.\d+\.\d+$/);
  });

  it('calls a changed bridge optional when the add-on does not ask for it', () => {
    const optional = releaseNotes('1.3.0', CHANGELOG, bridge('1.3.0'), api('1.2.0'));
    assert.ok(optional.includes('**This release changes the bridge. The update is optional:** a bridge 1.2.0 or newer keeps working with this add-on, and the add-on does not ask for more. Update it to get the bridge changes listed below.'));
    assert.ok(!optional.includes('update it in every MCP client'));
    const same = releaseNotes('1.3.0', CHANGELOG, bridge('1.2.0'), api('1.2.0'));
    assert.ok(!same.includes('optional'));
    assert.ok(optional.includes('"Up to date", "Newer version available" or "Update recommended"'));
  });

  it('refuses an api.js without MIN_BRIDGE_VERSION', () => {
    assert.throws(() => releaseNotes('1.3.0', CHANGELOG, bridge('1.3.0'), 'const x = 1;'), /MIN_BRIDGE_VERSION not found/);
    assert.throws(() => releaseNotes('1.3.0', CHANGELOG, bridge('1.3.0')), /MIN_BRIDGE_VERSION not found/);
  });

  it('refuses a version without a section, a malformed version and a bridge without BRIDGE_VERSION', () => {
    assert.throws(() => releaseNotes('1.1.0', CHANGELOG, bridge('1.1.0'), api('1.1.0')), /CHANGELOG\.md has no section for 1\.1\.0/);
    assert.throws(() => releaseNotes('v1.3.0', CHANGELOG, bridge('1.3.0'), api('1.3.0')), /not a version/);
    assert.throws(() => releaseNotes('1.3.0', CHANGELOG, 'const x = 1;', api('1.3.0')), /BRIDGE_VERSION not found/);
  });

  it('runs on this repository for the last released version', () => {
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const released = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog)[1];
    const out = execFileSync(process.execPath, [script, released], { encoding: 'utf8' });
    assert.ok(out.includes('\n## How to update\n') || out.startsWith('## How to update\n'));
    assert.ok(out.includes(`commonpost-mcp-v${released}.mcpb`));
    assert.ok(out.includes(splitSection(changelogSection(changelog, released)).details));
    assert.equal(execFileSync(process.execPath, [script, released, '--check'], { encoding: 'utf8' }), '');
  });

  it('exits 1 with an ::error:: line for a version that has no section', () => {
    const run = spawnSync(process.execPath, [script, '0.0.1'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^::error::CHANGELOG\.md has no section for 0\.0\.1\n$/);
  });

  it('is what the release workflow calls', () => {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-and-release.yml'), 'utf8');
    assert.ok(workflow.includes('node scripts/release-notes.cjs "$VER" > "$RUNNER_TEMP/notes.md"'));
    assert.ok(workflow.includes('--notes-file "$RUNNER_TEMP/notes.md"'));
  });
});
