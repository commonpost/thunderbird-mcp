// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';
/**
 * The coverage tooling (scripts/coverage): statements, instrumentation, the mapping of code run through vm back to
 * the source, and the report on a small synthetic tree.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const vm = require('vm');
const espree = require('espree');

const { statements } = require('../scripts/coverage/statements.cjs');
const { instrument } = require('../scripts/coverage/instrument.cjs');
const { mapLines, counts, report, isCode } = require('../scripts/coverage/report.cjs');

function source(rel, text) {
  const lines = text.split('\n');
  const index = new Map();
  lines.forEach((l, i) => {
    if (!isCode(l)) return;
    if (!index.has(l)) index.set(l, []);
    index.get(l).push(i);
  });
  return { rel, lines, index };
}

const API_TEXT = [
  '"use strict";',
  'function alpha(x) {',
  '  const doubled = x * 2;',
  '  if (doubled > 10) {',
  '    return "big";',
  '  }',
  '  return "small";',
  '}',
  'function beta(list) {',
  '  let total = 0;',
  '  for (const item of list) total += item;',
  '  return total;',
  '}',
  'const configurationValueThatIsQuiteLong = { enabled: true };',
  '',
].join('\n');

describe('coverage: statements', () => {
  it('lists every statement of a block body once, in source order, without directives', () => {
    const st = statements(API_TEXT);
    const lines = st.map(([, line]) => line);
    // The body of a for without braces is not a block body: line 11 counts once.
    assert.deepEqual(lines, [2, 3, 4, 5, 7, 9, 10, 11, 12, 14]);
    const offsets = st.map(([off]) => off);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  });

  it('reads a file that starts with a shebang, keeping its offsets', () => {
    const text = '#!/usr/bin/env node\nconst a = 1;\n';
    assert.deepEqual(statements(text), [[text.indexOf('const'), 2]]);
  });
});

describe('coverage: instrument', () => {
  it('puts one probe per statement without moving any line, and the header after "use strict"', () => {
    const { text, count } = instrument(API_TEXT);
    assert.equal(count, statements(API_TEXT).length);
    assert.equal(text.split('\n').length, API_TEXT.split('\n').length);
    assert.equal((text.match(/__cpCov\[\d+\]=1;/g) || []).length, count);
    assert.match(text.split('\n')[0], /^"use strict"; var __cpCov = new Uint8Array\(10\);/);
    espree.parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
  });

  it('runs: the probes mark exactly the statements that ran', () => {
    const { text } = instrument(API_TEXT);
    // Without Thunderbird the timer cannot start; the header reports it and the code still runs.
    const hits = vm.runInNewContext(`${text}\nalpha(3);\n__cpCov;`, { dump: () => {}, Cc: {}, Ci: {}, Services: {} });
    const st = statements(API_TEXT);
    const ran = st.map(([, line]) => line).filter((_, i) => hits[i]);
    assert.deepEqual(ran, [2, 3, 4, 7, 9, 14]);
  });

  it('refuses a file without a "use strict" directive', () => {
    assert.throws(() => instrument('const a = 1;\n'), /use strict/);
  });
});

describe('coverage: mapping code run through vm back to the source', () => {
  const api = source('api.js', API_TEXT);
  const lines = API_TEXT.split('\n');

  it('maps a region copied as is to its lines', () => {
    const slice = ['// test harness', ...lines.slice(8, 13), 'module.exports = beta;'];
    const m = mapLines(slice, [api]);
    assert.equal(m[0], null);
    assert.deepEqual(m.slice(1, 6).map((x) => x && x[1]), [8, 9, 10, 11, 12]);
    assert.equal(m[6], null);
  });

  it('maps regions joined in another order than in the source', () => {
    const slice = [...lines.slice(8, 13), ...lines.slice(1, 8)];
    const m = mapLines(slice, [api]);
    assert.deepEqual(m.map((x) => x && x[1]), [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('leaves out a line that the test changed, and keeps its neighbours', () => {
    const slice = [...lines.slice(1, 8)];
    slice[2] = '  if (doubled > 99) {';
    const m = mapLines(slice, [api]);
    assert.deepEqual(m.map((x) => x && x[1]), [1, 2, null, 4, 5, 6, 7]);
  });

  it('does not map a lone common line, nor a long line found twice', () => {
    const twice = source('api.js', `${lines[13]}\n${lines[13]}\n`);
    assert.deepEqual(mapLines(['}'], [api]), [null]);
    assert.deepEqual(mapLines([lines[13]], [twice]), [null]);
    assert.deepEqual(mapLines([lines[13]], [api]).map((x) => x && x[1]), [13]);
  });

  it('counts the innermost V8 range at each offset', () => {
    const cnt = counts(10, [{ ranges: [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 4, endOffset: 6, count: 0 }] }]);
    assert.deepEqual(Array.from(cnt.slice(0, 10)), [1, 1, 1, 1, 0, 0, 1, 1, 1, 1]);
  });
});

describe('coverage: report on a synthetic tree', () => {
  it('adds the unit tests (direct and through vm) and the lab bitmap of api.js', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cov-root-'));
    const unit = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cov-unit-'));
    const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cov-lab-'));
    try {
      fs.mkdirSync(path.join(root, 'extension/mcp_server'), { recursive: true });
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.writeFileSync(path.join(root, 'extension/mcp_server/api.js'), API_TEXT);
      const bridge = 'const a = 1;\nif (a > 1) {\n  console.log(a);\n}\n';
      fs.writeFileSync(path.join(root, 'mcp-bridge.cjs'), bridge);
      fs.mkdirSync(path.join(unit, 'v8'));
      fs.mkdirSync(path.join(unit, 'slices'));
      // A test ran beta() through vm: the slice holds lines 9-13 of api.js.
      const slice = ['"use strict";', ...API_TEXT.split('\n').slice(8, 13), 'beta([1, 2]);'].join('\n');
      const slicePath = path.join(unit, 'slices', '1-0.js');
      fs.writeFileSync(slicePath, slice);
      const whole = (text) => [{ ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }] }];
      // The bridge ran, except the body of its if.
      const ifBody = bridge.indexOf('{') + 1;
      fs.writeFileSync(path.join(unit, 'v8', 'coverage-1.json'), JSON.stringify({
        result: [
          { url: pathToFileURL(slicePath).href, functions: whole(slice) },
          { url: pathToFileURL(path.join(root, 'mcp-bridge.cjs')).href, functions: [
            { ranges: [{ startOffset: 0, endOffset: bridge.length, count: 1 }, { startOffset: ifBody, endOffset: bridge.lastIndexOf('}'), count: 0 }] },
          ] },
        ],
      }));
      // The lab ran the file and alpha(3): lines 2, 3, 4, 7, 9 and 14.
      const st = statements(API_TEXT);
      const bits = new Array(st.length).fill(0);
      for (const i of [0, 1, 2, 4, 5, 9]) bits[i] = 1;
      let hex = '';
      for (let i = 0; i < bits.length; i += 4) hex += (bits[i] | bits[i + 1] << 1 | bits[i + 2] << 2 | bits[i + 3] << 3).toString(16);
      fs.mkdirSync(path.join(lab, 'run-1'));
      fs.writeFileSync(path.join(lab, 'run-1', '1-a.json'), JSON.stringify({ ok: true, coverage_hex: hex }));
      fs.writeFileSync(path.join(lab, 'run-1', '2-b.json'), JSON.stringify({ ok: true, coverage_hex: 'f' }));

      const r = report({ root, unit, lab });
      const byFile = Object.fromEntries(r.files.map((f) => [f.file, f]));
      // beta() through vm: the statements on lines 9, 10, 11 and 12.
      assert.equal(byFile['extension/mcp_server/api.js'].unit, 4);
      assert.equal(byFile['extension/mcp_server/api.js'].lab, 6);
      assert.equal(byFile['extension/mcp_server/api.js'].covered, 9);
      assert.equal(byFile['mcp-bridge.cjs'].statements, 3);
      assert.equal(byFile['mcp-bridge.cjs'].covered, 2);
      assert.equal(r.labRuns, 1);
      assert.equal(r.labSkipped, 1, 'a bitmap of another length (another api.js) is skipped');
      assert.deepEqual(r.total, { statements: 13, covered: 11, percent: 84.6 });
    } finally {
      for (const d of [root, unit, lab]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
