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
} = require('../mcp-bridge.cjs');

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
