// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';

// How the bridge finds Thunderbird's connection file and what it trusts: the safety checks on the file and its
// folder, the check of the process that wrote it, and the scans of macOS, Snap and Flatpak locations. The scans and
// checks run against a stand-in file system, so that every odd answer (an entry that is not a folder, a process that
// vanishes, an error with no message) can be given.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildCandidateGroups,
  checkConnectionDirSafety,
  checkConnectionFileSafety,
  checkConnectionOwnerProcess,
  checkWindowsTempContainment,
  createDiscoveryContext,
  discoverConnectionInfo,
  findFlatpakConnectionCandidates,
  findMacOsConnectionCandidates,
  findSnapConnectionCandidates,
  formatDiscoveryAttempts,
  readConnectionFileVerified,
  stripTrailing,
} = require('../mcp-bridge.cjs');

function makeContext(overrides = {}) {
  return createDiscoveryContext({
    fsImpl: {},
    pathImpl: path,
    osImpl: { tmpdir: () => '/tmp', homedir: () => '/home/u' },
    processImpl: { platform: 'linux', env: {}, kill() {} },
    env: {},
    uid: 1000,
    platform: 'linux',
    homeDir: '/home/u',
    runtimeDir: null,
    procRoot: '/proc',
    darwinFoldersRoot: '/var/folders',
    ...overrides,
  });
}

const dirent = (name, isDirectory = true) => ({ name, isDirectory: () => isDirectory });
const fsError = (code, message) => Object.assign(new Error(message ?? code), { code });

describe('discovery context', () => {
  it('takes no user id from a process that cannot give one, and no environment from one that has none', () => {
    const context = createDiscoveryContext({ processImpl: { platform: 'linux' }, osImpl: { homedir: () => '/h' }, runtimeDir: null });
    assert.equal(context.uid, null);
    assert.deepEqual(context.env, {});
    assert.equal(context.homeDir, '/h');
    assert.equal(context.platform, 'linux');
  });

  it('reads the user id and the environment from the process it is given, and an explicit uid wins', () => {
    const processImpl = { platform: 'linux', env: { A: '1' }, getuid: () => 77 };
    const context = createDiscoveryContext({ processImpl, osImpl: { homedir: () => '/h' }, runtimeDir: null });
    assert.equal(context.uid, 77);
    assert.deepEqual(context.env, { A: '1' });
    assert.equal(createDiscoveryContext({ processImpl, osImpl: { homedir: () => '/h' }, runtimeDir: null, uid: undefined }).uid, undefined);
  });

  it('formats an empty list of attempts as "no candidates generated"', () => {
    assert.equal(formatDiscoveryAttempts([]), 'no candidates generated');
    assert.equal(formatDiscoveryAttempts([{ label: 'native tmp', path: '/tmp/x', reason: 'file not found' }]), 'native tmp (/tmp/x): file not found');
  });

  it('drops trailing characters from the end only', () => {
    assert.equal(stripTrailing('a//\\', '/\\'), 'a');
    assert.equal(stripTrailing('///', '/'), '');
    assert.equal(stripTrailing('a/b', '/'), 'a/b');
  });
});

describe('what a failed file-system call is reported as', () => {
  const reasonOf = (thrown) => {
    const context = makeContext({ fsImpl: { lstatSync() { throw thrown; } } });
    return checkConnectionFileSafety('/tmp/commonpost-mcp/connection.json', context);
  };

  it('says "file not found" for ENOENT and "permission denied" for EACCES and EPERM', () => {
    assert.equal(reasonOf(fsError('ENOENT')), 'file not found');
    assert.equal(reasonOf(fsError('EACCES')), 'permission denied');
    assert.equal(reasonOf(fsError('EPERM')), 'permission denied');
  });

  it('gives the message of any other error, or its text, or "unknown error" for nothing', () => {
    assert.equal(reasonOf(fsError('EIO', 'input/output error')), 'input/output error');
    assert.equal(reasonOf({ code: 'EIO' }), '[object Object]');
    assert.equal(reasonOf('plain text'), 'plain text');
    assert.equal(reasonOf(null), 'unknown error');
    assert.equal(reasonOf(undefined), 'unknown error');
  });
});

