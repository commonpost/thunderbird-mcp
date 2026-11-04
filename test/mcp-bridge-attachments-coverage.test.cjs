// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';

// The bridge reads file attachments for the add-on: the path rules, the checks on the file as found, the way each
// file-system failure is worded for the caller, and the guard against a file that changes between the check and the
// read. Failures that cannot be made on a real disk (a read that returns nothing, a file replaced after the check)
// are given through stand-ins for fs.promises.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildProtectedContext,
  inlineAttachmentPaths,
  inspectAttachmentPath,
  isInsideProtectedDirs,
  isSensitiveFilePath,
  isUncOrDevicePath,
  isUnderProtectedDirectory,
  readAttachmentFromPath,
  sanitizeProtectedDirs,
  sensitiveAttachmentMessage,
  sensitivePathComponentReason,
  validateAttachmentStat,
  windowsPathAmbiguity,
} = require('../mcp-bridge.cjs');

function fsError(code, message) {
  return Object.assign(new Error(message ?? code), { code });
}

describe('which path components are sensitive', () => {
  it('has no reason for an empty path, or one that is only slashes', () => {
    assert.equal(sensitivePathComponentReason(''), null);
    assert.equal(sensitivePathComponentReason('/'), null);
    assert.equal(sensitivePathComponentReason('///'), null);
  });

  it('names a dotfile or dot-folder, but not "." or ".." or a one-character name', () => {
    assert.equal(sensitivePathComponentReason('/home/u/.ssh/key'), 'dotfile');
    assert.equal(sensitivePathComponentReason('/home/u/.env'), 'dotfile');
    assert.equal(sensitivePathComponentReason('/home/u/./x/../y'), null);
    assert.equal(sensitivePathComponentReason('/a/b/c'), null);
  });

  it('names the AppData folders, except the add-on\'s own folder under a temp folder', () => {
    assert.equal(sensitivePathComponentReason('/users/u/appdata/roaming/x'), 'appdata');
    assert.equal(sensitivePathComponentReason('/users/u/application data/x'), 'appdata');
    assert.equal(sensitivePathComponentReason('/users/u/appdata/local/temp/commonpost-mcp/x.txt'), null);
    assert.equal(sensitivePathComponentReason('/users/u/appdata/local/temp/other/x.txt'), 'appdata');
    assert.equal(sensitivePathComponentReason('/users/u/appdata/roaming/commonpost-mcp/x.txt'), 'appdata', 'only directly under temp or tmp');
    assert.equal(sensitivePathComponentReason('/users/u/appdata/local/temp/commonpost-mcp/../x'), 'appdata', 'a ".." takes the exemption away');
  });

  it('names a file whose own name holds credentials, wherever it is', () => {
    assert.equal(sensitivePathComponentReason('/home/u/documents/credentials.json'), 'filename');
    assert.equal(sensitivePathComponentReason('/home/u/documents/work.ovpn'), 'filename');
    assert.equal(sensitivePathComponentReason('/home/u/documents/report.pdf'), null);
  });

  it('words the refusal of an AppData path differently from the others', () => {
    assert.match(sensitiveAttachmentMessage('C:\\Users\\u\\AppData\\Local\\Temp\\a.txt'), /^Attachment path blocked: files under AppData \(on Windows this includes %TEMP%\) can't be attached; copy the file to another folder/);
    assert.equal(sensitiveAttachmentMessage('/home/u/.ssh/key'), 'Sensitive attachment path blocked: /home/u/.ssh/key');
    assert.equal(sensitiveAttachmentMessage('/a/link', '/home/u/.ssh/key', ' (resolves to /home/u/.ssh/key)'), 'Sensitive attachment path blocked: /a/link (resolves to /home/u/.ssh/key)');
  });
});

describe('path forms that mean something else on Windows', () => {
  it('has no opinion about a value that is not text', () => {
    for (const value of [undefined, null, 42, {}]) assert.equal(windowsPathAmbiguity(value, 'C:\\tmp'), null);
  });

  it('refuses an alternate data stream, a reserved device name, a trailing dot or space and an 8.3 short name', () => {
    assert.match(windowsPathAmbiguity('C:\\x\\logins.json::$DATA', ''), /alternate data stream/);
    assert.match(windowsPathAmbiguity('C:\\x\\NUL.txt', ''), /Windows device \("NUL\.txt"\)/);
    assert.match(windowsPathAmbiguity('C:\\x\\a.pem.', ''), /ending with a dot or a space/);
    assert.match(windowsPathAmbiguity('C:\\x\\THUNDE~1\\a.txt', ''), /8\.3 short-name component \("THUNDE~1"\)/);
    assert.equal(windowsPathAmbiguity('C:\\Users\\me\\report.pdf', ''), null);
  });

  it('lets an 8.3 name through only inside the known temp folder, and applies every other rule there', () => {
    assert.equal(windowsPathAmbiguity('C:\\Users\\JEANTR~1\\AppData\\Local\\Temp\\a.txt', 'C:\\Users\\JEANTR~1\\AppData\\Local\\Temp'), null);
    assert.match(windowsPathAmbiguity('C:\\Users\\JEANTR~1\\AppData\\Local\\Temp\\THUNDE~1\\a.txt', 'C:\\Users\\JEANTR~1\\AppData\\Local\\Temp'), /8\.3 short-name component \("THUNDE~1"\)/);
    assert.match(windowsPathAmbiguity('C:\\Users\\JEANTR~1\\x.txt', 'C:\\Users\\OTHER\\Temp'), /8\.3 short-name/, 'not under the known folder');
    assert.match(windowsPathAmbiguity('C:\\THUNDE~1\\x.txt', 'C:\\'), /8\.3 short-name/, 'a drive root as the known folder has no components to match');
    assert.match(windowsPathAmbiguity('C:\\a\\THUNDE~1', 'C:\\a\\b\\c\\d'), /8\.3 short-name/, 'a known folder deeper than the path');
    assert.match(windowsPathAmbiguity('C:\\x\\THUNDE~1', 42), /8\.3 short-name/);
  });

  it('refuses UNC and device paths whatever the slash, and nothing that is not text', () => {
    for (const value of ['\\\\server\\share\\a', '//server/share/a', '\\\\?\\C:\\a', '/??/C:/a']) assert.equal(isUncOrDevicePath(value), true, value);
    for (const value of [undefined, null, '', 42, '/home/u/a', 'C:\\a']) assert.equal(isUncOrDevicePath(value), false, String(value));
  });
});

describe('sensitive file paths', () => {
  it('does not take a path of only slashes, an empty one or one that is not text for sensitive', () => {
    assert.equal(isSensitiveFilePath('/'), false);
    assert.equal(isSensitiveFilePath(''), false);
    assert.equal(isSensitiveFilePath(undefined), false);
    assert.equal(isSensitiveFilePath(42), false);
  });

  it('refuses the Library folder of the bridge\'s own home directory, wherever the home is', (t) => {
    t.mock.method(os, 'homedir', () => '/data/homes/alice/');
    assert.equal(isSensitiveFilePath('/data/homes/alice/Library/Mail/x', false), true);
    assert.equal(isSensitiveFilePath('/data/homes/alice/library', false), true);
    assert.equal(isSensitiveFilePath('/data/homes/alice/Documents/x', false), false);
    assert.equal(isSensitiveFilePath('/data/homes/alice2/Library/x', false), false);
  });

  it('puts no limit on a path when the home directory cannot be found, or is only a root', (t) => {
    const homedir = t.mock.method(os, 'homedir', () => { throw new Error('ENOENT: no home'); });
    assert.equal(isSensitiveFilePath('/data/library/x', false), false);
    homedir.mock.mockImplementation(() => '');
    assert.equal(isSensitiveFilePath('/data/library/x', false), false);
    homedir.mock.mockImplementation(() => '/');
    assert.equal(isSensitiveFilePath('/library/x', false), false);
  });
});

describe('protected directories', () => {
  it('a path inside one is refused, one outside is not; bad arguments never match', () => {
    assert.equal(isInsideProtectedDirs('/data/tb/Mail/x', ['/data/tb']), true);
    assert.equal(isInsideProtectedDirs('/data/tb', ['/data/tb/']), true);
    assert.equal(isInsideProtectedDirs('/data/tb2/x', ['/data/tb']), false);
    assert.equal(isInsideProtectedDirs('/data/tb/x', ['/']), false, 'a root is never a protected directory');
    assert.equal(isInsideProtectedDirs('/data/tb/x', [42, '', null, 'C:']), false);
    assert.equal(isInsideProtectedDirs(undefined, ['/data/tb']), false);
    assert.equal(isInsideProtectedDirs('', ['/data/tb']), false);
    assert.equal(isInsideProtectedDirs('/data/tb/x', 'not a list'), false);
    assert.equal(isInsideProtectedDirs('/data/tb/x', undefined), false);
  });

  it('keeps only absolute paths of reasonable length from the connection file', () => {
    assert.deepEqual(sanitizeProtectedDirs(['/a', 'relative', '', 7, null, `/${'x'.repeat(4100)}`, '/b']), ['/a', '/b']);
    assert.deepEqual(sanitizeProtectedDirs('not a list'), []);
    assert.deepEqual(sanitizeProtectedDirs(undefined), []);
  });
});

describe('the stat of an attachment', () => {
  const file = (props = {}) => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1, size: 10, ...props });

  it('accepts a regular file with one name and a plausible size', () => {
    assert.doesNotThrow(() => validateAttachmentStat('/a/b.txt', file()));
    assert.doesNotThrow(() => validateAttachmentStat('/a/b.txt', file({ nlink: undefined })), 'no link count reported');
  });

  it('refuses a symlink, a folder, a file with other names and a size that is not an integer or is negative', () => {
    assert.throws(() => validateAttachmentStat('/a/b', file({ isSymbolicLink: () => true })), /Attachment path is a symlink and is not allowed: \/a\/b/);
    assert.throws(() => validateAttachmentStat('/a/b', file({ isFile: () => false })), /Attachment is not a regular file: \/a\/b/);
    assert.throws(() => validateAttachmentStat('/a/b', file({ nlink: 2 })), /Attachment has other hard links; attach a copy instead: \/a\/b/);
    for (const size of [Number.NaN, 1.5, -1, Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(() => validateAttachmentStat('/a/b', file({ size })), /Attachment has an invalid file size: \/a\/b/, String(size));
    }
    assert.throws(() => validateAttachmentStat('/a/b', file({ size: 18 * 1024 * 1024 + 1 })), /Attachment too large: \/a\/b is 18874369 bytes \(limit 18874368 bytes \/ 18 MB raw before base64\)/);
    assert.doesNotThrow(() => validateAttachmentStat('/a/b', file({ size: 18 * 1024 * 1024 })));
  });
});

