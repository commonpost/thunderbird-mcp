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
const { branches, taken } = require('../scripts/coverage/branches.cjs');
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

// Every kind of branch, and arms with and without braces, nested and on one line.
const BRANCHY = [
  '"use strict";',
  'function f(x, y) {',
  '  const out = [];',
  '  if (x > 1) out.push("a");',
  '  if (x > 2) { out.push("b"); } else if (x > 0) out.push("c"); else out.push("d");',
  '  if (x) if (y) out.push("e");',
  '  out.push(x > 3 ? "big" : x ? "some" : "none");',
  '  out.push(x || "zz", y && "yy", y ?? "nn", (x, y) || "seq", (x || y) && (y || x) || "last");',
  '  switch (x) { case 1: out.push(1); case 2: case 3: out.push(3); break; default: out.push("d"); }',
  '  switch (y) { case 9:',
  '    // empty',
  '  case 10 /* c */ : out.push(10) }',
  '  if (x > 100) return out',
  '  out.push("end")',
  '  return out;',
  '}',
  '',
].join('\n');
const CTX = () => ({ dump: () => {}, Cc: {}, Ci: {}, Services: {} });

describe('coverage: branches', () => {
  it('lists both outcomes of every decision, in source order', () => {
    const kinds = branches(API_TEXT).map((b) => `${b.kind}@${b.line}:${b.col}`);
    assert.deepEqual(kinds, ['then@4:2', 'else@4:2']);
    const all = branches(BRANCHY);
    const count = (k) => all.filter((b) => b.kind === k).length;
    assert.equal(count('then'), 8);
    assert.equal(count('else'), 8);
    assert.equal(count('right'), 8);
    assert.equal(count('short'), 8);
    assert.equal(count('case'), 6);
    const anchors = all.map((b) => b.anchor);
    assert.deepEqual(anchors, [...anchors].sort((a, b) => a - b));
  });

  it('takes an arm when its first character ran, and an implicit else or a short-circuit when the decision ran more often', () => {
    const src = 'if (a) { b(); }\nconst v = c || d;\n';
    const [then, els, right, short] = branches(src);
    const cnt = new Int32Array(src.length + 1).fill(3);
    // The if ran 3 times, its block twice; the right operand of || ran 3 times (never short-circuited).
    cnt.fill(2, src.indexOf('{'), src.indexOf('}') + 1);
    assert.equal(taken(then, cnt), true);
    assert.equal(taken(els, cnt), true);
    assert.equal(taken(right, cnt), true);
    assert.equal(taken(short, cnt), false);
    cnt.fill(3, src.indexOf('{'), src.indexOf('}') + 1);
    assert.equal(taken(els, cnt), false, 'the block ran every time: the condition was never false');
    cnt.fill(0, src.indexOf('d;'), src.indexOf('d;') + 1);
    assert.equal(taken(right, cnt), false);
    assert.equal(taken(short, cnt), true);
  });
});

