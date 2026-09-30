const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  advanceToNextCandidate,
  attachmentLimits,
  buildConnectionDiscoveryErrorMessage,
  compactToolResultJsonText,
  clearConnectionCache,
  discoverConnectionInfo,
  FLATPAK_APP_IDS,
  getRuntimeDir,
  inlineAttachmentPaths,
  isSensitiveFilePath,
  isValidAuthToken,
  readConnectionInfo,
} = require('../mcp-bridge.cjs');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-bridge-'));
}

function cleanupTempRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// Attachment tests need a directory outside the AppData deny-list (which
// os.tmpdir() sits under on Windows, since %TEMP% is AppData\Local\Temp)
// and with no dot-prefixed component, so a path written under it is an
// ordinary, allowed attachment path rather than one the deny-list itself
// would refuse before the test's own assertion runs. Kept in sync with the
// same helper in commonpost-bridge.test.cjs.
function makeAttachmentTestRoot() {
  if (process.platform === 'win32') {
    return fs.mkdtempSync(path.join(os.homedir(), 'cp-test-'));
  }
  return makeTempRoot();
}

function writeConnectionFile(filePath, { port, token, pid = process.pid }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // The bridge also requires the folder to be closed to group and others.
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(filePath), 0o700);
  fs.writeFileSync(filePath, JSON.stringify({ port, token, pid }), { encoding: 'utf8', mode: 0o600 });
  // The bridge only trusts a 0600 file of the current user, as the
  // extension writes it.
  fs.chmodSync(filePath, 0o600);
}

function makeTestOptions(root, overrides = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const homeDir = path.join(root, 'home');
  const tmpDir = path.join(root, 'tmp');
  const runtimeDir = path.join(root, 'runtime');

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  return {
    env: overrides.env || {},
    fsImpl: overrides.fsImpl || fs,
    homeDir,
    osImpl: overrides.osImpl || {
      tmpdir: () => tmpDir,
      homedir: () => homeDir,
    },
    pathImpl: path,
    platform: overrides.platform || 'linux',
    procRoot: overrides.procRoot || path.join(root, 'proc'),
    processImpl: overrides.processImpl || { env: overrides.env || {}, platform: overrides.platform || 'linux' },
    runtimeDir: Object.prototype.hasOwnProperty.call(overrides, 'runtimeDir')
      ? overrides.runtimeDir
      : runtimeDir,
    uid: Object.prototype.hasOwnProperty.call(overrides, 'uid') ? overrides.uid : uid,
    darwinFoldersRoot: overrides.darwinFoldersRoot || path.join(root, 'var', 'folders'),
  };
}

function makeFsWithStatOverrides(overrides) {
  // The bridge re-checks the owner on the opened descriptor (fstatSync):
  // remember which path each descriptor was opened for.
  const pathByFd = new Map();
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'openSync') {
        return (filePath, ...args) => {
          const fd = target.openSync(filePath, ...args);
          pathByFd.set(fd, filePath);
          return fd;
        };
      }
      if (prop === 'closeSync') {
        return (fd) => {
          pathByFd.delete(fd);
          return target.closeSync(fd);
        };
      }
      // lstatSync too: the connection-file safety check reads the owner with it.
      if (prop === 'statSync' || prop === 'lstatSync' || prop === 'fstatSync') {
        return (filePath, ...args) => {
          const stat = target[prop](filePath, ...args);
          const override = overrides.get(prop === 'fstatSync' ? pathByFd.get(filePath) : filePath);
          if (!override) {
            return stat;
          }
          return new Proxy(stat, {
            get(innerTarget, innerProp) {
              if (Object.prototype.hasOwnProperty.call(override, innerProp)) {
                return override[innerProp];
              }
              const value = innerTarget[innerProp];
              return typeof value === 'function' ? value.bind(innerTarget) : value;
            }
          });
        };
      }

      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

describe('Auth token validation', () => {
  it('accepts 64 lowercase hex characters', () => {
    assert.equal(isValidAuthToken('a'.repeat(64)), true);
    assert.equal(isValidAuthToken('0123456789abcdef'.repeat(4)), true);
  });

  it('rejects non-generated token shapes', () => {
    assert.equal(isValidAuthToken(''), false);
    assert.equal(isValidAuthToken(' '.repeat(64)), false);
    assert.equal(isValidAuthToken('a'.repeat(63)), false);
    assert.equal(isValidAuthToken('a'.repeat(65)), false);
    assert.equal(isValidAuthToken('A'.repeat(64)), false);
    assert.equal(isValidAuthToken('g'.repeat(64)), false);
    assert.equal(isValidAuthToken(`${'a'.repeat(64)}\n`), false);
    assert.equal(isValidAuthToken(null), false);
  });
});

