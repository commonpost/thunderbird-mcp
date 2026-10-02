#!/usr/bin/env node
/**
 * Release notes of a version, for the release workflow: what the release brings in plain words, how to update, then
 * the section of CHANGELOG.md.
 *
 *   node scripts/release-notes.cjs 0.13.0 > notes.md
 *
 * - "In short" is the text between the "## [version]" heading of CHANGELOG.md and its first "###" heading: a few
 *   lines for a user, not a developer (what is new, what is fixed, what breaks, whether updating is urgent). The
 *   release pull request writes it (RELEASING.md); a release from SUMMARY_REQUIRED_FROM on is refused without it.
 * - The add-on updates itself and the bridge does not, so "How to update" gives the steps for both and says whether
 *   this release changes the bridge: BRIDGE_VERSION in mcp-bridge.cjs is the release in which the bridge last
 *   changed (scripts/check-versions.cjs keeps it so).
 * Prints an ::error:: line and exits 1 when something is missing. `--check` prints nothing (pull requests).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = /^\d+\.\d+\.\d+$/;
const README_URL = 'https://github.com/commonpost/thunderbird-mcp#readme';
// Releases before this one have no summary in CHANGELOG.md.
const SUMMARY_REQUIRED_FROM = '0.13.0';

function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

// The lines under "## [version]" up to the next "## [" heading.
function changelogSection(changelog, version) {
  const out = [];
  let inside = false;
  for (const line of changelog.split('\n')) {
    if (line.startsWith(`## [${version}]`)) {
      inside = true;
      continue;
    }
    if (line.startsWith('## [')) inside = false;
    if (inside) out.push(line);
  }
  return out.join('\n').trim();
}

// A section in two parts: the summary before its first "###" heading, and the rest.
function splitSection(section) {
  const lines = section.split('\n');
  const first = lines.findIndex(line => line.startsWith('### '));
  if (first < 0) return { summary: section.trim(), details: '' };
  return { summary: lines.slice(0, first).join('\n').trim(), details: lines.slice(first).join('\n').trim() };
}

function bridgeVersion(bridgeSource) {
  const match = /^const BRIDGE_VERSION = '(\d+\.\d+\.\d+)';$/m.exec(bridgeSource);
  return match ? match[1] : null;
}

function updateSteps(version, bridge) {
  const changed = bridge === version;
  const bridgeLine = changed
    ? '**This release changes the bridge: update it in every MCP client that uses it.**'
    : `This release ships the same bridge as v${bridge}: a bridge of version ${bridge} needs no update.`;
  return [
    '## How to update',
    '',
    '- **Thunderbird add-on**: it updates itself. To get this version now: Add-ons and Themes, gear menu, Check for ' +
      `Updates, then restart Thunderbird. For a first installation, see the [README](${README_URL}) ` +
      `(\`commonpost-mcp-v${version}.xpi\` below).`,
    `- **MCP bridge**: it is installed in your MCP client and is never updated automatically. ${bridgeLine}`,
    `  - Claude Desktop: download \`commonpost-mcp-v${version}.mcpb\` below and open it with Claude Desktop; if the ` +
      'file does not open there (Windows), use Settings > Extensions > Advanced settings > Install Extension.',
    '  - Other clients (Claude Code, Cursor, VS Code, ...): download `mcp-bridge.cjs` below and put it in place of ' +
      'your copy, then restart the client or reconnect the server (`/mcp` in Claude Code). The path of your copy is ' +
      'in the MCP configuration of the client (Claude Code: `claude mcp get <server name>`).',
    '  - Not sure which bridges you have? The options page of the add-on (section Bridge) lists the bridges that ' +
      'connected, each with its version and "Up to date" or "Update recommended". Claude Desktop and another ' +
      'client on the same computer are two bridges, updated separately.',
    '',
    'The `.sigstore.json` files are provenance attestations, not something to install.',
  ].join('\n');
}

function releaseNotes(version, changelog, bridgeSource) {
  if (!VERSION.test(String(version))) throw new Error(`not a version: ${version}`);
  const bridge = bridgeVersion(bridgeSource);
  if (!bridge) throw new Error('BRIDGE_VERSION not found in mcp-bridge.cjs');
  const section = changelogSection(changelog, version);
  if (!section) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const { summary, details } = splitSection(section);
  if (!summary && compareVersions(version, SUMMARY_REQUIRED_FROM) >= 0) {
    throw new Error(`the section of ${version} in CHANGELOG.md has no summary: write a few plain lines for users ` +
      'between its heading and its first "###" heading (RELEASING.md)');
  }
  const parts = [];
  if (summary) parts.push(`## In short\n\n${summary}`);
  parts.push(updateSteps(version, bridge));
  if (details) parts.push(`## All changes\n\n${details}`);
  return `${parts.join('\n\n')}\n`;
}

function main(argv) {
  const root = path.resolve(__dirname, '..');
  const check = argv.includes('--check');
  try {
    const notes = releaseNotes(
      argv.find(arg => arg !== '--check'),
      fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
      fs.readFileSync(path.join(root, 'mcp-bridge.cjs'), 'utf8')
    );
    if (!check) process.stdout.write(notes);
    return 0;
  } catch (e) {
    process.stderr.write(`::error::${e.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { changelogSection, splitSection, bridgeVersion, updateSteps, releaseNotes, SUMMARY_REQUIRED_FROM };