describe('connection file safety (POSIX)', () => {
  const file = (props = {}) => ({ isSymbolicLink: () => false, isFile: () => true, uid: 1000, mode: 0o100600, ...props });
  const check = (stat, contextOverrides) => checkConnectionFileSafety('/tmp/commonpost-mcp/connection.json', makeContext({ fsImpl: { lstatSync: () => stat }, ...contextOverrides }));

  it('accepts a regular file of the current user that nobody else can read', () => {
    assert.equal(check(file()), null);
  });

  it('refuses a symlink, a file that is not regular, another owner, group or other access, and an unknown current user', () => {
    assert.equal(check(file({ isSymbolicLink: () => true })), 'refused: connection file is a symlink');
    assert.equal(check(file({ isFile: () => false })), 'refused: connection file is not a regular file');
    assert.equal(check(file({ uid: 0 })), 'refused: connection file is owned by uid 0, not the current uid 1000');
    assert.equal(check(file({ mode: 0o100640 })), 'refused: connection file mode 640 gives group/other access (expected 600)');
    assert.equal(check(file(), { uid: null }), 'refused: cannot determine the current user id to check the connection file owner');
    assert.equal(check(file(), { uid: undefined }), 'refused: cannot determine the current user id to check the connection file owner');
  });
});

describe('connection file folder safety', () => {
  const dir = (props = {}) => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40700, ...props });
  const check = (stat, contextOverrides = {}) => checkConnectionDirSafety('/tmp/commonpost-mcp/connection.json', makeContext({ fsImpl: { lstatSync: () => stat }, ...contextOverrides }));

  it('accepts a folder of the current user closed to group and others', () => {
    assert.equal(check(dir()), null);
  });

  it('refuses a symlink, something that is not a folder, an unknown user, another owner and open permissions', () => {
    assert.equal(check(dir({ isSymbolicLink: () => true })), 'refused: connection file folder is a symlink');
    assert.equal(check(dir({ isDirectory: () => false })), 'refused: connection file folder is not a directory');
    assert.equal(check(dir(), { uid: null }), 'refused: cannot determine the current user id to check the connection file folder owner');
    assert.equal(check(dir({ uid: 5 })), 'refused: connection file folder is owned by uid 5, not the current uid 1000');
    assert.equal(check(dir({ mode: 0o40755 })), 'refused: connection file folder mode 755 gives group/other access (expected 700)');
  });

  it('says why when the folder cannot be examined, and does not look at all on Windows', () => {
    assert.equal(checkConnectionDirSafety('/x/connection.json', makeContext({ fsImpl: { lstatSync() { throw fsError('EACCES'); } } })), 'permission denied');
    const never = { lstatSync() { throw new Error('must not be called'); } };
    assert.equal(checkConnectionDirSafety('C:\\x\\connection.json', makeContext({ fsImpl: never, platform: 'win32' })), null);
  });
});