describe('Tool result serialization', () => {
  it('compacts JSON text content without mutating the original response', () => {
    const originalText = JSON.stringify([{ name: 'INBOX', unreadMessages: 3 }], null, 2);
    const response = {
      jsonrpc: '2.0',
      id: 2,
      result: {
        content: [{
          type: 'text',
          text: originalText,
        }],
      },
    };

    const compacted = compactToolResultJsonText(response);

    assert.notStrictEqual(compacted, response);
    assert.deepStrictEqual(
      JSON.parse(compacted.result.content[0].text),
      JSON.parse(originalText)
    );
    assert.equal(response.result.content[0].text, originalText);
    assert.equal(compacted.result.content[0].text.includes('\n'), false);
  });

  it('preserves image content blocks while compacting the leading JSON text', () => {
    const imageBlock = {
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    };
    const response = {
      jsonrpc: '2.0',
      id: 137,
      result: {
        content: [
          { type: 'text', text: JSON.stringify({ inlineImages: 1 }, null, 2) },
          imageBlock,
        ],
      },
    };

    const compacted = compactToolResultJsonText(response);

    assert.equal(compacted.result.content[0].text, '{"inlineImages":1}');
    assert.strictEqual(compacted.result.content[1], imageBlock);
    assert.strictEqual(response.result.content[1], imageBlock);
  });
});

