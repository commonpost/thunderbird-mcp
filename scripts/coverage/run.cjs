#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';
/**
 * Runs the unit tests with coverage, then prints the statement coverage (npm run coverage):
 *
 *   node scripts/coverage/run.cjs [--out DIR]     (default: coverage/, emptied first)
 *
 * Node's own V8 coverage (NODE_V8_COVERAGE) is written to DIR/v8, and preload.cjs saves the code that the tests run
 * through vm to DIR/slices. To add the end-to-end lab, see .github/workflows/coverage.yml.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function main(argv) {
  let out = path.join(ROOT, 'coverage');
  if (argv.length === 2 && argv[0] === '--out') out = path.resolve(argv[1]);
  else if (argv.length) {
    console.error('usage: node scripts/coverage/run.cjs [--out DIR]');
    return 2;
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'v8'), { recursive: true });
  fs.mkdirSync(path.join(out, 'slices'), { recursive: true });
  const tests = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => /\.c?js$/.test(f))
    .sort()
    .map((f) => path.join('test', f));
  const preload = JSON.stringify(path.join(__dirname, 'preload.cjs'));
  const run = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_V8_COVERAGE: path.join(out, 'v8'),
      CP_COVERAGE_SLICES: path.join(out, 'slices'),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${preload}`.trim(),
    },
  });
  if (run.status !== 0) {
    console.error(`coverage: the tests failed (exit ${run.status ?? run.signal}); no figure is reported`);
    return 1;
  }
  const report = spawnSync(process.execPath, [path.join(__dirname, 'report.cjs'), '--unit', out], { cwd: ROOT, stdio: 'inherit' });
  return report.status ?? 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