describe('reading an attachment from a path', () => {
  let root;
  let report;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.homedir() : os.tmpdir(), 'cp-att-cov-'));
    report = path.join(root, 'report.pdf');
    fs.writeFileSync(report, 'hello');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const options = { protectedDirs: [] };

  it('words each failure to examine the file by its code, and "unknown" when there is none', async (t) => {
    const lstat = t.mock.method(fs.promises, 'lstat', async () => { throw fsError('ENOENT'); });
    await assert.rejects(inspectAttachmentPath(report, options), (e) => e.message === `Attachment not found: ${report}` && e.cause.code === 'ENOENT');
    lstat.mock.mockImplementation(async () => { throw fsError('EACCES'); });
    await assert.rejects(inspectAttachmentPath(report, options), new RegExp(`^Error: Attachment unreadable \\(permission denied\\): ${report.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    lstat.mock.mockImplementation(async () => { throw fsError('EPERM'); });
    await assert.rejects(inspectAttachmentPath(report, options), /Attachment unreadable \(permission denied\)/);
    lstat.mock.mockImplementation(async () => { throw fsError('EIO'); });
    await assert.rejects(inspectAttachmentPath(report, options), /Attachment lstat failed \(EIO\)/);
    lstat.mock.mockImplementation(async () => { throw new Error('no code'); });
    await assert.rejects(inspectAttachmentPath(report, options), /Attachment lstat failed \(unknown\)/);
    lstat.mock.mockImplementation(async () => { throw undefined; }); // eslint-disable-line no-throw-literal -- a rejection with no value
    await assert.rejects(inspectAttachmentPath(report, options), /Attachment lstat failed \(unknown\)/);
  });

  it('words a failure to resolve the real path the same way', async (t) => {
    const realpath = t.mock.method(fs.promises, 'realpath', async () => { throw fsError('ELOOP'); });
    await assert.rejects(inspectAttachmentPath(report, options), /Attachment realpath failed \(ELOOP\)/);
    realpath.mock.mockImplementation(async () => { throw fsError('ENOENT'); });
    await assert.rejects(inspectAttachmentPath(report, options), /Attachment not found/);
  });

  it('refuses a path that is not a non-empty string before looking at the disk', async () => {
    for (const bad of ['', undefined, null, 42, {}]) {
      await assert.rejects(inspectAttachmentPath(bad, options), /Attachment path must be a non-empty string/);
    }
  });

  it('refuses a real path that falls in a protected directory, or a folder with the same identity', async () => {
    const protectedRoot = path.join(root, 'profile');
    fs.mkdirSync(path.join(protectedRoot, 'Mail'), { recursive: true });
    const inside = path.join(protectedRoot, 'Mail', 'inbox.txt');
    fs.writeFileSync(inside, 'secret');
    await assert.rejects(inspectAttachmentPath(inside, { protectedDirs: [protectedRoot] }), /Attachment path blocked: files of a Thunderbird profile or mail store can't be attached/);
    const info = await inspectAttachmentPath(report, { protectedDirs: [protectedRoot] });
    assert.equal(info.realPath, fs.realpathSync(report));
    const context = await buildProtectedContext([protectedRoot]);
    assert.equal(await isUnderProtectedDirectory(fs.realpathSync(inside), context), true);
    assert.equal(await isUnderProtectedDirectory(fs.realpathSync(report), context), false);
    assert.equal(await isUnderProtectedDirectory(fs.realpathSync(report), { ids: new Set() }), false);
  });

  it('builds the protected context only from directories that exist and are not roots', async (t) => {
    const protectedRoot = path.join(root, 'profile');
    fs.mkdirSync(protectedRoot);
    const aFile = path.join(root, 'just-a-file');
    fs.writeFileSync(aFile, 'x');
    const context = await buildProtectedContext([protectedRoot, path.join(root, 'missing'), aFile, '/', 'relative/dir']);
    assert.deepEqual(context.dirs, [protectedRoot, path.join(root, 'missing'), aFile, '/']);
    assert.deepEqual(context.realDirs.sort(), [fs.realpathSync(protectedRoot), fs.realpathSync(aFile)].sort());
    assert.equal(context.ids.size, 1, 'only the directory has an identity; the file has none');

    t.mock.method(fs.promises, 'stat', async () => { throw fsError('EACCES'); });
    const noStat = await buildProtectedContext([protectedRoot]);
    assert.deepEqual(noStat.realDirs, [fs.realpathSync(protectedRoot)], 'the real path is still checked');
    assert.equal(noStat.ids.size, 0);
  });

  it('leaves a directory that resolves to a root out of the protected context', async (t) => {
    const protectedRoot = path.join(root, 'profile');
    fs.mkdirSync(protectedRoot);
    t.mock.method(fs.promises, 'realpath', async () => '/');
    const context = await buildProtectedContext([protectedRoot]);
    assert.deepEqual(context.realDirs, []);
    assert.equal(context.ids.size, 0);
  });

  it('goes on without protected directories when the bridge cannot even look for Thunderbird', async (t) => {
    t.mock.method(os, 'homedir', () => { throw new Error('no home directory'); });
    const info = await inspectAttachmentPath(report);
    assert.equal(info.filePath, report);
  });

  it('refuses a path that resolves to a sensitive place although the path as given looks fine', async () => {
    await assert.rejects(inspectAttachmentPath('/tmp/../etc/passwd', options), (e) => e.message === 'Sensitive attachment path blocked: /tmp/../etc/passwd');
  });

  it('refuses a path that is not a non-empty string through the whole of an attachment list', async () => {
    await assert.rejects(inlineAttachmentPaths({ attachments: [report, ''] }, options), /Attachment path must be a non-empty string/);
    const info = await inlineAttachmentPaths({ attachments: [report] }, options);
    assert.deepEqual(info.map((entry) => entry.filePath), [report]);
  });

  it('inlines a file with no options at all (the directories of the connection file found so far)', async () => {
    const args = { attachments: [report] };
    await inlineAttachmentPaths(args);
    assert.deepEqual(args.attachments, [{ name: 'report.pdf', contentType: 'application/pdf', base64: Buffer.from('hello').toString('base64') }]);
    assert.equal((await inspectAttachmentPath(report)).filePath, report);
  });

  it('names the type of a file by its extension, case-insensitively, with a default', async () => {
    const cases = { 'a.PNG': 'image/png', 'b.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'c.unknownext': 'application/octet-stream', 'noextension': 'application/octet-stream', 'd.7z': 'application/x-7z-compressed' };
    for (const [name, type] of Object.entries(cases)) {
      const file = path.join(root, name);
      fs.writeFileSync(file, 'x');
      const args = { attachments: [file] };
      await inlineAttachmentPaths(args, options);
      assert.equal(args.attachments[0].contentType, type, name);
    }
  });

  describe('a file that changes between the check and the read', () => {
    async function prepared() {
      const info = await inspectAttachmentPath(report, options);
      return { ...info };
    }
    const handleOf = (overrides = {}) => ({
      stat: async () => fs.statSync(report),
      read: async (buffer, offset, length, position) => {
        const fd = fs.openSync(report, 'r');
        try {
          return { bytesRead: fs.readSync(fd, buffer, offset, length, position) };
        } finally {
          fs.closeSync(fd);
        }
      },
      close: async () => {},
      ...overrides,
    });

    it('reads a file that did not change', async () => {
      const result = await readAttachmentFromPath(await prepared(), options);
      assert.deepEqual(result, { name: 'report.pdf', contentType: 'application/pdf', base64: Buffer.from('hello').toString('base64') });
    });

    it('refuses a file that is not the one checked: another file, another size or another real path', async () => {
      const info = await prepared();
      await assert.rejects(readAttachmentFromPath({ ...info, stat: { ...fs.statSync(report), ino: info.stat.ino + 1 } }, options), new RegExp(`Attachment changed after validation: ${report.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      await assert.rejects(readAttachmentFromPath({ ...info, stat: { ...fs.statSync(report), dev: info.stat.dev + 1 } }, options), /Attachment changed after validation/);
      await assert.rejects(readAttachmentFromPath({ ...info, stat: Object.assign(Object.create(Object.getPrototypeOf(info.stat)), info.stat, { size: info.stat.size + 1 }) }, options), /Attachment changed after validation/);
      await assert.rejects(readAttachmentFromPath({ ...info, realPath: `${info.realPath}.other` }, options), /Attachment changed after validation/);
    });

    it('refuses what is opened if it is not the file that was checked', async (t) => {
      const info = await prepared();
      t.mock.method(fs.promises, 'open', async () => handleOf({ stat: async () => Object.assign(Object.create(Object.getPrototypeOf(info.stat)), fs.statSync(report), { ino: info.stat.ino + 1 }) }));
      await assert.rejects(readAttachmentFromPath(info, options), /Attachment changed after validation/);
    });

    it('closes the file and says "fstat" when the opened file cannot be examined', async (t) => {
      const info = await prepared();
      let closed = 0;
      t.mock.method(fs.promises, 'open', async () => handleOf({ stat: async () => { throw fsError('EIO'); }, close: async () => { closed++; } }));
      await assert.rejects(readAttachmentFromPath(info, options), /Attachment fstat failed \(EIO\)/);
      assert.equal(closed, 1);
    });

    it('refuses what is opened if it is no longer a regular file', async (t) => {
      const info = await prepared();
      t.mock.method(fs.promises, 'open', async () => handleOf({ stat: async () => Object.assign(Object.create(Object.getPrototypeOf(info.stat)), fs.statSync(report), { isFile: () => false }) }));
      await assert.rejects(readAttachmentFromPath(info, options), /Attachment is not a regular file/);
    });

    it('says "symlink" when the open fails with ELOOP, and words any other failure to open', async (t) => {
      const info = await prepared();
      const open = t.mock.method(fs.promises, 'open', async () => { throw fsError('ELOOP'); });
      await assert.rejects(readAttachmentFromPath(info, options), (e) => /Attachment path is a symlink and is not allowed/.test(e.message) && e.cause.code === 'ELOOP');
      open.mock.mockImplementation(async () => { throw fsError('EMFILE'); });
      await assert.rejects(readAttachmentFromPath(info, options), /Attachment open failed \(EMFILE\)/);
      open.mock.mockImplementation(async () => { throw fsError('EACCES'); });
      await assert.rejects(readAttachmentFromPath(info, options), /Attachment unreadable \(permission denied\)/);
    });

    it('refuses a file that gives less than its size, and closes it', async (t) => {
      const info = await prepared();
      let closed = 0;
      t.mock.method(fs.promises, 'open', async () => handleOf({ read: async () => ({ bytesRead: 0 }), close: async () => { closed++; } }));
      await assert.rejects(readAttachmentFromPath(info, options), /Attachment changed while being read/);
      assert.equal(closed, 1);
    });

    it('refuses a file that has grown past its size after the check', async (t) => {
      const info = await prepared();
      let reads = 0;
      t.mock.method(fs.promises, 'open', async () => handleOf({
        read: async (buffer, offset, length) => {
          reads++;
          if (reads === 1) {
            Buffer.from('hello').copy(buffer, offset);
            return { bytesRead: length };
          }
          return { bytesRead: 1 }; // one more byte than the size the check saw
        },
      }));
      await assert.rejects(readAttachmentFromPath(info, options), /Attachment changed while being read/);
    });

    it('reads a file that arrives in several pieces', async (t) => {
      const info = await prepared();
      t.mock.method(fs.promises, 'open', async () => handleOf({
        read: async (buffer, offset, length, position) => {
          if (length === 1 && position === 5) return { bytesRead: 0 };
          const piece = Buffer.from('hello').subarray(offset, offset + 2);
          piece.copy(buffer, offset);
          return { bytesRead: piece.length };
        },
      }));
      const result = await readAttachmentFromPath(info, options);
      assert.equal(Buffer.from(result.base64, 'base64').toString(), 'hello');
    });
  });
});

describe('the Windows rules for an attachment path, applied when the bridge runs on Windows', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  const asWindows = () => Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  const restore = () => Object.defineProperty(process, 'platform', original);

  it('lets an ordinary path through the Windows rules', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-att-win-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'report.pdf');
    fs.writeFileSync(file, 'x');
    asWindows();
    try {
      assert.equal((await inspectAttachmentPath(file, { protectedDirs: [] })).filePath, file);
    } finally {
      restore();
    }
  });

  it('refuses a path with an alternate data stream before looking at the disk', async () => {
    asWindows();
    try {
      await assert.rejects(inspectAttachmentPath('C:\\Users\\me\\Documents\\report.pdf:hidden', { protectedDirs: [] }), /^Error: Attachment path names an alternate data stream \(':' after the drive\), not allowed: C:\\Users\\me\\Documents\\report\.pdf:hidden$/);
      await assert.rejects(inspectAttachmentPath('C:\\Users\\me\\CON', { protectedDirs: [] }), /Attachment path has a component naming a Windows device \("CON"\), not allowed/);
    } finally {
      restore();
    }
  });
});