describe('Bridge attachment path policy', () => {
  let root;

  beforeEach(() => {
    root = makeAttachmentTestRoot();
  });

  afterEach(() => {
    cleanupTempRoot(root);
  });

  it('rejects sensitive paths before trying to inline them', async () => {
    const sensitivePath = path.join(root, '.ssh', 'id_rsa');
    const args = { attachments: [sensitivePath] };

    await assert.rejects(
      inlineAttachmentPaths(args),
      error => {
        assert.match(error.message, /Sensitive attachment path blocked/);
        assert.ok(error.message.includes(sensitivePath), error.message);
        return true;
      }
    );
    assert.deepEqual(args.attachments, [sensitivePath]);
  });

  it('uses the same normalized deny-list rules for Windows paths', () => {
    assert.equal(isSensitiveFilePath('C:\\Users\\alice\\.ssh\\id_ed25519'), true);
    assert.equal(isSensitiveFilePath('C:\\Users\\alice\\Downloads\\report.pdf'), false);
  });

  it('rejects attachment counts above the extension limit before filesystem access', async () => {
    const attachments = Array.from(
      { length: attachmentLimits.MAX_ATTACHMENTS_PER_MESSAGE + 1 },
      (_, index) => ({ name: `inline-${index}.txt`, base64: 'QQ==' })
    );

    await assert.rejects(
      inlineAttachmentPaths({ attachments }),
      new RegExp(
        `Attachment count ${attachments.length} exceeds the ` +
        `${attachmentLimits.MAX_ATTACHMENTS_PER_MESSAGE} attachment limit`
      )
    );
  });

  it('rejects an aggregate of path attachments above 50 MB before reading', async () => {
    const sizes = [18, 18, 15].map(mib => mib * 1024 * 1024);
    const attachments = sizes.map((size, index) => {
      const filePath = path.join(root, `aggregate-${index}.bin`);
      fs.writeFileSync(filePath, '');
      fs.truncateSync(filePath, size);
      return filePath;
    });
    const args = { attachments };

    await assert.rejects(
      inlineAttachmentPaths(args),
      error => {
        assert.match(error.message, /50 MB aggregate attachment limit/);
        assert.ok(error.message.includes(attachments[2]), error.message);
        return true;
      }
    );
    assert.deepEqual(args.attachments, attachments);
  });

  it('rejects oversized and non-regular files during preflight', async () => {
    const oversizedPath = path.join(root, 'oversized.bin');
    fs.writeFileSync(oversizedPath, '');
    fs.truncateSync(oversizedPath, attachmentLimits.MAX_ATTACHMENT_BYTES + 1);

    await assert.rejects(
      inlineAttachmentPaths({ attachments: [oversizedPath] }),
      error => error.message.includes(`Attachment too large: ${oversizedPath}`)
    );
    await assert.rejects(
      inlineAttachmentPaths({ attachments: [root] }),
      error => error.message.includes(`Attachment is not a regular file: ${root}`)
    );
  });

  it('rejects symlinked attachment paths', async (t) => {
    const targetPath = path.join(root, 'target.txt');
    const symlinkPath = path.join(root, 'attachment.txt');
    fs.writeFileSync(targetPath, 'safe attachment', 'utf8');
    try {
      fs.symlinkSync(targetPath, symlinkPath, 'file');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip(`symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      inlineAttachmentPaths({ attachments: [symlinkPath] }),
      error => {
        assert.match(error.message, /symlink/);
        assert.ok(error.message.includes(symlinkPath), error.message);
        return true;
      }
    );
  });

  it('inlines allowed files and leaves inline objects untouched', async () => {
    const filePath = path.join(root, 'report.txt');
    const inline = { name: 'already-inline.txt', base64: 'QQ==' };
    fs.writeFileSync(filePath, 'hello', 'utf8');
    const args = { attachments: [filePath, inline] };

    await inlineAttachmentPaths(args);

    assert.deepEqual(args.attachments, [
      {
        name: 'report.txt',
        contentType: 'text/plain',
        base64: Buffer.from('hello').toString('base64'),
      },
      inline,
    ]);
  });

  it('parses attachments given as a JSON-encoded string, the same way coerceToolArgs does on the extension side', async () => {
    const filePath = path.join(root, 'report.txt');
    fs.writeFileSync(filePath, 'hello', 'utf8');
    const args = { attachments: JSON.stringify([filePath]) };

    await inlineAttachmentPaths(args);

    assert.deepEqual(args.attachments, [{
      name: 'report.txt',
      contentType: 'text/plain',
      base64: Buffer.from('hello').toString('base64'),
    }]);
  });

  it('a JSON string goes through every check: a sensitive path inside it is refused', async () => {
    const sensitivePath = path.join(root, '.ssh', 'id_rsa');
    const args = { attachments: JSON.stringify([sensitivePath]) };

    await assert.rejects(inlineAttachmentPaths(args), /Sensitive attachment path blocked/);
  });

  it('refuses anything that is not an array and not array-shaped JSON, instead of passing it through unchecked', async () => {
    for (const bad of ['{"not":"an array"}', 'not json at all', '42', 'null', JSON.stringify({ 0: 'x' })]) {
      await assert.rejects(inlineAttachmentPaths({ attachments: bad }), /attachments must be an array/, bad);
    }
    await assert.rejects(inlineAttachmentPaths({ attachments: { 0: 'x' } }), /attachments must be an array/);
    await assert.rejects(inlineAttachmentPaths({ attachments: 42 }), /attachments must be an array/);
  });

  it('a missing attachments field is still a no-op', async () => {
    const args = {};
    await inlineAttachmentPaths(args);
    assert.deepEqual(args, {});
    const argsNull = { attachments: null };
    await inlineAttachmentPaths(argsNull);
    assert.equal(argsNull.attachments, null);
  });
});

// makeTestOptions defaults to platform: 'linux' with the real fs (uid/mode
// checks in checkConnectionFileSafety run for real). On POSIX that's exactly
// what it looks like; on a real Windows filesystem chmod 0600 comes back as
// mode 666 and the owning uid as 0 regardless of what was asked for, so a
// test that expects such a file to be ACCEPTED fails there for a reason that
// has nothing to do with the code under test. Skipped on win32, not changed:
// running the actual POSIX logic on a real POSIX-like fs is still the point.
const WIN32_REAL_POSIX_FS_SKIP = { skip: process.platform === 'win32' };

describe('Bridge discovery', () => {
  let root;

  beforeEach(() => {
    clearConnectionCache();
    root = makeTempRoot();
  });

  afterEach(() => {
    clearConnectionCache();
    cleanupTempRoot(root);
  });

  it('env var override takes priority', WIN32_REAL_POSIX_FS_SKIP, () => {
    const options = makeTestOptions(root, {
      env: { COMMONPOST_MCP_CONNECTION_FILE: path.join(root, 'env', 'connection.json') },
    });

    writeConnectionFile(path.join(root, 'tmp', 'commonpost-mcp', 'connection.json'), {
      port: 20001,
      token: 'native-token',
    });
    writeConnectionFile(options.env.COMMONPOST_MCP_CONNECTION_FILE, {
      port: 20002,
      token: 'env-token',
    });

    const connInfo = readConnectionInfo(options);
    assert.deepStrictEqual(connInfo, {
      port: 20002,
      token: 'env-token',
      pid: process.pid,
    });
  });

  // A real Snap process: cmdline names it "thunderbird", its own binary
  // resolves under the Snap's read-only mount, and snapd's own SNAP_NAME
  // marker is in its environment. writeSnapProc() below is reused across
  // tests that vary one of these three facts to confirm each one is checked.
  function writeSnapProc(procRoot, pid, { exe = '/snap/thunderbird/123/usr/lib/thunderbird/thunderbird', snapName = 'SNAP_NAME=thunderbird', tmpDir } = {}) {
    const procDir = path.join(procRoot, pid);
    fs.mkdirSync(procDir, { recursive: true });
    fs.writeFileSync(path.join(procDir, 'cmdline'), 'thunderbird\0--some-flag', 'utf8');
    fs.symlinkSync(exe, path.join(procDir, 'exe'));
    const envEntries = [snapName, tmpDir ? `TMPDIR=${tmpDir}` : null].filter(Boolean);
    fs.writeFileSync(path.join(procDir, 'environ'), envEntries.join('\0') + '\0', 'utf8');
  }

  it('snap detection works from a mocked /proc tree', WIN32_REAL_POSIX_FS_SKIP, () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      procRoot: path.join(root, 'proc'),
    });

    fs.mkdirSync(path.join(options.homeDir, 'snap', 'thunderbird'), { recursive: true });
    const snapTmpDir = path.join(root, 'snap-tmp');
    writeSnapProc(options.procRoot, '4242', { tmpDir: snapTmpDir });

    writeConnectionFile(path.join(snapTmpDir, 'commonpost-mcp', 'connection.json'), {
      port: 20003,
      token: 'snap-token',
    });

    const connInfo = readConnectionInfo(options);
    assert.equal(connInfo.port, 20003);
    assert.equal(connInfo.token, 'snap-token');
  });

  it('snap detection refuses a real-looking name whose own binary is not under /snap/thunderbird/', () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      procRoot: path.join(root, 'proc'),
    });

    fs.mkdirSync(path.join(options.homeDir, 'snap', 'thunderbird'), { recursive: true });
    // Named "thunderbird" and exports SNAP_NAME, but the exe target does not
    // resolve under the Snap's read-only mount.
    const fakeTmpDir = path.join(root, 'fake-tmp');
    writeSnapProc(options.procRoot, '5150', { exe: '/home/user/lookalike/thunderbird', tmpDir: fakeTmpDir });
    writeConnectionFile(path.join(fakeTmpDir, 'commonpost-mcp', 'connection.json'), {
      port: 29998,
      token: 'fake-exe-token',
    });

    assert.equal(readConnectionInfo(options), null);
  });

  it('snap detection refuses a process under the real exe path without the SNAP_NAME marker', () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      procRoot: path.join(root, 'proc'),
    });

    fs.mkdirSync(path.join(options.homeDir, 'snap', 'thunderbird'), { recursive: true });
    const noMarkerTmpDir = path.join(root, 'no-marker-tmp');
    writeSnapProc(options.procRoot, '5151', { snapName: 'HOME=/home/user', tmpDir: noMarkerTmpDir });
    writeConnectionFile(path.join(noMarkerTmpDir, 'commonpost-mcp', 'connection.json'), {
      port: 29997,
      token: 'no-marker-token',
    });

    assert.equal(readConnectionInfo(options), null);
  });

  it('the Downloads fallback is only tried once a real Snap process was seen', WIN32_REAL_POSIX_FS_SKIP, () => {
    const withFallback = path.join(root, 'downloads-with-process');
    fs.mkdirSync(withFallback, { recursive: true });
    const optionsWith = makeTestOptions(withFallback, {
      platform: 'linux',
      procRoot: path.join(withFallback, 'proc'),
    });
    fs.mkdirSync(path.join(optionsWith.homeDir, 'snap', 'thunderbird'), { recursive: true });
    writeSnapProc(optionsWith.procRoot, '6001', { tmpDir: path.join(withFallback, 'unrelated-tmp') });
    writeConnectionFile(
      path.join(optionsWith.homeDir, 'Downloads', 'thunderbird.tmp', 'commonpost-mcp', 'connection.json'),
      { port: 20009, token: 'downloads-fallback-token' }
    );
    assert.equal(readConnectionInfo(optionsWith).token, 'downloads-fallback-token');
    clearConnectionCache();

    const withoutFallback = path.join(root, 'downloads-without-process');
    fs.mkdirSync(withoutFallback, { recursive: true });
    const optionsWithout = makeTestOptions(withoutFallback, {
      platform: 'linux',
      procRoot: path.join(withoutFallback, 'proc'),
    });
    fs.mkdirSync(path.join(optionsWithout.homeDir, 'snap', 'thunderbird'), { recursive: true });
    fs.mkdirSync(optionsWithout.procRoot, { recursive: true });
    // Snap install detected, but no matching process: the same fixed
    // Downloads path must NOT be trusted on the strength of the snap
    // being installed alone.
    writeConnectionFile(
      path.join(optionsWithout.homeDir, 'Downloads', 'thunderbird.tmp', 'commonpost-mcp', 'connection.json'),
      { port: 20010, token: 'unearned-fallback-token' }
    );
    assert.equal(readConnectionInfo(optionsWithout), null);
  });

  it('snap detection ignores decoy processes with thunderbird only as a file arg', () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      procRoot: path.join(root, 'proc'),
    });

    fs.mkdirSync(path.join(options.homeDir, 'snap', 'thunderbird'), { recursive: true });

    // Decoy: a text editor opened on "thunderbird.txt". argv[0] is /usr/bin/vim,
    // argv[1] contains 'thunderbird' as a substring. Must NOT be picked up.
    const decoyPid = '9999';
    fs.mkdirSync(path.join(options.procRoot, decoyPid), { recursive: true });
    fs.writeFileSync(
      path.join(options.procRoot, decoyPid, 'cmdline'),
      '/usr/bin/vim\0/home/user/thunderbird.txt\0',
      'utf8'
    );
    const decoyTmpDir = path.join(root, 'decoy-tmp');
    fs.writeFileSync(
      path.join(options.procRoot, decoyPid, 'environ'),
      `TMPDIR=${decoyTmpDir}\0`,
      'utf8'
    );
    // If the decoy was picked up, the bridge would read this file and succeed.
    writeConnectionFile(path.join(decoyTmpDir, 'commonpost-mcp', 'connection.json'), {
      port: 29999,
      token: 'attacker-token',
    });

    const connInfo = readConnectionInfo(options);
    // No real Thunderbird process in our mocked /proc -> discovery returns null.
    // Critically, the decoy's TMPDIR file is NOT selected.
    assert.equal(connInfo, null);
  });

  it('flatpak scan finds a runtime connection file', WIN32_REAL_POSIX_FS_SKIP, () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      runtimeDir: path.join(root, 'runtime'),
    });

    const flatpakConnFile = path.join(
      options.runtimeDir,
      'app',
      'eu.betterbird.Betterbird',
      'commonpost-mcp',
      'connection.json'
    );
    writeConnectionFile(flatpakConnFile, {
      port: 20004,
      token: 'flatpak-token',
    });

    const connInfo = readConnectionInfo(options);
    assert.equal(connInfo.port, 20004);
    assert.equal(connInfo.token, 'flatpak-token');
  });

  it('flatpak scan ignores an app id that is not Thunderbird or Betterbird', () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      runtimeDir: path.join(root, 'runtime'),
    });

    assert.ok(!FLATPAK_APP_IDS.includes('org.example.NotThunderbird'));
    writeConnectionFile(
      path.join(options.runtimeDir, 'app', 'org.example.NotThunderbird', 'commonpost-mcp', 'connection.json'),
      { port: 29996, token: 'unrelated-flatpak-token' }
    );

    assert.equal(readConnectionInfo(options), null);
  });

  it('flatpak scan does not need to list the runtime directory: only the known app ids are probed', () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      runtimeDir: path.join(root, 'runtime', 'does-not-exist'),
    });
    // No app/ directory at all under runtimeDir: a readdir-based scan would
    // fail outright; probing each known id directly just finds nothing.
    assert.equal(readConnectionInfo(options), null);
  });

  // N7, real Snap + Flatpak run (2026-09-29): Flathub currently publishes
  // org.mozilla.thunderbird (lowercase) and org.mozilla.thunderbird_esr as
  // separate apps; installing the older org.mozilla.Thunderbird id now
  // redirects to org.mozilla.thunderbird_esr. One test per accepted id, plus
  // the exact-case and unknown-id refusals the same real run asked for.
  for (const appId of ['org.mozilla.thunderbird', 'org.mozilla.thunderbird_esr', 'org.mozilla.Thunderbird', 'eu.betterbird.Betterbird']) {
    it(`flatpak scan accepts ${appId}`, WIN32_REAL_POSIX_FS_SKIP, () => {
      const options = makeTestOptions(root, {
        platform: 'linux',
        runtimeDir: path.join(root, 'runtime'),
      });
      writeConnectionFile(
        path.join(options.runtimeDir, 'app', appId, 'commonpost-mcp', 'connection.json'),
        { port: 21001, token: `${appId}-token` }
      );
      const connInfo = readConnectionInfo(options);
      assert.equal(connInfo && connInfo.token, `${appId}-token`, appId);
    });
  }

  it('flatpak scan refuses an unknown app id (e.g. org.mozilla.firefox)', () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      runtimeDir: path.join(root, 'runtime'),
    });
    assert.ok(!FLATPAK_APP_IDS.includes('org.mozilla.firefox'));
    writeConnectionFile(
      path.join(options.runtimeDir, 'app', 'org.mozilla.firefox', 'commonpost-mcp', 'connection.json'),
      { port: 29995, token: 'firefox-token' }
    );
    assert.equal(readConnectionInfo(options), null);
  });

  it('flatpak scan is case-sensitive: a differently-cased, unlisted id is refused', () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      runtimeDir: path.join(root, 'runtime'),
    });
    const wrongCase = 'ORG.MOZILLA.THUNDERBIRD';
    assert.ok(!FLATPAK_APP_IDS.includes(wrongCase));
    writeConnectionFile(
      path.join(options.runtimeDir, 'app', wrongCase, 'commonpost-mcp', 'connection.json'),
      { port: 29994, token: 'wrong-case-token' }
    );
    assert.equal(readConnectionInfo(options), null);
  });

  it('macOS scan finds current uid files and ignores other owners', WIN32_REAL_POSIX_FS_SKIP, () => {
    // Pin a synthetic uid rather than process.getuid(). On Windows the real
    // fs.statSync reports uid=0 for every file regardless of the caller, so we
    // can't rely on stat.uid matching process.getuid() — both files are stat-
    // overridden below so the uid-filter logic is exercised on any platform.
    const currentUid = 1000;
    const darwinRoot = path.join(root, 'var', 'folders');
    const options = makeTestOptions(root, {
      platform: 'darwin',
      darwinFoldersRoot: darwinRoot,
      uid: currentUid,
    });

    const ownedConnFile = path.join(darwinRoot, 'aa', 'bb', 'T', 'commonpost-mcp', 'connection.json');
    const foreignConnFile = path.join(darwinRoot, 'cc', 'dd', 'T', 'commonpost-mcp', 'connection.json');

    writeConnectionFile(ownedConnFile, {
      port: 20005,
      token: 'owned-token',
    });
    writeConnectionFile(foreignConnFile, {
      port: 20006,
      token: 'foreign-token',
    });

    const statOverrides = new Map();
    // Force both stat results: the owned file to the caller's uid and the
    // foreign one to a different uid, so the filter is tested independent of
    // what the host's real fs.statSync returns.
    statOverrides.set(ownedConnFile, { uid: currentUid });
    statOverrides.set(foreignConnFile, { uid: currentUid + 1 });
    // The folder of the file is checked too (owner = the caller).
    statOverrides.set(path.dirname(ownedConnFile), { uid: currentUid });
    statOverrides.set(path.dirname(foreignConnFile), { uid: currentUid });

    const connInfo = readConnectionInfo({
      ...options,
      fsImpl: makeFsWithStatOverrides(statOverrides),
    });

    assert.equal(connInfo.port, 20005);
    assert.equal(connInfo.token, 'owned-token');
  });

  it('re-resolves candidates on the next cache miss after a startup race', WIN32_REAL_POSIX_FS_SKIP, () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      runtimeDir: path.join(root, 'runtime'),
    });

    assert.equal(readConnectionInfo(options), null);

    const delayedConnFile = path.join(
      options.runtimeDir,
      'app',
      'org.mozilla.Thunderbird',
      'commonpost-mcp',
      'connection.json'
    );
    writeConnectionFile(delayedConnFile, {
      port: 20007,
      token: 'delayed-token',
    });

    const connInfo = readConnectionInfo(options);
    assert.equal(connInfo.port, 20007);
    assert.equal(connInfo.token, 'delayed-token');
  });

  it('reports useful discovery failures', () => {
    const options = makeTestOptions(root, {
      env: { COMMONPOST_MCP_CONNECTION_FILE: path.join(root, 'missing', 'connection.json') },
      platform: 'linux',
    });

    assert.equal(readConnectionInfo(options), null);
    assert.match(buildConnectionDiscoveryErrorMessage(), /COMMONPOST_MCP_CONNECTION_FILE/);
    assert.match(buildConnectionDiscoveryErrorMessage(), /file not found/);
  });

  it('discovery failures point at the README section on Experiment add-ons being disabled on Release', () => {
    const message = buildConnectionDiscoveryErrorMessage();
    assert.match(message, /check that the add-on is enabled/);
    assert.match(message, /Experiment add-ons/);
    assert.match(message, /README section/i);
    assert.ok(message.includes('https://github.com/commonpost/thunderbird-mcp#if-thunderbird-disables-experiment-add-ons-on-the-release-channel'));
    // Stays a pointer: no preference names or settings to change.
    assert.doesNotMatch(message, /about:config|\bextensions\.[a-z]/i);
  });

  it('discoverConnectionInfo collects every valid candidate, not just the winner', WIN32_REAL_POSIX_FS_SKIP, () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      runtimeDir: path.join(root, 'runtime'),
    });

    // Native /tmp file (first group, winner)
    writeConnectionFile(path.join(root, 'tmp', 'commonpost-mcp', 'connection.json'), {
      port: 20100,
      token: 'native',
    });

    // Flatpak runtime file (later group, also valid)
    writeConnectionFile(
      path.join(options.runtimeDir, 'app', 'org.mozilla.Thunderbird', 'commonpost-mcp', 'connection.json'),
      { port: 20101, token: 'flatpak' }
    );

    const result = discoverConnectionInfo(options);
    assert.ok(result.candidates.length >= 2, `expected >=2 candidates, got ${result.candidates.length}`);
    assert.equal(result.candidates[0].data.token, 'native');
    assert.ok(result.candidates.some(c => c.data.token === 'flatpak'));
  });

  it('advanceToNextCandidate walks the cached list, then returns null when exhausted', WIN32_REAL_POSIX_FS_SKIP, () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      runtimeDir: path.join(root, 'runtime'),
    });

    writeConnectionFile(path.join(root, 'tmp', 'commonpost-mcp', 'connection.json'), {
      port: 20200,
      token: 'first',
    });
    writeConnectionFile(
      path.join(options.runtimeDir, 'app', 'org.mozilla.Thunderbird', 'commonpost-mcp', 'connection.json'),
      { port: 20201, token: 'second' }
    );

    const first = readConnectionInfo(options);
    assert.equal(first.token, 'first');

    const second = advanceToNextCandidate();
    assert.ok(second, 'should advance to a second candidate');
    assert.equal(second.token, 'second');

    const third = advanceToNextCandidate();
    assert.equal(third, null, 'should return null after the last candidate');
  });

  it('advanceToNextCandidate returns null when no cache exists', () => {
    clearConnectionCache();
    assert.equal(advanceToNextCandidate(), null);
  });

  it('hard-pinned env override does not collect autodiscovery candidates as fallbacks', WIN32_REAL_POSIX_FS_SKIP, () => {
    const options = makeTestOptions(root, {
      platform: 'linux',
      runtimeDir: path.join(root, 'runtime'),
      env: { COMMONPOST_MCP_CONNECTION_FILE: path.join(root, 'pinned', 'connection.json') },
    });

    writeConnectionFile(options.env.COMMONPOST_MCP_CONNECTION_FILE, {
      port: 20300,
      token: 'pinned',
    });
    writeConnectionFile(path.join(root, 'tmp', 'commonpost-mcp', 'connection.json'), {
      port: 20301,
      token: 'should-not-appear',
    });

    const result = discoverConnectionInfo(options);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].data.token, 'pinned');
  });

  describe('getRuntimeDir', () => {
    function makeRuntimeFsWithOverride(dirPath, override) {
      return new Proxy(fs, {
        get(target, prop) {
          if (prop === 'lstatSync') {
            return (p, ...args) => {
              if (p === dirPath) {
                if (override instanceof Error) throw override;
                return override;
              }
              return target.lstatSync(p, ...args);
            };
          }
          return target[prop];
        },
      });
    }
    const dirStat = (over = {}) => ({ isDirectory: () => true, uid: 1000, mode: 0o40700, ...over });

    it('never returns an externally supplied XDG_RUNTIME_DIR value, even if one is passed alongside', () => {
      // A real (accepted, owned, mode 700) /run/user/1000, but env.XDG_RUNTIME_DIR
      // names a DIFFERENT, made-up location -- if getRuntimeDir read env at
      // all, this is where a bug would substitute it in.
      const fsImpl = makeRuntimeFsWithOverride('/run/user/1000', dirStat());
      const result = getRuntimeDir({ fsImpl, pathImpl: path, uid: 1000, env: { XDG_RUNTIME_DIR: '/tmp/elsewhere' } });
      assert.equal(result, '/run/user/1000');
      assert.notEqual(result, '/tmp/elsewhere');

      // And the other way: env.XDG_RUNTIME_DIR pointing at a directory that
      // WOULD pass every check does not make getRuntimeDir accept it either
      // -- /run/user/1000 itself is missing, so the real answer is null.
      const missing = new Error('ENOENT');
      missing.code = 'ENOENT';
      const missingFsImpl = makeRuntimeFsWithOverride('/run/user/1000', missing);
      const envPointsElsewhere = new Proxy(missingFsImpl, {
        get(target, prop) {
          if (prop === 'lstatSync') {
            return (p, ...args) => (p === '/tmp/elsewhere' ? dirStat() : target.lstatSync(p, ...args));
          }
          return target[prop];
        },
      });
      assert.equal(
        getRuntimeDir({ fsImpl: envPointsElsewhere, pathImpl: path, uid: 1000, env: { XDG_RUNTIME_DIR: '/tmp/elsewhere' } }),
        null
      );
    });

    it('accepts a directory owned by the uid with no group/other access', WIN32_REAL_POSIX_FS_SKIP, () => {
      const fsImpl = makeRuntimeFsWithOverride('/run/user/1000', dirStat());
      assert.equal(getRuntimeDir({ fsImpl, pathImpl: path, uid: 1000 }), '/run/user/1000');
    });

    it('refuses a directory owned by another uid', () => {
      const fsImpl = makeRuntimeFsWithOverride('/run/user/1000', dirStat({ uid: 1001 }));
      assert.equal(getRuntimeDir({ fsImpl, pathImpl: path, uid: 1000 }), null);
    });

    for (const mode of [0o40750, 0o40704, 0o40777]) {
      it(`refuses group or other access (mode ${mode.toString(8)})`, () => {
        const fsImpl = makeRuntimeFsWithOverride('/run/user/1000', dirStat({ mode }));
        assert.equal(getRuntimeDir({ fsImpl, pathImpl: path, uid: 1000 }), null);
      });
    }

    it('refuses a file where a directory is expected', () => {
      const fsImpl = makeRuntimeFsWithOverride('/run/user/1000', dirStat({ isDirectory: () => false }));
      assert.equal(getRuntimeDir({ fsImpl, pathImpl: path, uid: 1000 }), null);
    });

    it('refuses when the directory does not exist, and when there is no uid', () => {
      const missing = new Error('ENOENT');
      missing.code = 'ENOENT';
      const fsImpl = makeRuntimeFsWithOverride('/run/user/1000', missing);
      assert.equal(getRuntimeDir({ fsImpl, pathImpl: path, uid: 1000 }), null);
      assert.equal(getRuntimeDir({ fsImpl: fs, pathImpl: path, uid: null }), null);
      assert.equal(getRuntimeDir({ fsImpl: fs, pathImpl: path, uid: undefined }), null);
    });
  });
});
