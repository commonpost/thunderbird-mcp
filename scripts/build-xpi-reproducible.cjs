#!/usr/bin/env node
/**
 * Reproducible XPI build for Commonpost MCP for Thunderbird.
 *
 *   node scripts/build-xpi-reproducible.cjs            # from the committed tree (git HEAD)
 *   node scripts/build-xpi-reproducible.cjs --from-tree   # from extension/ on disk
 *       (needs COMMONPOST_COMMIT=<sha> and SOURCE_DATE_EPOCH=<seconds>; used
 *        where there is no .git, e.g. an offline sandbox copy)
 *
 * Output: dist/commonpost-mcp-v<version>.xpi and .sha256 (the release asset name)
 *
 * Why not scripts/build-xpi.cjs (upstream): it rewrites manifest.json from
 * package.json, stamps buildinfo.json with the wall-clock time and zips the
 * directory in readdir order, so two builds differ. Here:
 *   - input = the files of extension/ as COMMITTED (git ls-tree / git show),
 *     so untracked or modified files never slip in; parasites (.DS_Store,
 *     Thumbs.db, editor backups, .orig/.rej, dotfiles) are refused;
 *   - buildinfo.json is generated from the commit (hash + commit time);
 *   - entries sorted by path (bytewise), fixed DOS time 1980-01-01 00:00,
 *     no extra fields, no comments, fixed attributes;
 *   - entries are STORED (no compression): the bytes then do not depend on
 *     the zlib version, so any Node version gives the same XPI;
 *   - the manifest is checked (version equals package.json, both read from the same commit, id, update_url,
 *     strict_min_version);
 *   - LICENSE and THIRD-PARTY.md (repository root) are added to the XPI.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const EXPECTED = {
  id: 'commonpost-mcp@commonpost.github.io',
  updateUrl: 'https://commonpost.github.io/thunderbird-mcp/updates.json',
  strictMin: '156.0',
};
const ROOT_FILES = ['LICENSE', 'THIRD-PARTY.md'];
const PARASITE = /(^|\/)(\.[^/]*|Thumbs\.db|desktop\.ini|[^/]*~|[^/]*\.(orig|rej|swp|swo|bak|tmp|log))$/i;

function die(msg) {
  console.error(`build-xpi-reproducible: ${msg}`);
  process.exit(1);
}

function git(args, opts = {}) {
  return execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts });
}

// ---- CRC-32 (IEEE) -------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- deterministic ZIP (stored) -------------------------------------------
const DOS_TIME = 0;          // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(10, 4);          // version needed: 1.0 (stored)
    lh.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
    lh.writeUInt16LE(0, 8);           // method: stored
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(10, 4);          // version made by: MS-DOS, 1.0
    ch.writeUInt16LE(10, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attrs
    ch.writeUInt32LE(0, 38);          // external attrs
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, eocd]);
}

// ---- inputs --------------------------------------------------------------
function readFromGit() {
  const status = git(['status', '--porcelain', '--', 'extension'], { encoding: 'utf8' });
  if (status.trim()) {
    console.warn('build-xpi-reproducible: note: extension/ has uncommitted changes; they are NOT built (HEAD is).');
  }
  const commit = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const epoch = Number(git(['show', '-s', '--format=%ct', 'HEAD'], { encoding: 'utf8' }).trim());
  const list = git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', 'extension/'], { encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const files = [];
  for (const line of list) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line);
    if (!m) die(`unexpected ls-tree line: ${line}`);
    const [, mode, type, sha, p] = m;
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) die(`refusing ${p} (git mode ${mode} ${type})`);
    files.push({ name: p.slice('extension/'.length), data: git(['cat-file', 'blob', sha]) });
  }
  const rootFiles = ROOT_FILES.map((name) => ({ name, data: git(['show', `HEAD:${name}`]) }));
  return { commit, epoch, files, rootFiles, pkg: git(['show', 'HEAD:package.json']) };
}

function readFromTree() {
  const commit = process.env.COMMONPOST_COMMIT || '';
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (!/^[0-9a-f]{40}$/.test(commit) || !Number.isInteger(epoch) || epoch <= 0) {
    die('--from-tree needs COMMONPOST_COMMIT=<40-hex sha> and SOURCE_DATE_EPOCH=<seconds>');
  }
  const base = path.join(ROOT, 'extension');
  const files = [];
  (function walk(dir, prefix) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) die(`refusing symlink ${rel}`);
      if (ent.isDirectory()) walk(full, rel);
      else if (ent.isFile()) files.push({ name: rel, data: fs.readFileSync(full) });
      else die(`refusing special file ${rel}`);
    }
  })(base, '');
  const rootFiles = ROOT_FILES.map((name) => ({ name, data: fs.readFileSync(path.join(ROOT, name)) }));
  return { commit, epoch, files, rootFiles, pkg: fs.readFileSync(path.join(ROOT, 'package.json')) };
}

// ---- main ----------------------------------------------------------------
const fromTree = process.argv.includes('--from-tree');
const { commit, epoch, files, rootFiles, pkg } = fromTree ? readFromTree() : readFromGit();

const byName = new Map();
for (const f of files) {
  if (f.name === 'buildinfo.json') continue; // generated below
  if (PARASITE.test(f.name)) die(`refusing parasite file extension/${f.name}`);
  if (byName.has(f.name)) die(`duplicate entry ${f.name}`);
  byName.set(f.name, f.data);
}
if (!byName.has('manifest.json')) die('extension/manifest.json missing');
for (const f of rootFiles) {
  if (byName.has(f.name)) die(`${f.name} exists in extension/ and at the repository root`);
  byName.set(f.name, f.data);
}

const manifest = JSON.parse(byName.get('manifest.json').toString('utf8'));
const gecko = (manifest.browser_specific_settings || {}).gecko || {};
const pkgVersion = JSON.parse(pkg.toString('utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) die(`manifest version ${manifest.version} is not X.Y.Z`);
if (manifest.version !== pkgVersion) die(`manifest version ${manifest.version}, package.json ${pkgVersion}`);
if (gecko.id !== EXPECTED.id) die(`manifest id ${gecko.id}, expected ${EXPECTED.id}`);
if (gecko.update_url !== EXPECTED.updateUrl) die(`update_url ${gecko.update_url}, expected ${EXPECTED.updateUrl}`);
if (gecko.strict_min_version !== EXPECTED.strictMin) die(`strict_min_version ${gecko.strict_min_version}, expected ${EXPECTED.strictMin}`);

// Deterministic build info (read by the options page: "Build").
const buildInfo = {
  version: `v${manifest.version}`,
  builtAt: new Date(epoch * 1000).toISOString(),
  commit,
};
byName.set('buildinfo.json', Buffer.from(JSON.stringify(buildInfo) + '\n', 'utf8'));

const names = [...byName.keys()].sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
const xpi = buildZip(names.map((name) => ({ name, data: byName.get(name) })));
const sha256 = crypto.createHash('sha256').update(xpi).digest('hex');

const outName = `commonpost-mcp-v${manifest.version}.xpi`;
const outDir = process.env.COMMONPOST_OUT_DIR ? path.resolve(process.env.COMMONPOST_OUT_DIR) : OUT_DIR;
if (process.argv.includes('--print-only')) {
  console.log(`${sha256}  ${outName}  (${xpi.length} bytes, ${names.length} entries, commit ${commit.slice(0, 12)})`);
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, outName), xpi);
fs.writeFileSync(path.join(outDir, `${outName}.sha256`), `${sha256}  ${outName}\n`);
console.log(`${sha256}  ${outName}  (${xpi.length} bytes, ${names.length} entries, commit ${commit.slice(0, 12)})`);
