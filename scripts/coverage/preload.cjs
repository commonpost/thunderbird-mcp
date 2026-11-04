// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';
/**
 * Loaded with --require into every Node process of a coverage run (scripts/coverage/run.cjs sets NODE_OPTIONS).
 *
 * Many tests run regions of extension/mcp_server/api.js through vm, joined with test code. V8 names such code after
 * nothing, so its coverage could not be traced back. This module saves every string run through vm to a file of
 * $CP_COVERAGE_SLICES and runs it under that file name; report.cjs then maps its lines back to the source.
 *
 * Tests also run copies of the scripts in throw-away directories: at exit, the sha256 of every file the process loaded
 * is written next to the slices, so that the report counts a byte-identical copy as the original.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = process.env.CP_COVERAGE_SLICES;
let count = 0;

function named(code, options) {
  if (typeof code !== 'string' || !dir) return options;
  const file = path.join(dir, `${process.pid}-${count++}.js`);
  fs.writeFileSync(file, code);
  const base = typeof options === 'string' || options == null ? {} : options;
  return { ...base, filename: file, lineOffset: 0, columnOffset: 0 };
}

if (dir) {
  for (const name of ['runInContext', 'runInNewContext', 'runInThisContext']) {
    const original = vm[name];
    vm[name] = function (code, ...rest) {
      if (name === 'runInThisContext') return original.call(this, code, named(code, rest[0]));
      return original.call(this, code, rest[0], named(code, rest[1]));
    };
  }
  const OriginalScript = vm.Script;
  vm.Script = class Script extends OriginalScript {
    constructor(code, options) {
      super(code, named(code, options));
    }
  };

  process.on('exit', () => {
    const files = new Set(Object.keys(require.cache));
    if (process.argv[1]) files.add(path.resolve(process.argv[1]));
    const seen = {};
    for (const file of files) {
      try {
        seen[file] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      } catch {
        // The file is gone (a throw-away copy already removed): nothing to record.
      }
    }
    try {
      fs.writeFileSync(path.join(dir, `files-${process.pid}.json`), JSON.stringify(seen));
    } catch {
      // The coverage directory is gone: the run is being torn down.
    }
  });
}