describe('Windows: the connection file must live under the current user\'s %TEMP%', () => {
  const TEMP = 'C:\\Users\\me\\AppData\\Local\\Temp';
  const withRealpaths = (map, { native = false } = {}) => {
    const resolve = (p) => {
      if (!(p in map)) throw fsError('ENOENT');
      return map[p];
    };
    return native ? { realpathSync: Object.assign(() => { throw new Error('the JavaScript form must not be used'); }, { native: resolve }) } : { realpathSync: resolve };
  };
  const context = (fsImpl, extra = {}) => makeContext({ fsImpl, platform: 'win32', osImpl: { tmpdir: () => TEMP, homedir: () => 'C:\\Users\\me' }, ...extra });
  const FILE = `${TEMP}\\commonpost-mcp\\connection.json`;

  it('accepts a file whose real path is under %TEMP%, with either form of realpath, case-insensitively', () => {
    const map = { [FILE]: FILE.toUpperCase(), [TEMP]: TEMP };
    assert.equal(checkWindowsTempContainment(FILE, context(withRealpaths(map))), null);
    assert.equal(checkWindowsTempContainment(FILE, context(withRealpaths(map, { native: true }))), null);
  });

  it('refuses a file that resolves outside %TEMP%, also through a folder that merely starts with the same letters', () => {
    const outside = { [FILE]: 'D:\\elsewhere\\connection.json', [TEMP]: TEMP };
    assert.match(checkWindowsTempContainment(FILE, context(withRealpaths(outside))), /^refused: connection file is not under the current user's %TEMP% \(C:\\Users\\me\\AppData\\Local\\Temp\)$/);
    const lookAlike = { [FILE]: `${TEMP}2\\commonpost-mcp\\connection.json`, [TEMP]: TEMP };
    assert.match(checkWindowsTempContainment(FILE, context(withRealpaths(lookAlike))), /not under the current user's %TEMP%/);
  });

  it('refuses, with the reason, when the file or %TEMP% cannot be resolved', () => {
    assert.equal(checkWindowsTempContainment(FILE, context(withRealpaths({ [TEMP]: TEMP }))), 'refused: cannot resolve the connection file or %TEMP% (file not found)');
    assert.equal(checkWindowsTempContainment(FILE, context(withRealpaths({ [FILE]: FILE }))), 'refused: cannot resolve the connection file or %TEMP% (file not found)');
  });

  it('works with a context that has no path implementation, or one without Windows rules, using Windows path rules', () => {
    const map = { [FILE]: FILE, [TEMP]: `${TEMP}\\` };
    const osImpl = { tmpdir: () => TEMP };
    assert.equal(checkWindowsTempContainment(FILE, { fsImpl: withRealpaths(map), osImpl }), null);
    assert.equal(checkWindowsTempContainment(FILE, { fsImpl: withRealpaths(map), osImpl, pathImpl: { join: path.join } }), null);
    assert.match(checkWindowsTempContainment(FILE, { fsImpl: withRealpaths({ [FILE]: 'D:\\x\\connection.json', [TEMP]: TEMP }), osImpl }), /not under the current user's %TEMP%/);
  });

  it('refuses a UNC path before touching the file system', () => {
    const never = { lstatSync() { throw new Error('must not be called'); } };
    assert.equal(checkConnectionFileSafety('\\\\server\\share\\connection.json', context(never)), 'refused: UNC or device path for the connection file');
  });
});

describe('reading the connection file through one descriptor', () => {
  function makeFs({ lstat = {}, fstat = {}, content = '{"port":1}', open, readChunk } = {}) {
    const base = { isSymbolicLink: () => false, isFile: () => true, dev: 5, ino: 9, uid: 1000, mode: 0o100600, size: content.length };
    const log = { closed: [] };
    return {
      log,
      lstatSync: () => ({ ...base, ...lstat }),
      openSync(file) {
        if (open) throw open;
        log.opened = file;
        return 42;
      },
      fstatSync: () => ({ ...base, ...fstat }),
      readSync(fd, buffer, offset, length, _position) {
        const chunk = readChunk ? readChunk(offset) : Buffer.from(content).subarray(offset, offset + length);
        chunk.copy(buffer, offset);
        return chunk.length;
      },
      closeSync(fd) { log.closed.push(fd); },
    };
  }
  const read = (fsImpl, overrides) => readConnectionFileVerified('/tmp/commonpost-mcp/connection.json', makeContext({ fsImpl, ...overrides }));

  it('returns the text and closes the descriptor', () => {
    const fsImpl = makeFs();
    assert.equal(read(fsImpl), '{"port":1}');
    assert.deepEqual(fsImpl.log.closed, [42]);
  });

  it('refuses a symlink or a file that is not regular, before opening it', () => {
    const symlink = makeFs({ lstat: { isSymbolicLink: () => true } });
    assert.throws(() => read(symlink), /refused: connection file is a symlink/);
    assert.equal(symlink.log.opened, undefined);
    assert.throws(() => read(makeFs({ lstat: { isFile: () => false } })), /refused: connection file is not a regular file/);
  });

  it('treats an open that fails with ELOOP as a symlink and passes on any other failure, whatever it is', () => {
    assert.throws(() => read(makeFs({ open: fsError('ELOOP') })), /refused: connection file is a symlink/);
    assert.throws(() => read(makeFs({ open: fsError('EACCES') })), (e) => e.code === 'EACCES');
    assert.throws(() => read(makeFs({ open: fsError('EMFILE', 'too many open files') })), /too many open files/);
    const nothing = makeFs();
    nothing.openSync = () => { throw undefined; }; // eslint-disable-line no-throw-literal -- a failure with no value at all
    assert.throws(() => read(nothing), (e) => e === undefined);
  });

  it('refuses what turned out not to be a regular file, or another file than the one examined, and still closes', () => {
    const notRegular = makeFs({ fstat: { isFile: () => false } });
    assert.throws(() => read(notRegular), /refused: connection file is not a regular file/);
    assert.deepEqual(notRegular.log.closed, [42]);
    assert.throws(() => read(makeFs({ fstat: { ino: 10 } })), /changed while it was being checked/);
    assert.throws(() => read(makeFs({ fstat: { dev: 6 } })), /changed while it was being checked/);
  });

  it('checks the owner and the mode again on the opened file, on POSIX', () => {
    assert.throws(() => read(makeFs({ fstat: { uid: 0 } })), /owned by uid 0, not the current uid 1000/);
    assert.throws(() => read(makeFs({ fstat: { mode: 0o100644 } })), /mode 644 gives group\/other access/);
  });

  it('refuses a size that is not plausible: not an integer, negative or past 64 KiB', () => {
    for (const size of [Number.NaN, 1.5, -1, 64 * 1024 + 1, Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(() => read(makeFs({ fstat: { size } })), /connection file size .* is not plausible \(limit 65536 bytes\)/, String(size));
    }
  });

  it('reads as much as the file gives: a file that ends early returns what it held', () => {
    const fsImpl = makeFs({ content: '{"port":1}', fstat: { size: 20 }, readChunk: (offset) => (offset === 0 ? Buffer.from('{"po') : Buffer.alloc(0)) });
    assert.equal(read(fsImpl), '{"po');
  });

  it('on Windows, redoes the %TEMP% check on the real path before reading', () => {
    const fsImpl = makeFs();
    fsImpl.realpathSync = (p) => (p === 'C:\\tmp' ? 'C:\\tmp' : 'D:\\elsewhere\\connection.json');
    assert.throws(
      () => readConnectionFileVerified('C:\\tmp\\commonpost-mcp\\connection.json', makeContext({ fsImpl, platform: 'win32', osImpl: { tmpdir: () => 'C:\\tmp', homedir: () => 'C:\\' } })),
      /refused: connection file is not under the current user's %TEMP%/);
    assert.deepEqual(fsImpl.log.closed, [42]);
  });
});

describe('the process that wrote the connection file', () => {
  const candidate = { label: 'native tmp', path: '/tmp/commonpost-mcp/connection.json' };
  const processWith = (kill) => ({ platform: 'linux', env: {}, kill });
  const check = (data, { cand = candidate, kill = () => {}, readlink = () => '/usr/lib/thunderbird/thunderbird', platform = 'linux', processImpl } = {}) =>
    checkConnectionOwnerProcess(data, cand, makeContext({ platform, fsImpl: { readlinkSync: readlink }, processImpl: processImpl === undefined ? processWith(kill) : processImpl }));

  it('accepts a file with no data or no usable pid, without asking about any process', () => {
    const asked = [];
    const kill = (pid) => asked.push(pid);
    for (const data of [null, undefined, {}, { pid: 0 }, { pid: -4 }, { pid: 1.5 }, { pid: '12' }, { pid: Number.MAX_SAFE_INTEGER + 1 }]) {
      assert.equal(check(data, { kill }), null, JSON.stringify(data));
    }
    assert.deepEqual(asked, []);
  });

  it('does not check the pid of a Flatpak sandbox, which has its own pid namespace', () => {
    const asked = [];
    assert.equal(check({ pid: 5 }, { cand: { label: 'Flatpak (org.mozilla.thunderbird)', path: '/x' }, kill: (pid) => asked.push(pid) }), null);
    assert.deepEqual(asked, []);
  });

  it('checks a pid for a candidate that has no label, and for one with another label', () => {
    const asked = [];
    check({ pid: 6 }, { cand: { path: '/x' }, kill: (pid, signal) => asked.push([pid, signal]) });
    check({ pid: 7 }, { cand: { label: 'native tmp', path: '/x' }, kill: (pid, signal) => asked.push([pid, signal]) });
    assert.deepEqual(asked, [[6, 0], [7, 0]]);
  });

  it('accepts when the context has no process at all', () => {
    assert.equal(checkConnectionOwnerProcess({ pid: 5 }, candidate, { fsImpl: {}, pathImpl: path, procRoot: '/proc', platform: 'linux' }), null);
  });

  it('accepts when the process cannot be asked about at all', () => {
    assert.equal(check({ pid: 5 }, { processImpl: {} }), null);
    assert.equal(check({ pid: 5 }, { processImpl: { kill: 'not a function' } }), null);
    // A null processImpl given to createDiscoveryContext() means "the real process": pass the context directly.
    assert.equal(checkConnectionOwnerProcess({ pid: 5 }, candidate, { fsImpl: {}, pathImpl: path, procRoot: '/proc', platform: 'linux', processImpl: null }), null);
  });

  it('refuses a process that is gone, and one of another user', () => {
    assert.equal(check({ pid: 5 }, { kill: () => { throw fsError('ESRCH'); } }), 'refused: stale connection file: process 5 is not running');
    assert.equal(check({ pid: 5 }, { kill: () => { throw fsError('EPERM'); } }), 'refused: connection file process 5 belongs to another user');
  });

  it('does not refuse on any other answer: EPERM on Windows, another code, or nothing', () => {
    assert.equal(check({ pid: 5 }, { platform: 'win32', kill: () => { throw fsError('EPERM'); } }), null);
    assert.equal(check({ pid: 5 }, { kill: () => { throw fsError('EINVAL'); } }), null);
    assert.equal(check({ pid: 5 }, { kill: () => { throw undefined; } }), null); // eslint-disable-line no-throw-literal -- a failure with no value
    assert.equal(check({ pid: 5 }, { kill: () => { throw null; } }), null); // eslint-disable-line no-throw-literal -- same
  });

  it('on Linux, requires the process to be Thunderbird or Betterbird when its executable can be read', () => {
    assert.equal(check({ pid: 5 }, { readlink: () => '/usr/lib/thunderbird/thunderbird-bin' }), null);
    assert.equal(check({ pid: 5 }, { readlink: () => '/opt/betterbird/betterbird' }), null);
    assert.equal(check({ pid: 5 }, { readlink: () => '/nix/store/x/bin/.thunderbird-wrapped' }), null);
    assert.equal(check({ pid: 5 }, { readlink: () => '/usr/lib/thunderbird/thunderbird (deleted)' }), null);
    assert.equal(check({ pid: 5 }, { readlink: () => '/usr/bin/python3' }), 'refused: connection file process 5 is not Thunderbird or Betterbird (python3)');
  });

  it('on Linux, does not refuse because the executable cannot be read or has no name', () => {
    assert.equal(check({ pid: 5 }, { readlink() { throw fsError('EACCES'); } }), null);
    assert.equal(check({ pid: 5 }, { readlink: () => '' }), null);
    assert.equal(check({ pid: 5 }, { readlink: () => 42 }), null);
  });

  it('only looks at the executable on Linux', () => {
    assert.equal(check({ pid: 5 }, { platform: 'darwin', readlink() { throw new Error('must not be called'); } }), null);
  });
});

describe('the macOS scan', () => {
  // /var/folders/<a>/<b>/T/commonpost-mcp/connection.json
  function macFs({ tree, stats = {}, readdirFails = new Set() }) {
    return {
      readdirSync(dir) {
        if (readdirFails.has(dir)) throw fsError('EACCES');
        const entries = tree[dir];
        if (!entries) throw fsError('ENOENT');
        return entries.map(([name, isDirectory = true]) => dirent(name, isDirectory));
      },
      statSync(file) {
        if (!(file in stats)) throw fsError('ENOENT');
        if (stats[file] instanceof Error) throw stats[file];
        return stats[file];
      },
    };
  }
  const regular = (mtimeMs, uid = 501) => ({ isFile: () => true, uid, mtimeMs });
  const scan = (fsImpl, extra = {}) => findMacOsConnectionCandidates(makeContext({ fsImpl, platform: 'darwin', uid: 501, ...extra }));
  const FILE = (a, b) => `/var/folders/${a}/${b}/T/commonpost-mcp/connection.json`;

  it('says why when the folders root cannot be listed', () => {
    const result = scan({ readdirSync() { throw fsError('EACCES'); } });
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.notes, [{ label: 'macOS temp scan', path: '/var/folders/*/*/T/commonpost-mcp/connection.json', reason: 'permission denied' }]);
  });

  it('finds the user\'s files, newest first, and names the number of matches', () => {
    const result = scan(macFs({
      tree: { '/var/folders': [['aa'], ['bb']], '/var/folders/aa': [['x1']], '/var/folders/bb': [['y1']] },
      stats: { [FILE('aa', 'x1')]: regular(100), [FILE('bb', 'y1')]: regular(200) },
    }));
    assert.deepEqual(result.candidates.map((c) => c.path), [FILE('bb', 'y1'), FILE('aa', 'x1')]);
    assert.match(result.notes[0].reason, /multiple matches found, trying newest first \(2 files\)/);
  });

  it('puts files of the same age in path order', () => {
    const result = scan(macFs({
      tree: { '/var/folders': [['zz'], ['aa']], '/var/folders/aa': [['x']], '/var/folders/zz': [['x']] },
      stats: { [FILE('aa', 'x')]: regular(100), [FILE('zz', 'x')]: regular(100) },
    }));
    assert.deepEqual(result.candidates.map((c) => c.path), [FILE('aa', 'x'), FILE('zz', 'x')]);
  });

  it('skips what is not a folder, a folder that cannot be listed, a path that is not a file, a file of another user and a stat that fails', () => {
    const result = scan(macFs({
      tree: {
        '/var/folders': [['plain-file', false], ['denied'], ['aa']],
        '/var/folders/denied': [['x']],
        '/var/folders/aa': [['not-a-dir', false], ['dirpath'], ['other-user'], ['broken'], ['good']],
      },
      readdirFails: new Set(['/var/folders/denied']),
      stats: {
        [FILE('aa', 'dirpath')]: { isFile: () => false, uid: 501, mtimeMs: 1 },
        [FILE('aa', 'other-user')]: regular(50, 0),
        [FILE('aa', 'broken')]: fsError('EIO'),
        [FILE('aa', 'good')]: regular(10),
      },
    }));
    assert.deepEqual(result.candidates.map((c) => c.path), [FILE('aa', 'good')]);
    assert.deepEqual(result.notes, []);
  });

  it('skips a folder without the bridge\'s file: the file is missing, or a part of its path is not a folder', () => {
    const result = scan(macFs({
      tree: { '/var/folders': [['aa']], '/var/folders/aa': [['absent'], ['not-a-folder'], ['good']] },
      stats: { [FILE('aa', 'not-a-folder')]: fsError('ENOTDIR'), [FILE('aa', 'good')]: regular(10) },
    }));
    assert.deepEqual(result.candidates.map((c) => c.path), [FILE('aa', 'good')]);
  });

  it('with no match, says so, naming the user id when there is one', () => {
    const empty = macFs({ tree: { '/var/folders': [] } });
    assert.equal(scan(empty).notes[0].reason, 'no matching files owned by uid 501');
    assert.equal(scan(empty, { uid: null }).notes[0].reason, 'no matching files');
    assert.equal(scan(empty, { uid: undefined }).notes[0].reason, 'no matching files');
  });

  it('does not filter by owner when the user id is unknown, and counts a file seen twice once', () => {
    const result = scan(macFs({
      tree: { '/var/folders': [['aa'], ['aa']], '/var/folders/aa': [['x']] },
      stats: { [FILE('aa', 'x')]: regular(5, 0) },
    }), { uid: null });
    assert.deepEqual(result.candidates.map((c) => c.path), [FILE('aa', 'x')]);
  });
});

describe('the Snap scan', () => {
  const HOME = '/home/u';
  const SNAP_TMP = '/home/u/snap/thunderbird/common/tmp';
  const FILE = `${SNAP_TMP}/commonpost-mcp/connection.json`;
  const FALLBACK = `${HOME}/Downloads/thunderbird.tmp/commonpost-mcp/connection.json`;

  function snapFs({ processes = {}, snapDirExists = true, procListFails = null, stats = {} }) {
    return {
      accessSync(dir) {
        if (!snapDirExists) throw fsError('ENOENT');
        assert.equal(dir, `${HOME}/snap/thunderbird`);
      },
      readdirSync(dir) {
        assert.equal(dir, '/proc');
        if (procListFails) throw procListFails;
        return ['self', ...Object.keys(processes), 'thread-self'];
      },
      readFileSync(file) {
        const [, , pid, name] = file.split('/');
        const proc = processes[pid];
        if (!proc || proc[name] === undefined) throw fsError('ENOENT');
        if (proc[name] instanceof Error) throw proc[name];
        return proc[name];
      },
      readlinkSync(file) {
        const pid = file.split('/')[2];
        const exe = processes[pid]?.exe;
        if (exe === undefined || exe instanceof Error) throw fsError('EACCES');
        return exe;
      },
      statSync(file) {
        if (!(file in stats)) throw fsError('ENOENT');
        return stats[file];
      },
    };
  }
  const thunderbird = (extra = {}) => ({
    cmdline: '/snap/thunderbird/123/thunderbird\0--new-instance',
    exe: '/snap/thunderbird/123/thunderbird-bin',
    environ: `SNAP_NAME=thunderbird\0TMPDIR=${SNAP_TMP}\0HOME=${HOME}`,
    ...extra,
  });
  const scan = (fsImpl, extra = {}) => findSnapConnectionCandidates(makeContext({ fsImpl, ...extra }));

  it('says so when there is no home directory, or no Snap install', () => {
    assert.equal(scan(snapFs({}), { homeDir: null }).notes[0].reason, 'home directory unavailable');
    assert.equal(scan(snapFs({ snapDirExists: false })).notes[0].reason, 'snap install not detected');
  });

  it('says why when the process list cannot be read', () => {
    const result = scan(snapFs({ procListFails: fsError('EACCES') }));
    assert.equal(result.notes[0].reason, 'permission denied');
    assert.deepEqual(result.candidates, []);
  });

  it('finds the TMPDIR of a confined Thunderbird, and the Downloads location the snap helper uses, listing one path once', () => {
    const result = scan(snapFs({
      processes: { 100: thunderbird(), 200: thunderbird() },
      stats: { [FILE]: { mtimeMs: 500 }, [FALLBACK]: { mtimeMs: 400 } },
    }));
    assert.deepEqual(result.candidates.map((c) => [c.label, c.path]), [
      ['Snap TMPDIR from /proc/100/environ', FILE],
      ['Snap Downloads fallback', FALLBACK],
    ]);
    assert.match(result.notes[0].reason, /multiple matches found, trying newest first \(2 files\)/);
  });

  it('skips processes that are not Thunderbird, that cannot be read, or are not confined by the snap', () => {
    const result = scan(snapFs({
      processes: {
        1: { cmdline: '' },
        2: { cmdline: '/usr/bin/vim\0thunderbird.txt' },
        3: thunderbird({ exe: new Error('denied') }),
        4: thunderbird({ exe: '/usr/bin/thunderbird' }),
        5: thunderbird({ environ: 'TMPDIR=/tmp\0' }),
        6: thunderbird({ environ: new Error('gone') }),
        7: { cmdline: '/snap/thunderbird/1/betterbird-esr\0', exe: '/snap/thunderbird/1/x', environ: `SNAP_NAME=thunderbird\0TMPDIR=${SNAP_TMP}` },
      },
    }));
    // Neither file exists, so both are equally old and go in path order.
    assert.deepEqual(result.candidates.map((c) => c.label), ['Snap Downloads fallback', 'Snap TMPDIR from /proc/7/environ']);
  });

  it('with a confined process that gives no TMPDIR, still tries the Downloads location', () => {
    const result = scan(snapFs({ processes: { 9: thunderbird({ environ: 'SNAP_NAME=thunderbird\0HOME=/home/u' }) } }));
    assert.deepEqual(result.candidates.map((c) => [c.label, c.mtimeMs]), [['Snap Downloads fallback', Number.NEGATIVE_INFINITY]]);
  });

  it('with no confined process, tries no guess at all, and says so', () => {
    const result = scan(snapFs({ processes: { 1: { cmdline: '/usr/bin/vim' } } }));
    assert.deepEqual(result.candidates, []);
    assert.equal(result.notes[0].reason, 'no thunderbird TMPDIR candidates found');
  });
});

describe('the Flatpak scan', () => {
  const RUNTIME = '/run/user/1000';
  const file = (appId) => `${RUNTIME}/app/${appId}/commonpost-mcp/connection.json`;
  const scan = (statSync, extra = {}) => findFlatpakConnectionCandidates(makeContext({ fsImpl: { statSync }, runtimeDir: RUNTIME, ...extra }));

  it('says the runtime folder is unavailable, naming the pattern it would have used', () => {
    const result = scan(() => { throw new Error('must not be called'); }, { runtimeDir: null });
    assert.equal(result.notes[0].reason, 'runtime dir unavailable');
    assert.ok(result.notes[0].path.startsWith('/run/user/1000/app/{org.mozilla.thunderbird,'));
    assert.deepEqual(result.candidates, []);
  });

  it('keeps the known app ids that have a regular file, skips a path that is not a file or that cannot be read', () => {
    const result = scan((p) => {
      if (p === file('org.mozilla.thunderbird')) return { isFile: () => true, mtimeMs: 10 };
      if (p === file('org.mozilla.thunderbird_esr')) return { isFile: () => false, mtimeMs: 20 };
      if (p === file('org.mozilla.Thunderbird')) throw fsError('EIO');
      throw fsError('ENOENT');
    });
    assert.deepEqual(result.candidates.map((c) => c.label), ['Flatpak (org.mozilla.thunderbird)']);
    assert.deepEqual(result.notes, []);
  });

  it('with no file, says so', () => {
    const result = scan(() => { throw fsError('ENOTDIR'); });
    assert.equal(result.notes[0].reason, 'no matching files for a known Thunderbird/Betterbird Flatpak id');
  });
});

describe('discovery end to end on a real folder', () => {
  function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cp-discovery-'));
  }
  const pinned = (file) => ({ env: { COMMONPOST_MCP_CONNECTION_FILE: file }, platform: 'linux', uid: process.getuid ? process.getuid() : 0, homeDir: '/nonexistent', runtimeDir: null });

  function connectionFile(dir, content) {
    const file = path.join(dir, 'connection.json');
    fs.writeFileSync(file, content, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  }

  it('explains a named file that holds JSON null (the data cannot be read at all)', { skip: process.platform === 'win32' }, () => {
    const dir = tempDir();
    try {
      const file = connectionFile(dir, 'null');
      const result = discoverConnectionInfo(pinned(file));
      assert.deepEqual(result.candidates, []);
      assert.equal(result.attempts.length, 1);
      assert.match(result.attempts[0].reason, /Cannot read properties of null/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explains a named file that is not JSON, lacks a port or a token, or is an array', { skip: process.platform === 'win32' }, () => {
    const dir = tempDir();
    try {
      assert.match(discoverConnectionInfo(pinned(connectionFile(dir, '{ nope'))).attempts[0].reason, /^malformed JSON \(/);
      assert.equal(discoverConnectionInfo(pinned(connectionFile(dir, '{"port":8780}'))).attempts[0].reason, 'missing port or token');
      assert.equal(discoverConnectionInfo(pinned(connectionFile(dir, '[]'))).attempts[0].reason, 'missing port or token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explains a named file that cannot be opened, with the reason of the error', () => {
    const stat = { isSymbolicLink: () => false, isFile: () => true, dev: 1, ino: 1, uid: 1000, mode: 0o100600, size: 5 };
    const fsImpl = { lstatSync: () => stat, openSync() { throw fsError('EACCES'); } };
    const result = discoverConnectionInfo({ env: { COMMONPOST_MCP_CONNECTION_FILE: '/x/connection.json' }, platform: 'linux', uid: 1000, fsImpl, homeDir: null, runtimeDir: null });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.attempts[0].reason, 'permission denied');
    assert.equal(result.attempts[0].label, 'COMMONPOST_MCP_CONNECTION_FILE');
  });

  it('groups the candidates: only the named file when one is named, the placeholder of an empty bundle option ignored', () => {
    assert.equal(buildCandidateGroups({ env: { COMMONPOST_MCP_CONNECTION_FILE: '/x/connection.json' }, platform: 'linux', uid: 1, homeDir: null, runtimeDir: null }).length, 1);
    const groups = buildCandidateGroups({ env: { COMMONPOST_MCP_CONNECTION_FILE: '${user_config.connection_file}' }, platform: 'darwin', uid: 1, homeDir: null, runtimeDir: null });
    assert.equal(groups.length, 2, 'the native location and the macOS scan');
    assert.equal(groups[0].candidates[0].label, 'native tmp');
  });
});
