// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';

// Every source file states its license and copyright holder near the top (SPDX tags), as LICENSE and
// THIRD-PARTY.md describe: MIT, except extension/httpd.sys.mjs (MPL-2.0).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = /\.(js|cjs|mjs|ts|py|sh|html)$/;

function trackedSources() {
  let out;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return null;
  }
  return out.split('\n').filter((f) => SOURCE.test(f));
}

describe('SPDX headers', () => {
  const files = trackedSources();

  it('every tracked source file has a license and a copyright tag', { skip: files === null && 'not a git checkout' }, () => {
    const missing = [];
    for (const f of files) {
      const head = fs.readFileSync(path.join(ROOT, f), 'utf8').slice(0, 600);
      const license = /SPDX-License-Identifier: (\S+)/.exec(head);
      const expected = f === 'extension/httpd.sys.mjs' ? 'MPL-2.0' : 'MIT';
      if (!license || license[1] !== expected || !/SPDX-FileCopyrightText: \S/.test(head)) missing.push(f);
    }
    assert.deepEqual(missing, [], 'add the SPDX-License-Identifier and SPDX-FileCopyrightText lines of the other files');
  });
});