describe('coverage: instrument', () => {
  it('puts one probe per statement and per branch without moving any line, and the header after "use strict"', () => {
    const { text, count, branches: nb } = instrument(API_TEXT);
    assert.equal(count, statements(API_TEXT).length);
    assert.equal(nb, 2);
    assert.equal(text.split('\n').length, API_TEXT.split('\n').length);
    assert.equal((text.match(/__cpCov\[\d+\]=1;/g) || []).length, count + nb);
    assert.match(text.split('\n')[0], /^"use strict"; var __cpCov = new Uint8Array\(12\);/);
    espree.parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
  });

  it('runs: the probes mark exactly the statements and branches that ran', () => {
    const { text } = instrument(API_TEXT);
    // Without Thunderbird the timer cannot start; the header reports it and the code still runs.
    const hits = vm.runInNewContext(`${text}\nalpha(3);\n__cpCov;`, CTX());
    const st = statements(API_TEXT);
    const ran = st.map(([, line]) => line).filter((_, i) => hits[i]);
    assert.deepEqual(ran, [2, 3, 4, 7, 9, 14]);
    // alpha(3): the if was false, so only its (implicit) else was taken.
    assert.deepEqual(Array.from(hits.slice(st.length)), [0, 1]);
  });

  it('keeps the behaviour of every kind of branch, and marks each one when it is taken', () => {
    const inputs = [[0, 0], [1, null], [2, 1], [3, undefined], [4, 10], [5, 9], [200, 1]];
    const run = `\nconst res = ${JSON.stringify(inputs)}.map(([x, y]) => f(x, y));\n`;
    const original = vm.runInNewContext(`${BRANCHY}${run}res;`, CTX());
    const { text } = instrument(BRANCHY);
    espree.parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
    assert.equal(text.split('\n').length, BRANCHY.split('\n').length);
    const [res, hits] = vm.runInNewContext(`${text}${run}[res, __cpCov];`, CTX());
    assert.equal(JSON.stringify(res), JSON.stringify(original));
    const S = statements(BRANCHY).length;
    assert.ok(Array.from(hits.slice(S)).every((v) => v === 1), 'these inputs take every branch');
    // One input only: the bits must match the outcomes it really took.
    const [, one] = vm.runInNewContext(`${text}\n[f(1, 0), __cpCov];`, CTX());
    const got = branches(BRANCHY).map((b, j) => `${b.kind}@${b.line}:${b.col}=${one[S + j]}`);
    assert.deepEqual(got, [
      'then@4:2=0', 'else@4:2=1', 'then@5:2=0', 'else@5:2=1', 'then@5:37=1', 'else@5:37=0',
      'then@6:2=1', 'else@6:2=0', 'then@6:9=0', 'else@6:9=1', 'then@7:19=0', 'else@7:19=1', 'then@7:31=1', 'else@7:31=0',
      // x || "zz", y && "yy", y ?? "nn" (x = 1, y = 0): all decided by their left operand.
      'right@8:16=0', 'short@8:16=1', 'right@8:27=0', 'short@8:27=1', 'right@8:38=0', 'short@8:38=1',
      // (x, y) || "seq": 0, so the right operand ran; (x || y) && (y || x) || "last": 1 && 1, so "last" did not.
      'right@8:54=1', 'short@8:54=0', 'right@8:67=0', 'short@8:67=1', 'right@8:74=1', 'short@8:74=0',
      'right@8:79=1', 'short@8:79=0', 'right@8:85=0', 'short@8:85=1',
      // case 1 falls through to case 2 and case 3; y = 0 matches no case.
      'case@9:15=1', 'case@9:36=1', 'case@9:44=1', 'case@9:72=0', 'case@10:15=0', 'case@12:2=0',
      'then@13:2=0', 'else@13:2=1',
    ]);
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

describe('coverage: workflow', () => {
  it('runs the lab at the commit pinned in e2e-lab.yml', () => {
    const sha = (file) => {
      const m = /^ {2}LAB_SHA: ([0-9a-f]{40})$/m.exec(fs.readFileSync(path.join(__dirname, '..', '.github/workflows', file), 'utf8'));
      return m && m[1];
    };
    assert.match(sha('e2e-lab.yml'), /^[0-9a-f]{40}$/);
    assert.equal(sha('coverage.yml'), sha('e2e-lab.yml'), 'update LAB_SHA in coverage.yml together with e2e-lab.yml');
  });
});

describe('coverage: report on a synthetic tree', () => {
  it('adds the unit tests (direct and through vm) and the lab bitmap of api.js, statements and branches', () => {
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
      // The bridge ran, except the block of its if (V8's range for it starts at the brace).
      const ifBody = bridge.indexOf('{');
      fs.writeFileSync(path.join(unit, 'v8', 'coverage-1.json'), JSON.stringify({
        result: [
          { url: pathToFileURL(slicePath).href, functions: whole(slice) },
          { url: pathToFileURL(path.join(root, 'mcp-bridge.cjs')).href, functions: [
            { ranges: [{ startOffset: 0, endOffset: bridge.length, count: 1 }, { startOffset: ifBody, endOffset: bridge.lastIndexOf('}'), count: 0 }] },
          ] },
        ],
      }));
      // The lab ran the file and alpha(3): lines 2, 3, 4, 7, 9 and 14, and the implicit else of line 4 (the bitmap
      // holds the statements, then the branches).
      const st = statements(API_TEXT);
      const bits = new Array(st.length + 2).fill(0);
      for (const i of [0, 1, 2, 4, 5, 9, st.length + 1]) bits[i] = 1;
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
      // The if of the bridge was false: its implicit else was taken, its block was not.
      assert.equal(byFile['mcp-bridge.cjs'].branches, 2);
      assert.equal(byFile['mcp-bridge.cjs'].branchesCovered, 1);
      assert.equal(byFile['extension/mcp_server/api.js'].branchesUnit, 0);
      assert.equal(byFile['extension/mcp_server/api.js'].branchesLab, 1);
      assert.equal(r.labRuns, 1);
      assert.equal(r.labSkipped, 1, 'a bitmap of another length (another api.js) is skipped');
      assert.deepEqual(r.total, { statements: 13, covered: 11, percent: 84.6, branches: 4, branchesCovered: 2, branchesPercent: 50 });
    } finally {
      for (const d of [root, unit, lab]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
