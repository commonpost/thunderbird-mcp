#!/usr/bin/env node
/**
 * Version rules of Commonpost MCP for Thunderbird (Version sync job, and the tag check of the release workflow).
 *
 *   node scripts/check-versions.cjs                       # pull requests and main
 *   node scripts/check-versions.cjs --release-tag vX.Y.Z  # release workflow
 *
 * - package.json, package-lock.json (twice), extension/manifest.json and plugins/claude-code/.claude-plugin/plugin.json
 *   (the Claude Code plugin, whose mcp-bridge.cjs is a copy of the repository's) carry the product version (= the tag).
 * - BRIDGE_VERSION in mcp-bridge.cjs is the release in which the bridge bundle last changed; mcpb/manifest.json
 *   carries it; it is never newer than the product version.
 * - The bridge bundle is mcp-bridge.cjs and the other files of the .mcpb, plus the scripts that build it
 *   (scripts/mcpb-inputs.cjs). Compared with the previous release tag, the BRIDGE_VERSION line and the "version"
 *   line of mcpb/manifest.json left out: unchanged, BRIDGE_VERSION stays; changed, the release pull request sets it
 *   to the new version (until then it stays).
 * - Thresholds: MIN_EXTENSION_VERSION (bridge), MIN_BRIDGE_VERSION and MODE_MIN_BRIDGE_VERSION (add-on) are at most
 *   BRIDGE_VERSION, checked once BRIDGE_VERSION is final; BRIDGE_SECURITY_FLOOR is 0.0.0 or at most
 *   MIN_BRIDGE_VERSION, and arming it must be announced in CHANGELOG.md ("security floor").
 * - CURRENT_BRIDGE_VERSION in extension/mcp_server/api.js (the bridge the add-on shows as the newest) equals
 *   BRIDGE_VERSION.
 * Needs the release tags (actions/checkout: fetch-depth 0 and fetch-tags true). Prints ::error:: lines, exits 1.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VERSION = /^\d+\.\d+\.\d+$/;
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

// The highest vX.Y.Z tag, compared number by number (v0.11.0 > v0.8.3), other than `exclude`; null if none.
function previousReleaseTag(tags, exclude) {
  const releases = tags.filter((t) => RELEASE_TAG.test(t) && t !== exclude);
  releases.sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
  return releases[0] || null;
}

function constant(text, name, quote) {
  const re = new RegExp(`^const ${name} = ${quote}(\\d+\\.\\d+\\.\\d+)${quote};$`, 'm');
  const match = re.exec(text);
  return match ? match[1] : null;
}

// Leaves out the version lines, so that a version change alone is not a change of the bundle.
function normalized(repoPath, data) {
  if (repoPath === 'mcp-bridge.cjs') {
    return Buffer.from(data.toString('utf8').replace(/^const BRIDGE_VERSION = '[^'\n]*';$/m, "const BRIDGE_VERSION = '';"));
  }
  if (repoPath === 'mcpb/manifest.json') {
    return Buffer.from(data.toString('utf8').replace(/^(\s*"version"\s*:\s*)"[^"\n]*"/m, '$1""'));
  }
  return data;
}

function changelogSection(changelog, version) {
  const heading = changelog.includes(`## [${version}]`) ? `## [${version}]` : '## [Unreleased]';
  const start = changelog.indexOf(heading);
  if (start < 0) return '';
  const next = changelog.indexOf('\n## [', start + heading.length);
  return changelog.slice(start, next < 0 ? undefined : next);
}

function main(argv) {
  const root = path.resolve(__dirname, '..');
  const tagIndex = argv.indexOf('--release-tag');
  const releaseTag = tagIndex >= 0 ? argv[tagIndex + 1] : null;
  const errors = [];
  const fail = (msg) => errors.push(msg);
  const read = (p) => fs.readFileSync(path.join(root, p));
  const readText = (p) => read(p).toString('utf8');
  const git = (args) => execFileSync('git', ['-C', root, ...args],
    { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const showAt = (tag, p) => {
    try {
      return git(['show', `${tag}:${p}`]);
    } catch {
      return null;
    }
  };

  // Product version
  const version = JSON.parse(readText('package.json')).version;
  if (!VERSION.test(version || '')) fail(`package.json version ${version} is not X.Y.Z`);
  const lock = JSON.parse(readText('package-lock.json'));
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    fail(`package-lock.json versions (${lock.version}, ${lock.packages?.['']?.version}) must equal package.json ${version}`);
  }
  const addon = JSON.parse(readText('extension/manifest.json')).version;
  if (addon !== version) fail(`extension/manifest.json version ${addon} must equal package.json ${version}`);
  if (releaseTag !== null && releaseTag !== `v${version}`) fail(`tag ${releaseTag} must be v${version} (package.json)`);
  // The Claude Code plugin (plugins/claude-code) carries its own copy of the bridge, which must be the bridge of the
  // repository byte for byte, and the product's version, so that a release reaches plugin users (a plugin whose
  // version does not change is never updated).
  const pluginManifest = 'plugins/claude-code/.claude-plugin/plugin.json';
  if (fs.existsSync(path.join(root, pluginManifest))) {
    const plugin = JSON.parse(readText(pluginManifest)).version;
    if (plugin !== version) fail(`${pluginManifest} version ${plugin} must equal package.json ${version}`);
    if (!read('plugins/claude-code/mcp-bridge.cjs').equals(read('mcp-bridge.cjs'))) {
      fail('plugins/claude-code/mcp-bridge.cjs must be a byte-for-byte copy of mcp-bridge.cjs (cp mcp-bridge.cjs plugins/claude-code/)');
    }
  }

  // Bridge version and thresholds
  const bridgeText = readText('mcp-bridge.cjs');
  const bridge = constant(bridgeText, 'BRIDGE_VERSION', "'");
  const minExtension = constant(bridgeText, 'MIN_EXTENSION_VERSION', "'");
  const apiText = readText('extension/mcp_server/api.js');
  const minBridge = constant(apiText, 'MIN_BRIDGE_VERSION', '"');
  const modeMin = constant(apiText, 'MODE_MIN_BRIDGE_VERSION', '"');
  const floor = constant(apiText, 'BRIDGE_SECURITY_FLOOR', '"');
  const currentBridge = constant(apiText, 'CURRENT_BRIDGE_VERSION', '"');
  const mcpb = JSON.parse(readText('mcpb/manifest.json')).version;
  if (!bridge) fail("mcp-bridge.cjs has no line const BRIDGE_VERSION = 'X.Y.Z';");
  if (!minExtension) fail("mcp-bridge.cjs has no line const MIN_EXTENSION_VERSION = 'X.Y.Z';");
  if (!minBridge || !modeMin || !floor) {
    fail('extension/mcp_server/api.js needs const MIN_BRIDGE_VERSION, MODE_MIN_BRIDGE_VERSION and BRIDGE_SECURITY_FLOOR = "X.Y.Z";');
  }
  if (!currentBridge) {
    fail('extension/mcp_server/api.js needs const CURRENT_BRIDGE_VERSION = "X.Y.Z";');
  } else if (bridge && currentBridge !== bridge) {
    fail(`CURRENT_BRIDGE_VERSION ${currentBridge} in extension/mcp_server/api.js must equal BRIDGE_VERSION ${bridge}`);
  }
  if (bridge && mcpb !== bridge) fail(`mcpb/manifest.json version ${mcpb} must equal BRIDGE_VERSION ${bridge}`);
  if (bridge && VERSION.test(version || '') && compareVersions(bridge, version) > 0) {
    fail(`BRIDGE_VERSION ${bridge} must not be newer than package.json ${version}`);
  }
  if (floor && minBridge && floor !== '0.0.0' && compareVersions(floor, minBridge) > 0) {
    fail(`BRIDGE_SECURITY_FLOOR ${floor} must be 0.0.0 or at most MIN_BRIDGE_VERSION ${minBridge}`);
  }
  if (floor && floor !== '0.0.0') {
    const section = changelogSection(readText('CHANGELOG.md'), version);
    if (!/security floor/i.test(section) || !section.includes(floor)) {
      fail(`BRIDGE_SECURITY_FLOOR is ${floor}: arming the floor must be announced in CHANGELOG.md (the section of ${version}, or Unreleased, must say "security floor" and ${floor})`);
    }
  }

  // Previous release and the bridge bundle
  let tags = [];
  try {
    tags = git(['tag', '--merged', 'HEAD']).toString('utf8').split('\n').map((t) => t.trim()).filter(Boolean);
  } catch (err) {
    fail(`cannot list the tags: ${err.message.split('\n')[0]}`);
  }
  const previous = previousReleaseTag(tags, releaseTag);
  let bundleChanged = null;
  let bundleFinal = false;
  if (!previous) {
    fail('no release tag (vX.Y.Z) found in the history of HEAD: fetch the tags (actions/checkout with fetch-depth: 0 and fetch-tags: true, or git fetch --tags)');
  } else if (bridge && VERSION.test(version || '')) {
    const previousVersion = previous.slice(1);
    const { INPUTS, BUILDERS } = require(path.join(root, 'scripts/mcpb-inputs.cjs'));
    const watched = [...INPUTS.map(([p]) => p), ...BUILDERS];
    const changedFiles = watched.filter((p) => {
      const before = showAt(previous, p);
      return before === null || !normalized(p, before).equals(normalized(p, read(p)));
    });
    bundleChanged = changedFiles.length > 0;
    const previousBridgeText = (showAt(previous, 'mcp-bridge.cjs') || Buffer.alloc(0)).toString('utf8');
    const previousBridge = constant(previousBridgeText, 'BRIDGE_VERSION', "'")
      || JSON.parse((showAt(previous, 'package.json') || Buffer.from('{}')).toString('utf8')).version;
    const order = compareVersions(version, previousVersion);
    if (order < 0) {
      fail(`package.json ${version} is older than the previous release ${previous}`);
    } else if (!bundleChanged) {
      bundleFinal = true;
      if (bridge !== previousBridge) {
        fail(`BRIDGE_VERSION is ${bridge} but the bridge bundle is unchanged since ${previous}: keep ${previousBridge} (a new bridge version needs a change of the bridge or of its bundle)`);
      }
    } else if (order === 0) {
      if (bridge !== previousBridge) {
        fail(`the bridge bundle changed since ${previous}, but BRIDGE_VERSION must stay ${previousBridge} until the release pull request, which sets it to the new version`);
      }
    } else {
      bundleFinal = true;
      if (bridge !== version) {
        fail(`the bridge bundle changed since ${previous} (${changedFiles.join(', ')}): set BRIDGE_VERSION in mcp-bridge.cjs and the version of mcpb/manifest.json to ${version}`);
      }
    }
  }

  // Thresholds against the final bridge version (between releases, a changed bridge keeps the previous number
  // until the release pull request: the thresholds may already name the coming version)
  if (bundleFinal && bridge) {
    for (const [name, value] of [['MIN_EXTENSION_VERSION', minExtension], ['MIN_BRIDGE_VERSION', minBridge], ['MODE_MIN_BRIDGE_VERSION', modeMin]]) {
      if (value && compareVersions(value, bridge) > 0) fail(`${name} ${value} must be at most BRIDGE_VERSION ${bridge}`);
    }
  }

  for (const msg of errors) console.log(`::error::${msg}`);
  if (errors.length) return 1;
  const state = bundleChanged === null ? '' : `, bridge bundle ${bundleChanged ? 'changed' : 'unchanged'} since ${previous}`;
  console.log(`Versions in sync: product ${version}, bridge ${bridge}${state}${bundleFinal ? '' : ' (thresholds checked in the release pull request)'}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { compareVersions, previousReleaseTag, normalized, changelogSection };
