'use strict';

// Bridge validation: saveDraft attachments are inlined by the bridge like the other tools; UNC
// and device attachment paths are refused before any filesystem access; connection.json is
// accepted only as a non-symlink file owned by the current user with mode 0600 on POSIX, or (on
// Windows, where POSIX modes do not apply) one that resolves under the current user's %TEMP%.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ATTACHMENT_TOOLS,
  checkConnectionDirSafety,
  checkConnectionFileSafety,
  checkWindowsTempContainment,
  clearConnectionCache,
  discoverConnectionInfo,
  inlineAttachmentPaths,
  inspectAttachmentPath,
  readAttachmentFromPath,
  validateAttachmentStat,
  isSensitiveFilePath,
  isUncOrDevicePath,
  readConnectionFileVerified,
  MAX_CONNECTION_FILE_BYTES,
  windowsPathAmbiguity,
} = require('../mcp-bridge.cjs');
const vm = require('vm');

// Attachment tests need a directory outside the AppData deny-list (which
// os.tmpdir() sits under on Windows, since %TEMP% is AppData\Local\Temp)
// and with no dot-prefixed component, so a path written under it is an
// ordinary, allowed attachment path rather than one the deny-list itself
// would refuse before the test's own assertion runs. Kept in sync with the
// same helper in mcp-bridge.test.cjs.
function makeAttachmentTestRoot() {
  if (process.platform === 'win32') {
    return fs.mkdtempSync(path.join(os.homedir(), 'cp-test-'));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bridge-'));
}

describe('attachment tools', () => {
  it('saveDraft is inlined like sendMail, replyToMessage and forwardMessage', () => {
    for (const tool of ['sendMail', 'replyToMessage', 'forwardMessage', 'saveDraft']) {
      assert.ok(ATTACHMENT_TOOLS.has(tool), tool);
    }
  });

  it('a saveDraft path attachment becomes inline base64', async () => {
    const dir = makeAttachmentTestRoot();
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

describe('UNC and device paths', () => {
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

// On Windows, os.tmpdir() (%TEMP%) sits under AppData\Local, which the
// deny-list treats like the rest of AppData; a caller who just picks a file
// from there hits this without doing anything unusual, so that one case
// gets an error that explains why and what to do, not the generic note the
// other sensitive-path reasons (a dotfile, a credential filename) keep.
describe('AppData / %TEMP% attachment message', () => {
  const appDataPath = path.join('C:', 'Users', 'alice', 'AppData', 'Local', 'Temp', 'report.txt');
  const credentialPath = path.join('C:', 'Users', 'alice', '.ssh', 'id_rsa');

  it('explains the AppData rule and what to do, before touching the filesystem', async () => {
    await assert.rejects(
      inlineAttachmentPaths({ attachments: [appDataPath] }),
      /files under AppData \(on Windows this includes %TEMP%\) can't be attached; copy the file to another folder, for example Documents/
    );
  });

  it('keeps the generic note for a reason that is not the AppData rule', async () => {
    await assert.rejects(inlineAttachmentPaths({ attachments: [credentialPath] }), (error) => {
      assert.match(error.message, /^Sensitive attachment path blocked:/);
      assert.doesNotMatch(error.message, /AppData/);
      return true;
    });
  });

  it('the extension gives the same explanation', () => {
    const api = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');
    const block = api.slice(api.indexOf('// BEGIN SENSITIVE ATTACHMENT PATH HELPERS'), api.indexOf('// END SENSITIVE ATTACHMENT PATH HELPERS'));
    // The source splits the message across two concatenated string literals;
    // check the two halves rather than the one-line text the bridge produces.
    assert.match(block, /files under AppData \(on Windows this includes %TEMP%\) can't be attached/);
    assert.match(block, /copy the file to another folder, for example Documents/);
  });
});

// The commonpost-mcp exemption exists so a saved attachment next to
// connection.json can still be attached -- it must never let connection.json
// itself (a bearer token for the whole mailbox) through, nor apply to a
// commonpost-mcp folder that isn't actually the one under %TEMP%/%tmp%.
describe('the commonpost-mcp exemption never reaches connection.json, and only applies directly under temp', () => {
  const tempCommonpostMcp = 'C:\\Users\\alice\\AppData\\Local\\Temp\\commonpost-mcp';

  it('refuses connection.json even inside the exempt folder', () => {
    assert.equal(isSensitiveFilePath(`${tempCommonpostMcp}\\connection.json`), true);
  });

  it('still allows an ordinary saved attachment in that same folder', () => {
    assert.equal(isSensitiveFilePath(`${tempCommonpostMcp}\\abc123\\a.pdf`), false);
  });

  it('refuses a commonpost-mcp folder that is not directly under temp/tmp', () => {
    assert.equal(isSensitiveFilePath('C:\\Users\\alice\\AppData\\Roaming\\X\\commonpost-mcp\\y'), true);
  });

  it('refuses a path that walks back out of the exempt folder with ..', () => {
    assert.equal(isSensitiveFilePath(`${tempCommonpostMcp}\\..\\secret`), true);
  });

  it('the extension has the same connection.json pattern and the same directly-under-temp exemption', () => {
    const api = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');
    const block = api.slice(api.indexOf('// BEGIN SENSITIVE ATTACHMENT PATH HELPERS'), api.indexOf('// END SENSITIVE ATTACHMENT PATH HELPERS'));
    assert.match(block, /\/\(commonpost-mcp\|thunderbird-mcp\)\\\/connection\\\.json\$\//);
    assert.match(block, /function isExemptCommonpostMcpDir\(components\) \{/);
    assert.match(block, /if \(components\.includes\("\.\."\)\) return false;/);
  });
});

describe('connection.json safety on POSIX', { skip: typeof process.getuid !== 'function' }, () => {
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
    fs.mkdirSync(path.dirname(connFile), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(connFile), 0o700);
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

describe('connection.json safety on Windows (simulated)', () => {
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
describe('connection.json read through a verified descriptor (POSIX)', { skip: typeof process.getuid !== 'function' }, () => {
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
    fs.mkdirSync(path.dirname(connFile), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(connFile), 0o700);
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

// The %TEMP% containment check runs once during discovery
// (checkConnectionFileSafety) and again right before the bytes are read
// (readConnectionFileVerified, via checkWindowsTempContainment): a junction
// along the path can be retargeted in between, so the first pass alone
// cannot be trusted by read time.
describe('connection.json Windows %TEMP% is re-checked at read time (simulated)', () => {
  const temp = 'C:\\Users\\user\\AppData\\Local\\Temp';
  const goodPath = 'C:\\Users\\user\\AppData\\Local\\Temp\\commonpost-mcp\\connection.json';
  const outside = 'C:\\Users\\Public\\other\\connection.json';
  const content = Buffer.from(JSON.stringify({ port: 8765, token: 'd'.repeat(64) }), 'utf8');

  // `real` is mutable so a test can move it mid-flight, modelling a junction
  // retargeted between the discovery-time check and the actual read.
  function winReadContext(real) {
    const stat = { isSymbolicLink: () => false, isFile: () => true, dev: 1, ino: 1, size: content.length };
    const fsImpl = {
      lstatSync: () => stat,
      openSync: () => 3,
      fstatSync: () => stat,
      readSync: (fd, buffer, offset, length) => {
        const n = Math.min(length, content.length);
        content.copy(buffer, offset, 0, n);
        return n;
      },
      closeSync: () => {},
      realpathSync: (p) => (p === temp ? temp : real.current),
    };
    fsImpl.realpathSync.native = fsImpl.realpathSync;
    return { fsImpl, pathImpl: path.win32, osImpl: { tmpdir: () => temp }, platform: 'win32', uid: null };
  }

  it('accepts a read while the real path stays under %TEMP%', () => {
    const real = { current: goodPath };
    const ctx = winReadContext(real);
    assert.equal(checkConnectionFileSafety(goodPath, ctx), null);
    assert.deepEqual(JSON.parse(readConnectionFileVerified(goodPath, ctx)), JSON.parse(content.toString()));
  });

  it('refuses the read when the real path moved outside %TEMP% since the earlier check (junction race)', () => {
    const real = { current: goodPath };
    const ctx = winReadContext(real);
    // Passes the earlier, discovery-time check...
    assert.equal(checkConnectionFileSafety(goodPath, ctx), null);
    // ...then the junction is retargeted before the verified read runs.
    real.current = outside;
    assert.throws(() => readConnectionFileVerified(goodPath, ctx), /not under the current user's %TEMP%/);
  });

  it('checkWindowsTempContainment itself is the function both call sites share', () => {
    const real = { current: outside };
    const ctx = winReadContext(real);
    assert.match(checkWindowsTempContainment(goodPath, ctx), /not under the current user's %TEMP%/);
    real.current = goodPath;
    assert.equal(checkWindowsTempContainment(goodPath, ctx), null);
  });
});

describe('connection.json UNC path on Windows (simulated)', () => {
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
  // Windows compatibility junctions into AppData (N4/N5 follow-up).
  'C:\\Users\\g\\Cookies\\x',
  'C:\\Documents and Settings\\g\\Cookies\\x',
  'C:\\Users\\g\\Recent\\x.lnk',
  'C:\\Users\\g\\SendTo\\x',
  'C:\\Users\\g\\NetHood\\x',
  'C:\\Users\\g\\PrintHood\\x',
  'C:\\Users\\g\\Start Menu\\Programs\\x.lnk',
  'C:\\Users\\g\\Templates\\x.dotx',
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

describe('Windows name forms and compatibility junctions', () => {
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

// A home directory that is not under /Users/ at all: the static pattern
// cannot cover it, so the bridge's own os.homedir() is checked directly.
describe('a home directory outside the conventional /Users/ location is still checked (its own Library)', () => {
  it('refuses a path under os.homedir()/Library, whatever the home directory actually is', () => {
    const realHomedir = os.homedir;
    os.homedir = () => '/opt/customhome/alice';
    try {
      assert.equal(isSensitiveFilePath('/opt/customhome/alice/Library/Mail'), true);
      assert.equal(isSensitiveFilePath('/opt/customhome/alice/Library'), true);
      assert.equal(isSensitiveFilePath('/opt/customhome/alice/Documents/report.pdf'), false);
      // A look-alike prefix is not the home directory itself.
      assert.equal(isSensitiveFilePath('/opt/customhome/alice2/Library/Mail'), false);
    } finally {
      os.homedir = realHomedir;
    }
  });
});

// Windows can itself report the known temp directory (TmpD/os.tmpdir()) with
// an 8.3 short user-profile-name component (GetTempPathW as-is), which is
// not something a caller chose -- the 8.3 check skips however many leading
// components match that known prefix, and only that many.
describe('the 8.3 rule does not fire on the known temp directory itself', () => {
  const shortTemp = 'C:\\Users\\JEANTR~1\\AppData\\Local\\Temp';

  it('allows a path entirely inside the known temp prefix, short name and all', () => {
    assert.equal(windowsPathAmbiguity(`${shortTemp}\\commonpost-mcp\\a.pdf`, shortTemp), null);
  });

  it('still catches an 8.3 component AFTER the known temp prefix', () => {
    assert.match(
      windowsPathAmbiguity(`${shortTemp}\\commonpost-mcp\\REPORT~1.PDF`, shortTemp) || '',
      /8\.3 short-name component/
    );
  });

  it('still catches an 8.3 component when the path is not under the known temp prefix at all', () => {
    assert.match(windowsPathAmbiguity(shortTemp, undefined) || '', /8\.3 short-name component/);
    assert.match(windowsPathAmbiguity('C:\\Users\\JEANTR~1\\Documents\\a.pdf', 'C:\\Users\\alice\\AppData\\Local\\Temp') || '',
      /8\.3 short-name component/);
  });

  it('the extension has the same exemption logic', () => {
    const api = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');
    const start = api.indexOf('function windowsPathAmbiguity(attachmentPath, knownTempDir) {');
    const end = api.indexOf('\n}\n', start);
    assert.ok(start >= 0 && end > start);
    const fn = api.slice(start, end);
    assert.match(fn, /skip8dot3/);
    assert.match(fn, /tempParts\.every\(\(p, i\) => p\.toLowerCase\(\) === parts\[i\]\.toLowerCase\(\)\)/);
  });
});

describe('the real path of an attachment is checked (POSIX)', { skip: process.platform === 'win32' }, () => {
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

// A directory JUNCTION, unlike a symlink, needs no elevated privilege on
// Windows -- so unlike the POSIX-only describe above, this defense is
// checked on every platform: an entirely innocuous lexical path (no dotfile,
// no AppData, no credential filename anywhere in it) that reaches a denied
// file only once the link is resolved must still be refused.
describe('the real path of an attachment is checked through a directory link (innocuous name)', () => {
  let root;
  beforeEach(() => { root = makeAttachmentTestRoot(); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('an innocuous path reached through a linked directory is refused by its real path', async (t) => {
    fs.mkdirSync(path.join(root, '.secret'));
    fs.writeFileSync(path.join(root, '.secret', 'notes.txt'), 'secret');
    fs.mkdirSync(path.join(root, 'docs'));
    const linkPath = path.join(root, 'docs', 'lien');
    try {
      fs.symlinkSync(path.join(root, '.secret'), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip(`directory link unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const lexical = path.join(linkPath, 'notes.txt');
    // docs, lien, notes.txt: nothing here matches the lexical deny-list.
    assert.equal(isSensitiveFilePath(lexical), false, lexical);
    await assert.rejects(inlineAttachmentPaths({ attachments: [lexical] }),
      /Sensitive attachment path blocked: .*notes\.txt \(resolves to .*\.secret.*notes\.txt\)/);
  });
});

describe('a file with other hard links is not attached', () => {
  it('refuses it at inspection, and accepts a copy', async () => {
    const dir = makeAttachmentTestRoot();
    try {
      const file = path.join(dir, 'note.txt');
      fs.writeFileSync(file, 'bonjour');
      fs.linkSync(file, path.join(dir, 'other-name.txt'));
      await assert.rejects(inlineAttachmentPaths({ attachments: [file] }), /has other hard links; attach a copy instead/);
      const copy = path.join(dir, 'copy.txt');
      fs.copyFileSync(file, copy);
      const args = { attachments: [copy] };
      await inlineAttachmentPaths(args);
      assert.equal(args.attachments[0].name, 'copy.txt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a link made after the inspection, when the file is read again', async () => {
    const dir = makeAttachmentTestRoot();
    try {
      const file = path.join(dir, 'note.txt');
      fs.writeFileSync(file, 'bonjour');
      const info = await inspectAttachmentPath(file);
      fs.linkSync(file, path.join(dir, 'late-link.txt'));
      await assert.rejects(readAttachmentFromPath(info), /has other hard links/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validateAttachmentStat and hard links', () => {
  const regular = (nlink) => ({ isSymbolicLink: () => false, isFile: () => true, size: 10, nlink });
  it('applies to the stat of the opened descriptor too', () => {
    assert.doesNotThrow(() => validateAttachmentStat('/x/a.txt', regular(1)));
    assert.throws(() => validateAttachmentStat('/x/a.txt', regular(2)), /has other hard links; attach a copy instead/);
  });
});

describe('a stale or foreign connection file is refused (process id)', { skip: typeof process.getuid !== 'function' }, () => {
  let root;
  let connFile;
  const fail = (code) => () => { throw Object.assign(new Error(code), { code }); };
  const write = (data) => {
    fs.writeFileSync(connFile, JSON.stringify({ port: 8765, token: 'a'.repeat(64), ...data }), { mode: 0o600 });
    fs.chmodSync(connFile, 0o600);
  };
  const exeLink = (pid, target) => {
    const dir = path.join(root, 'proc', String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(target, path.join(dir, 'exe'));
  };
  const discover = ({ kill = () => true, env = {}, platform = 'linux' } = {}) => {
    clearConnectionCache();
    return discoverConnectionInfo({
      env, fsImpl: fs, pathImpl: path, platform, uid: process.getuid(),
      osImpl: { tmpdir: () => path.join(root, 'tmp'), homedir: () => root }, homeDir: root,
      procRoot: path.join(root, 'proc'), runtimeDir: path.join(root, 'run'),
      processImpl: { env, platform, kill },
    });
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-pid-'));
    connFile = path.join(root, 'tmp', 'commonpost-mcp', 'connection.json');
    fs.mkdirSync(path.dirname(connFile), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(connFile), 0o700);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts a living Thunderbird process', () => {
    write({ pid: 4242 });
    exeLink(4242, '/usr/lib/thunderbird/thunderbird-bin');
    assert.equal(discover().candidates.length, 1);
  });

  it('accepts a file without pid (older extension) or with an unusable one', () => {
    write({});
    assert.equal(discover({ kill: fail('ESRCH') }).candidates.length, 1);
    write({ pid: 'abc' });
    assert.equal(discover({ kill: fail('ESRCH') }).candidates.length, 1);
  });

  it('refuses a process that is not running', () => {
    write({ pid: 4242 });
    const result = discover({ kill: fail('ESRCH') });
    assert.equal(result.candidates.length, 0);
    assert.ok(result.attempts.some((a) => /stale connection file: process 4242 is not running/.test(JSON.stringify(a))));
  });

  it('refuses a process of another user (EPERM) on POSIX, but not a process check that cannot tell', () => {
    write({ pid: 4242 });
    const result = discover({ kill: fail('EPERM') });
    assert.equal(result.candidates.length, 0);
    assert.ok(result.attempts.some((a) => /belongs to another user/.test(JSON.stringify(a))));
    assert.equal(discover({ kill: fail('EINVAL') }).candidates.length, 1);
  });

  it('on Linux refuses a readable exe that is not Thunderbird or Betterbird', () => {
    write({ pid: 4242 });
    exeLink(4242, '/usr/bin/python3');
    const result = discover();
    assert.equal(result.candidates.length, 0);
    assert.ok(result.attempts.some((a) => /not Thunderbird or Betterbird/.test(JSON.stringify(a))));
    fs.rmSync(path.join(root, 'proc'), { recursive: true });
    exeLink(4242, '/snap/thunderbird/100/usr/lib/thunderbird/thunderbird');
    assert.equal(discover().candidates.length, 1);
    fs.rmSync(path.join(root, 'proc'), { recursive: true });
    exeLink(4242, '/opt/betterbird/betterbird');
    assert.equal(discover().candidates.length, 1);
  });

  it('an unreadable /proc entry does not refuse by itself', () => {
    write({ pid: 4242 });
    assert.equal(discover().candidates.length, 1);
  });

  it('the exe name is not checked outside Linux', () => {
    write({ pid: 4242 });
    exeLink(4242, '/usr/bin/python3');
    assert.equal(discover({ platform: 'darwin' }).candidates.length, 1);
  });

  it('with the pinned file, a refusal stops the bridge instead of falling through', () => {
    write({ pid: 4242 });
    const result = discover({ kill: fail('ESRCH'), env: { COMMONPOST_MCP_CONNECTION_FILE: connFile } });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.attempts.length, 1);
    assert.match(JSON.stringify(result.attempts[0]), /stale connection file/);
  });
});

describe('the folder of a discovered connection file is checked (POSIX)', { skip: typeof process.getuid !== 'function' }, () => {
  let root;
  let dir;
  let connFile;
  const options = (env = {}) => ({
    env, fsImpl: fs, pathImpl: path, platform: 'linux', uid: process.getuid(),
    osImpl: { tmpdir: () => path.join(root, 'tmp'), homedir: () => root }, homeDir: root,
    procRoot: path.join(root, 'proc'), runtimeDir: path.join(root, 'run'),
    processImpl: { env, platform: 'linux' },
  });
  const discover = (env) => { clearConnectionCache(); return discoverConnectionInfo(options(env)); };
  const reasons = (result) => JSON.stringify(result.attempts);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-dir-'));
    dir = path.join(root, 'tmp', 'commonpost-mcp');
    connFile = path.join(dir, 'connection.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(connFile, JSON.stringify({ port: 8765, token: 'a'.repeat(64) }), { mode: 0o600 });
    fs.chmodSync(connFile, 0o600);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts a 0700 folder of the current user', () => {
    assert.equal(discover().candidates.length, 1);
    assert.equal(checkConnectionDirSafety(connFile, { fsImpl: fs, pathImpl: path, platform: 'linux', uid: process.getuid() }), null);
  });

  it('refuses a folder open to group or others, and says why', () => {
    for (const mode of [0o750, 0o705, 0o755, 0o777]) {
      fs.chmodSync(dir, mode);
      const result = discover();
      assert.equal(result.candidates.length, 0, mode.toString(8));
      assert.match(reasons(result), /folder mode \d+ gives group\/other access/);
    }
  });

  it('refuses a folder owned by another uid', () => {
    clearConnectionCache();
    const result = discoverConnectionInfo({ ...options(), uid: process.getuid() + 1 });
    assert.equal(result.candidates.length, 0);
  });

  it('refuses a folder that is a symlink', () => {
    const real = path.join(root, 'real');
    fs.renameSync(dir, real);
    fs.symlinkSync(real, dir);
    const result = discover();
    assert.equal(result.candidates.length, 0);
    assert.match(reasons(result), /folder is a symlink/);
  });

  it('does not apply to a path the user pinned explicitly', () => {
    fs.chmodSync(dir, 0o755);
    const result = discover({ COMMONPOST_MCP_CONNECTION_FILE: connFile });
    assert.equal(result.candidates.length, 1);
  });
});
