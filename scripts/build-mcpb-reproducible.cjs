#!/usr/bin/env node
/**
 * Reproducible .mcpb build (Claude Desktop bundle) for Commonpost MCP for Thunderbird.
 *
 *   node scripts/build-mcpb-reproducible.cjs              # from the committed tree (git HEAD)
 *   node scripts/build-mcpb-reproducible.cjs --from-tree  # from the files on disk
 *       (used where there is no .git, e.g. an offline sandbox copy)
 *   --print-only                                          # print the hash, write nothing
 *
 * Output: dist/commonpost-mcp-v<BRIDGE_VERSION>.mcpb and .sha256 (COMMONPOST_OUT_DIR overrides dist/)
 *
 * The bundle holds the stdio bridge only (no dependency, no add-on): manifest.json (from mcpb/manifest.json),
 * mcp-bridge.cjs, LICENSE, THIRD-PARTY.md and icon.png (extension/icons/icon-128.png). Like the XPI it is a
 * stored (uncompressed) zip with entries sorted by path and a fixed date (see zip-stored.cjs), built from the
 * committed files only, so two builds give the same bytes on any Node version. It is not signed
 * (`mcpb sign` needs a certificate and adds no trust here); the release carries a build-provenance attestation.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { buildZip } = require('./zip-stored.cjs');

const { INPUTS, ENTRY_POINT } = require('./mcpb-inputs.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');

function die(msg) {
  console.error(`build-mcpb-reproducible: ${msg}`);
  process.exit(1);
}

function readInput(fromTree, repoPath) {
  if (fromTree) return fs.readFileSync(path.join(ROOT, repoPath));
  return execFileSync('git', ['-C', ROOT, 'show', `HEAD:${repoPath}`], { maxBuffer: 64 * 1024 * 1024 });
}

const fromTree = process.argv.includes('--from-tree');
if (!fromTree) {
  const status = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', ...INPUTS.map(([p]) => p)], { encoding: 'utf8' });
  if (status.trim()) {
    console.warn('build-mcpb-reproducible: note: bundle inputs have uncommitted changes; they are NOT built (HEAD is).');
  }
}

const byName = new Map();
for (const [repoPath, name] of INPUTS) {
  let data;
  try {
    data = readInput(fromTree, repoPath);
  } catch (err) {
    die(`cannot read ${repoPath}: ${err.message.split('\n')[0]}`);
  }
  byName.set(name, data);
}

const manifest = JSON.parse(byName.get('manifest.json').toString('utf8'));
const pkgVersion = JSON.parse(readInput(fromTree, 'package.json').toString('utf8')).version;
const bridgeMatch = /^const BRIDGE_VERSION = '([^']*)';/m.exec(byName.get('mcp-bridge.cjs').toString('utf8'));
const bridgeVersion = bridgeMatch ? bridgeMatch[1] : undefined;
if (manifest.manifest_version !== '0.3') die(`manifest_version ${manifest.manifest_version}, expected 0.3`);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) die(`manifest version ${manifest.version} is not X.Y.Z`);
if (manifest.version !== bridgeVersion) {
  die(`mcpb manifest ${manifest.version} and BRIDGE_VERSION ${bridgeVersion} must agree`);
}
const newer = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  const i = [0, 1, 2].find((k) => x[k] !== y[k]);
  return i !== undefined && x[i] > y[i];
};
if (!/^\d+\.\d+\.\d+$/.test(pkgVersion || '') || newer(bridgeVersion, pkgVersion)) {
  die(`BRIDGE_VERSION ${bridgeVersion} must not be newer than package.json ${pkgVersion}`);
}
if (!manifest.server || manifest.server.entry_point !== ENTRY_POINT) {
  die(`server.entry_point ${manifest.server && manifest.server.entry_point}, expected ${ENTRY_POINT}`);
}
if (manifest.user_config !== undefined) die('user_config is not allowed in this bundle');

const names = [...byName.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const zip = buildZip(names.map((name) => ({ name, data: byName.get(name) })));
const sha256 = crypto.createHash('sha256').update(zip).digest('hex');

const outName = `commonpost-mcp-v${manifest.version}.mcpb`;
const outDir = process.env.COMMONPOST_OUT_DIR ? path.resolve(process.env.COMMONPOST_OUT_DIR) : OUT_DIR;
const summary = `${sha256}  ${outName}  (${zip.length} bytes, ${names.length} entries)`;
if (process.argv.includes('--print-only')) {
  console.log(summary);
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, outName), zip);
fs.writeFileSync(path.join(outDir, `${outName}.sha256`), `${sha256}  ${outName}\n`);
console.log(summary);
