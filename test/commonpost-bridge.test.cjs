'use strict';

// Bridge validation:
//  (a) saveDraft attachments are inlined by the bridge like the other tools;
//  (b) UNC / device attachment paths are refused before any filesystem access;
//  (c) connection.json: no symlink; POSIX owner = current uid and mode 0600;
//      Windows: only under the current user's %TEMP%.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ATTACHMENT_TOOLS,
  checkConnectionFileSafety,
  clearConnectionCache,
  discoverConnectionInfo,
  inlineAttachmentPaths,
  isSensitiveFilePath,
  isUncOrDevicePath,
  readConnectionFileVerified,
  MAX_CONNECTION_FILE_BYTES,
  windowsPathAmbiguity,
} = require('../mcp-bridge.cjs');
const vm = require('vm');

describe('(a) attachment tools', () => {
  it('saveDraft is inlined like sendMail, replyToMessage and forwardMessage', () => {
    for (const tool of ['sendMail', 'replyToMessage', 'forwardMessage', 'saveDraft']) {
      assert.ok(ATTACHMENT_TOOLS.has(tool), tool);
    }
  });

  it('a saveDraft path attachment becomes inline base64', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bridge-'));
    try {
      const file = path.join(dir, 'note.txt');
      fs.writeFileSync(file, 'bonjour');
      const args = { to: 'a@example.com', subject: 's', attachments: [file] };
      await inlineAttachmentPaths(args);
      assert.deepEqual(args.attachments, [{ name: 'note.txt', contentType: 'text/plain', base64: Buffer.from('bonjour').toString('base64') }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('(b) UNC and device paths', () => {
  const refused = [
    '\\\\server.example\\share\\report.pdf',
    '\\\\?\\C:\\Users\\user\\Documents\\a.pdf',
    '\\\\.\\PhysicalDrive0',
    '\\\\?\\UNC\\server\\share\\a.pdf',
    '//server.example/share/report.pdf',
    '\\??\\C:\\Windows\\win.ini',
    '/\\host\\share',
  ];
  const allowed = ['C:\\Users\\user\\Documents\\a.pdf', 'C:/Users/user/a.pdf', '/home/u/a.pdf', 'relative\\a.pdf', 'a.pdf'];

  it('detects UNC and device-namespace forms', () => {
    for (const p of refused) assert.equal(isUncOrDevicePath(p), true, p);
    for (const p of allowed) assert.equal(isUncOrDevicePath(p), false, p);
    assert.equal(isUncOrDevicePath(''), false);
    assert.equal(isUncOrDevicePath(null), false);
  });

  it('isSensitiveFilePath blocks them too (kept in sync with the extension)', () => {
    for (const p of refused) assert.equal(isSensitiveFilePath(p), true, p);
  });

  it('inlineAttachmentPaths refuses them before touching the filesystem', async () => {
    for (const p of refused) {
      await assert.rejects(inlineAttachmentPaths({ attachments: [p] }), /UNC or device attachment paths are not allowed/, p);
    }
  });

  it('the extension refuses them in isSensitiveFilePath as well', () => {
    const api = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');
    const block = api.slice(api.indexOf('// BEGIN SENSITIVE ATTACHMENT PATH HELPERS'), api.indexOf('// END SENSITIVE ATTACHMENT PATH HELPERS'));
    assert.match(block, /if \(isUncOrDevicePath\(attachmentPath\)\) return true;/);
    assert.match(block, /normalized\.startsWith\("\/\/"\) \|\| normalized\.startsWith\("\/\?\?\/"\)/);
  });
});

describe('(c) connection.json safety on POSIX', { skip: typeof process.getuid !== 'function' }, () => {
  let root;
  let file;
  const context = () => ({ fsImpl: fs, pathImpl: path, osImpl: os, platform: 'linux', uid: process.getuid() });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-conn-'));
    file = path.join(root, 'connection.json');
    fs.writeFileSync(file, JSON.stringify({ port: 8765, token: 'a'.repeat(64) }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts a 0600 regular file of the current user', () => {
    assert.equal(checkConnectionFileSafety(file, context()), null);
  });

  it('refuses group/other permission bits', () => {
    for (const mode of [0o640, 0o604, 0o644, 0o666]) {
      fs.chmodSync(file, mode);
      assert.match(checkConnectionFileSafety(file, context()), /gives group\/other access/, mode.toString(8));
    }
  });

  it('refuses a file owned by another uid', () => {
    assert.match(checkConnectionFileSafety(file, { ...context(), uid: process.getuid() + 1 }), /owned by uid \d+, not the current uid/);
  });

  it('refuses a symlink, even to a good file', () => {
    const link = path.join(root, 'link.json');
    fs.symlinkSync(file, link);
    assert.match(checkConnectionFileSafety(link, context()), /is a symlink/);
  });

  it('refuses a directory and reports a missing file', () => {
    const dir = path.join(root, 'dir.json');
    fs.mkdirSync(dir);
    assert.match(checkConnectionFileSafety(dir, context()), /not a regular file/);
    assert.equal(checkConnectionFileSafety(path.join(root, 'none.json'), context()), 'file not found');
  });

  it('discovery skips an unsafe connection file and says why', () => {
    const tmpDir = path.join(root, 'tmp');
    const connFile = path.join(tmpDir, 'commonpost-mcp', 'connection.json');
    fs.mkdirSync(path.dirname(connFile), { recursive: true });
    fs.writeFileSync(connFile, JSON.stringify({ port: 8765, token: 'a'.repeat(64) }));
    fs.chmodSync(connFile, 0o644);
    clearConnectionCache();
    const options = {
      env: {}, fsImpl: fs, pathImpl: path, platform: 'linux', uid: process.getuid(),
      osImpl: { tmpdir: () => tmpDir, homedir: () => root }, homeDir: root,
      procRoot: path.join(root, 'proc'), runtimeDir: path.join(root, 'run'),
      processImpl: { env: {}, platform: 'linux' },
    };
    let result = discoverConnectionInfo(options);
    assert.equal(result.candidates.length, 0);
    assert.ok(result.attempts.some((a) => /gives group\/other access/.test(JSON.stringify(a))));
    fs.chmodSync(connFile, 0o600);
    result = discoverConnectionInfo(options);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].data.port, 8765);
  });
});

describe('(c) connection.json safety on Windows (simulated)', () => {
  // Fake Windows filesystem: lstat + realpath over a map of paths.
  function winContext({ entries, temp = 'C:\\Users\\user\\AppData\\Local\\Temp', real = {} }) {
    const key = (p) => path.win32.resolve(p).toLowerCase();
    const map = new Map(Object.entries(entries).map(([p, kind]) => [key(p), kind]));
    const realMap = new Map(Object.entries(real).map(([a, b]) => [key(a), b]));
    const stat = (kind) => ({
      isSymbolicLink: () => kind === 'symlink',
      isFile: () => kind === 'file',
      uid: 0,
      mode: 0o100666, // Windows reports this whatever the ACL
    });
    const fsImpl = {
      lstatSync(p) {
        const kind = map.get(key(p));
        if (!kind) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return stat(kind);
      },
      realpathSync(p) {
        return realMap.get(key(p)) || path.win32.resolve(p);
      },
    };
    fsImpl.realpathSync.native = fsImpl.realpathSync;
    return { fsImpl, pathImpl: path.win32, osImpl: { tmpdir: () => temp }, platform: 'win32', uid: null };
  }
  const good = 'C:\\Users\\user\\AppData\\Local\\Temp\\commonpost-mcp\\connection.json';

  it('accepts the file under the current user %TEMP% (POSIX mode ignored)', () => {
    assert.equal(checkConnectionFileSafety(good, winContext({ entries: { [good]: 'file' } })), null);
  });

  it('compares case-insensitively', () => {
    const upper = good.toUpperCase();
    assert.equal(checkConnectionFileSafety(upper, winContext({ entries: { [upper]: 'file' } })), null);
  });

  it('refuses a file outside %TEMP%, including a look-alike prefix', () => {
    for (const p of ['C:\\Users\\Public\\connection.json', 'C:\\Users\\user\\AppData\\Local\\Temp2\\commonpost-mcp\\connection.json',
      'D:\\connection.json']) {
      assert.match(checkConnectionFileSafety(p, winContext({ entries: { [p]: 'file' } })), /not under the current user's %TEMP%/, p);
    }
  });

  it('refuses a path that resolves elsewhere through a junction', () => {
    const ctx = winContext({ entries: { [good]: 'file' }, real: { [good]: 'C:\\Users\\Public\\other\\connection.json' } });
    assert.match(checkConnectionFileSafety(good, ctx), /not under the current user's %TEMP%/);
  });

  it('refuses a symlink', () => {
    assert.match(checkConnectionFileSafety(good, winContext({ entries: { [good]: 'symlink' } })), /is a symlink/);
  });
});

// connection.json is read through one verified descriptor
// (no path re-open after the checks) and a UNC path is refused before any
// filesystem access.
describe('(c) connection.json read through a verified descriptor (POSIX)', { skip: typeof process.getuid !== 'function' }, () => {
  let root;
  let file;
  const context = (fsImpl = fs) => ({ fsImpl, pathImpl: path, osImpl: os, platform: 'linux', uid: process.getuid() });
  // fs whose lstatSync (only) reports another file's identity: models a replacement
  // between the path checks and the open.
  const fsLstatOf = (other) => new Proxy(fs, {
    get(target, prop) {
      if (prop === 'lstatSync') return () => target.lstatSync(other);
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const fsWith = (overrides) => new Proxy(fs, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-connfd-'));
    file = path.join(root, 'connection.json');
    fs.writeFileSync(file, JSON.stringify({ port: 8765, token: 'b'.repeat(64) }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the checked file', () => {
    assert.deepEqual(JSON.parse(readConnectionFileVerified(file, context())), { port: 8765, token: 'b'.repeat(64) });
  });

  it('refuses when the opened file is not the one that was checked (replaced)', () => {
    const decoy = path.join(root, 'decoy.json');
    fs.writeFileSync(decoy, '{}', { mode: 0o600 });
    assert.throws(() => readConnectionFileVerified(file, context(fsLstatOf(decoy))), /changed while it was being checked/);
  });

  it('refuses a symlink put in place after the lstat (O_NOFOLLOW)', () => {
    const target = path.join(root, 'target.json');
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
    // lstat reports the regular target, as if checked just before the replacement.
    assert.throws(() => readConnectionFileVerified(file, context(fsLstatOf(target))), /is a symlink/);
  });

  it('re-checks owner and mode on the descriptor', () => {
    const realFstat = fs.fstatSync.bind(fs);
    const withOwner = (uid, mode) => fsWith({ fstatSync: (fd) => {
      const st = realFstat(fd);
      return new Proxy(st, { get: (t, k) => (k === 'uid' ? uid : k === 'mode' ? mode : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    } });
    assert.throws(() => readConnectionFileVerified(file, context(withOwner(process.getuid() + 1, 0o100600))), /owned by uid/);
    assert.throws(() => readConnectionFileVerified(file, context(withOwner(process.getuid(), 0o100644))), /gives group\/other access/);
  });

  it('refuses an implausibly large file without reading it', () => {
    fs.writeFileSync(file, ' '.repeat(MAX_CONNECTION_FILE_BYTES + 1));
    let read = false;
    const guarded = fsWith({ readSync: () => { read = true; return 0; } });
    assert.throws(() => readConnectionFileVerified(file, context(guarded)), /not plausible/);
    assert.equal(read, false);
  });

  it('refuses a FIFO without blocking on it', (t) => {
    const fifo = path.join(root, 'fifo.json');
    try {
      require('child_process').execFileSync('mkfifo', [fifo], { stdio: 'ignore' });
    } catch {
      t.skip('mkfifo unavailable');
      return;
    }
    assert.match(checkConnectionFileSafety(fifo, context()), /not a regular file/);
    assert.throws(() => readConnectionFileVerified(fifo, context()), /not a regular file/);
  });

  it('discovery reports the refusal and keeps working afterwards', () => {
    const tmpDir = path.join(root, 'tmp');
    const connFile = path.join(tmpDir, 'commonpost-mcp', 'connection.json');
    fs.mkdirSync(path.dirname(connFile), { recursive: true });
    fs.writeFileSync(connFile, JSON.stringify({ port: 8766, token: 'c'.repeat(64) }), { mode: 0o600 });
    const decoy = path.join(root, 'decoy.json');
    fs.writeFileSync(decoy, '{}', { mode: 0o600 });
    const options = {
      env: {}, pathImpl: path, platform: 'linux', uid: process.getuid(),
      osImpl: { tmpdir: () => tmpDir, homedir: () => root }, homeDir: root,
      procRoot: path.join(root, 'proc'), runtimeDir: path.join(root, 'run'),
      processImpl: { env: {}, platform: 'linux' },
    };
    clearConnectionCache();
    let result = discoverConnectionInfo({ ...options, fsImpl: fsWith({
      lstatSync: (p) => (p === connFile ? fs.lstatSync(decoy) : fs.lstatSync(p)),
    }) });
    assert.equal(result.candidates.length, 0);
    assert.ok(result.attempts.some((a) => /changed while it was being checked/.test(a.reason)), JSON.stringify(result.attempts));
    result = discoverConnectionInfo({ ...options, fsImpl: fs });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].data.port, 8766);
  });
});

describe('(c) connection.json UNC path on Windows (simulated)', () => {
  const untouchable = new Proxy({}, { get: (_t, prop) => () => { throw new Error(`filesystem touched: ${String(prop)}`); } });
  const ctx = { fsImpl: untouchable, pathImpl: path.win32, osImpl: { tmpdir: () => 'C:\\Users\\user\\AppData\\Local\\Temp' },
    platform: 'win32', uid: null };

  it('refuses UNC and device paths before any filesystem call', () => {
    for (const p of ['\\\\server.example\\share\\connection.json', '//server.example/share/connection.json',
      '\\\\?\\UNC\\server\\share\\connection.json', '\\\\.\\pipe\\connection.json', '\\\\?\\C:\\Users\\user\\AppData\\Local\\Temp\\commonpost-mcp\\connection.json']) {
      assert.equal(checkConnectionFileSafety(p, ctx), 'refused: UNC or device path for the connection file', p);
    }
  });

  it('COMMONPOST_MCP_CONNECTION_FILE pointing at a share is refused without touching it', () => {
    clearConnectionCache();
    const result = discoverConnectionInfo({
      env: { COMMONPOST_MCP_CONNECTION_FILE: '\\\\server.example\\share\\connection.json' },
      fsImpl: untouchable, pathImpl: path.win32, platform: 'win32', uid: null,
      osImpl: ctx.osImpl, homeDir: 'C:\\Users\\user', processImpl: { env: {}, platform: 'win32' },
    });
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.attempts.map((a) => a.reason), ['refused: UNC or device path for the connection file']);
  });
});

// The attachment deny-list is lexical. Windows resolves
// some names to another one (alternate data stream, trailing dot/space, 8.3
// short name, compatibility junctions), and a symlinked parent directory
// reaches a denied file under an allowed name. The bridge now also checks the
// REAL path; the Windows forms are refused lexically in both transports.
const WIN_AMBIGUOUS = [
  ['ADS ::$DATA', 'C:\\Users\\g\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x\\logins.json::$DATA', /alternate data stream/],
  ['ADS named stream', 'C:\\Users\\g\\secrets.kdbx:s', /alternate data stream/],
  ['ADS Zone.Identifier', 'C:\\Users\\g\\Downloads\\a.pdf:Zone.Identifier', /alternate data stream/],
  ['trailing dot (directory)', 'C:\\Users\\g\\AppData\\Roaming\\Thunderbird.\\Profiles\\x\\prefs.js', /ending with a dot or a space/],
  ['trailing dot (file)', 'C:\\Users\\g\\keys\\server.pem.', /ending with a dot or a space/],
  ['trailing space (file)', 'C:\\Users\\g\\keys\\server.pem ', /ending with a dot or a space/],
  ['8.3 directory', 'C:\\Users\\g\\AppData\\Roaming\\THUNDE~1\\Profiles\\x\\prefs.js', /8\.3 short-name/],
  ['8.3 parent', 'C:\\Users\\g\\APPDAT~1\\Roaming\\Thunderbird\\profiles.ini', /8\.3 short-name/],
  ['8.3 file', 'C:\\Users\\g\\keys\\SERVER~1.PEM', /8\.3 short-name/],
  ['8.3 forward slashes', 'C:/PROGRA~1/x.pdf', /8\.3 short-name/],
];
const WIN_PLAIN = [
  'C:\\Users\\g\\Documents\\rapport.pdf', 'C:/Users/g/Documents/rapport final (2).pdf', 'C:\\Users\\g\\Documents\\Budget~2.xlsx',
  'C:\\Users\\g\\Documents\\..\\Documents\\a.pdf', '.\\a.pdf', 'C:a.pdf', 'D:\\', 'relative\\dir\\a.pdf', 'C:\\Users\\g\\~$temp.docx',
];
const COMPAT_JUNCTIONS = [
  'C:\\Users\\g\\Application Data\\Thunderbird\\Profiles\\x.default\\prefs.js',
  'C:\\Documents and Settings\\g\\Application Data\\Thunderbird\\profiles.ini',
  'C:\\Users\\g\\Local Settings\\Microsoft\\Credentials\\x',
  'C:\\Users\\g\\Local Settings\\Application Data\\Microsoft\\Vault\\x',
  'C:\\Users\\g\\AppData\\Local\\Application Data\\Microsoft\\Protect\\x',
  'C:\\Users\\All Users\\Microsoft\\Crypto\\RSA\\x',
  'C:\\ProgramData\\Application Data\\Microsoft\\Crypto\\RSA\\x',
  '/private/etc/master.passwd',
  '/private/var/log/system.log',
];

function loadExtensionSensitivePathHelpers() {
  const api = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');
  const start = api.indexOf('// BEGIN SENSITIVE ATTACHMENT PATH HELPERS');
  const end = api.indexOf('// END SENSITIVE ATTACHMENT PATH HELPERS');
  assert.ok(start >= 0 && end > start);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${api.slice(start, end)}
this.isSensitiveFilePath = isSensitiveFilePath; this.windowsPathAmbiguity = windowsPathAmbiguity;`, sandbox);
  return sandbox;
}

describe('(b2) Windows name forms and compatibility junctions', () => {
  it('windowsPathAmbiguity names each ambiguous form', () => {
    for (const [label, p, re] of WIN_AMBIGUOUS) assert.match(windowsPathAmbiguity(p) || '', re, label);
    for (const p of WIN_PLAIN) assert.equal(windowsPathAmbiguity(p), null, p);
  });

  it('isSensitiveFilePath refuses them on Windows only (a colon is a legal POSIX file name character)', () => {
    for (const [label, p] of WIN_AMBIGUOUS) assert.equal(isSensitiveFilePath(p, true), true, label);
    assert.equal(isSensitiveFilePath('/home/u/Pictures/capture 10:00:00.png', false), false);
    assert.equal(isSensitiveFilePath('/home/u/notes.', false), false);
    for (const p of WIN_PLAIN) assert.equal(isSensitiveFilePath(p, true), false, p);
  });

  it('compatibility junction names reach the same denied directories', () => {
    for (const p of COMPAT_JUNCTIONS) {
      assert.equal(isSensitiveFilePath(p, true), true, p);
      assert.equal(isSensitiveFilePath(p, false), true, p);
    }
  });

  it('the extension helper gives the same answers (kept in sync)', () => {
    const ext = loadExtensionSensitivePathHelpers();
    const all = [...WIN_AMBIGUOUS.map(([, p]) => p), ...WIN_PLAIN, ...COMPAT_JUNCTIONS,
      '\\\\host\\share\\a.pdf', '/home/u/.ssh/id_rsa', 'C:\\Users\\g\\AppData\\Roaming\\Thunderbird\\x', '/home/u/a.pdf'];
    for (const p of all) {
      for (const windows of [true, false]) {
        assert.equal(ext.isSensitiveFilePath(p, windows), isSensitiveFilePath(p, windows), `${p} windows=${windows}`);
      }
      assert.equal(ext.windowsPathAmbiguity(p), windowsPathAmbiguity(p), p);
    }
    // Without Services (test sandbox) the extension defaults to non-Windows rules.
    assert.equal(ext.isSensitiveFilePath('C:\\Users\\g\\secrets.kdbx:s'), false);
  });
});

describe('(b2) the real path of an attachment is checked (POSIX)', { skip: process.platform === 'win32' }, () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-real-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('a symlinked PARENT directory into a denied directory is refused', async () => {
    fs.mkdirSync(path.join(root, '.ssh'));
    fs.writeFileSync(path.join(root, '.ssh', 'notes.txt'), 'secret');
    fs.symlinkSync(path.join(root, '.ssh'), path.join(root, 'docs'));
    const lexical = path.join(root, 'docs', 'notes.txt');
    assert.equal(isSensitiveFilePath(lexical), false); // the lexical deny-list alone misses it
    await assert.rejects(inlineAttachmentPaths({ attachments: [lexical] }),
      /Sensitive attachment path blocked: .*docs.*notes\.txt \(resolves to .*\.ssh.*notes\.txt\)/);
  });

  it('a symlinked parent directory to an allowed directory still works, under the given name', async () => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.writeFileSync(path.join(root, 'real', 'a.txt'), 'ok');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
    const args = { attachments: [path.join(root, 'alias', 'a.txt')] };
    await inlineAttachmentPaths(args);
    assert.deepEqual(args.attachments, [{ name: 'a.txt', contentType: 'text/plain', base64: Buffer.from('ok').toString('base64') }]);
  });

  it('the final component must still not be a symlink', async () => {
    fs.writeFileSync(path.join(root, 'target.txt'), 'x');
    fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'link.txt'));
    await assert.rejects(inlineAttachmentPaths({ attachments: [path.join(root, 'link.txt')] }), /symlink/);
  });
});
