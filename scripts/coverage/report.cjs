#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';
/**
 * Statement coverage of the project's own code, from the unit tests and, optionally, the end-to-end lab:
 *
 *   node scripts/coverage/report.cjs --unit DIR [--lab DIR] [--json FILE] [--markdown FILE] [--min PERCENT]
 *
 *   --unit DIR      output directory of scripts/coverage/run.cjs (DIR/v8: raw V8 coverage, DIR/slices: code run
 *                   through vm, saved by preload.cjs)
 *   --lab DIR       results of run-lab.sh on a tree instrumented by instrument.cjs: every result JSON under DIR that
 *                   has a coverage_hex bitmap counts for extension/mcp_server/api.js
 *   --json FILE     also write the figures as JSON
 *   --markdown FILE also append them as a Markdown table (for example $GITHUB_STEP_SUMMARY)
 *   --min PERCENT   exit 1 if the total is lower
 *
 * A statement (statements.cjs) is covered if V8 counted at least one run at its first character. Code that the tests
 * run through vm is mapped back to the source by text: each line of it that belongs to a run of at least two
 * identical consecutive lines of a source file (or to one long line found once) stands for that source line, and
 * the statements starting on that line are covered if the line's first character ran. Lines that a test changed are
 * not counted, so the figure errs low.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { statements } = require('./statements.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const API = 'extension/mcp_server/api.js';
// Code the tests may run through vm, to which slices are mapped back.
const MAPPED = [API, 'extension/options.js', 'extension/background.js', 'mcp-bridge.cjs'];
const MIN_RUN = 2;
const LONG_LINE = 25;
const MAX_CANDIDATES = 64;

function targets(root) {
  const scripts = fs.readdirSync(path.join(root, 'scripts'))
    .filter((f) => /\.c?js$/.test(f))
    .sort()
    .map((f) => `scripts/${f}`);
  return [...MAPPED, ...scripts].filter((t) => fs.existsSync(path.join(root, t)));
}

function loadTarget(root, rel) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const lines = text.split('\n');
  const stmts = statements(text);
  const byLine = new Map();
  stmts.forEach(([, line], i) => {
    if (!byLine.has(line - 1)) byLine.set(line - 1, []);
    byLine.get(line - 1).push(i);
  });
  const index = new Map();
  lines.forEach((l, i) => {
    if (!isCode(l)) return;
    if (!index.has(l)) index.set(l, []);
    index.get(l).push(i);
  });
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  return { rel, text, lines, stmts, byLine, index, sha256, unit: new Uint8Array(stmts.length), lab: new Uint8Array(stmts.length) };
}

function isCode(line) {
  const s = line.trim();
  if (!s || s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return false;
  return /[A-Za-z0-9_$'"`]/.test(s);
}

// Maps each line of code run through vm to [source, line index] or null (see the header).
function mapLines(codeLines, sources) {
  const out = new Array(codeLines.length).fill(null);
  let i = 0;
  while (i < codeLines.length) {
    const line = codeLines[i];
    let best = null;
    let found = 0;
    if (isCode(line)) {
      for (const src of sources) {
        const positions = src.index.get(line) || [];
        found += positions.length;
        if (positions.length > MAX_CANDIDATES) continue;
        for (const q of positions) {
          let n = 0;
          while (i + n < codeLines.length && q + n < src.lines.length && codeLines[i + n] === src.lines[q + n]) n++;
          if (!best || n > best.n) best = { src, q, n };
        }
      }
    }
    const accepted = best && (best.n >= MIN_RUN || (found === 1 && line.trim().length > LONG_LINE));
    if (!accepted) {
      i++;
      continue;
    }
    // A run found from a distinctive line also takes the identical lines just before it ("}", "return;", ...).
    for (let k = 1; i - k >= 0 && best.q - k >= 0 && out[i - k] === null && codeLines[i - k] === best.src.lines[best.q - k]; k++) {
      out[i - k] = [best.src, best.q - k];
    }
    for (let k = 0; k < best.n; k++) out[i + k] = [best.src, best.q + k];
    i += best.n;
  }
  return out;
}

// Run count at each offset of a script, from V8's block coverage (the innermost range wins).
function counts(length, functions) {
  const ranges = [];
  for (const fn of functions) for (const r of fn.ranges) ranges.push(r);
  ranges.sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
  const cnt = new Int32Array(length + 1).fill(-1);
  for (const r of ranges) cnt.fill(r.count, r.startOffset, Math.min(r.endOffset, length));
  return cnt;
}

function firstCharOffsets(text) {
  const out = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    const m = /\S/.exec(line);
    out.push(m ? pos + m.index : null);
    pos += line.length + 1;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function scriptPath(url) {
  if (url.startsWith('file://')) return fileURLToPath(url);
  return path.isAbsolute(url) ? url : null;
}

function addUnit(files, unitDir, root) {
  const bySha = new Map(files.map((f) => [f.sha256, f]));
  const byPath = new Map(files.map((f) => [path.join(root, f.rel), f]));
  const sources = files.filter((f) => MAPPED.includes(f.rel));
  const slicesDir = path.join(unitDir, 'slices');
  // Byte-identical copies of a target (tests copy scripts into throw-away directories).
  if (fs.existsSync(slicesDir)) {
    for (const name of fs.readdirSync(slicesDir).filter((n) => /^files-\d+\.json$/.test(n))) {
      for (const [p, sha] of Object.entries(readJson(path.join(slicesDir, name)))) {
        if (bySha.has(sha) && !byPath.has(p)) byPath.set(p, bySha.get(sha));
      }
    }
  }
  const mapCache = new Map();
  let processes = 0;
  const v8Dir = path.join(unitDir, 'v8');
  for (const name of fs.readdirSync(v8Dir).filter((n) => n.endsWith('.json'))) {
    processes++;
    for (const script of readJson(path.join(v8Dir, name)).result || []) {
      const p = scriptPath(script.url || '');
      if (!p) continue;
      const target = byPath.get(p);
      if (target) {
        const cnt = counts(target.text.length, script.functions);
        target.stmts.forEach(([off], i) => { if (cnt[off] > 0) target.unit[i] = 1; });
      } else if (path.dirname(p) === path.resolve(slicesDir) && fs.existsSync(p)) {
        const code = fs.readFileSync(p, 'utf8');
        const key = crypto.createHash('sha1').update(code).digest('hex');
        if (!mapCache.has(key)) mapCache.set(key, mapLines(code.split('\n'), sources));
        const mapping = mapCache.get(key);
        const cnt = counts(code.length, script.functions);
        const first = firstCharOffsets(code);
        mapping.forEach((m, i) => {
          if (!m || first[i] === null || !(cnt[first[i]] > 0)) return;
          const [src, q] = m;
          for (const s of src.byLine.get(q) || []) src.unit[s] = 1;
        });
      }
    }
  }
  return processes;
}

function* resultFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* resultFiles(p);
    else if (entry.isFile() && entry.name.endsWith('.json')) yield p;
  }
}

function addLab(api, labDir) {
  const digits = Math.ceil(api.stmts.length / 4);
  let runs = 0;
  let skipped = 0;
  for (const file of resultFiles(labDir)) {
    let hex;
    try {
      hex = readJson(file).coverage_hex;
    } catch {
      continue;
    }
    if (typeof hex !== 'string' || !/^[0-9a-f]*$/.test(hex)) continue;
    if (hex.length !== digits) {
      skipped++;
      continue;
    }
    runs++;
    for (let j = 0; j < hex.length; j++) {
      const v = parseInt(hex[j], 16);
      for (let b = 0; b < 4; b++) if (v >> b & 1 && 4 * j + b < api.lab.length) api.lab[4 * j + b] = 1;
    }
  }
  return { runs, skipped };
}

function pct(n, d) {
  return d ? Math.round(1000 * n / d) / 10 : 100;
}

// Per-file statements and their unit and lab bits.
function analyze({ root = ROOT, unit, lab } = {}) {
  const files = targets(root).map((rel) => loadTarget(root, rel));
  const processes = addUnit(files, unit, root);
  const api = files.find((f) => f.rel === API);
  const labInfo = lab && api ? addLab(api, lab) : null;
  return { files, processes, api, labInfo };
}

function report(options) {
  const { files, processes, api, labInfo } = analyze(options);
  const rows = files.map((f) => {
    const sum = (a) => a.reduce((s, v) => s + v, 0);
    const both = f.unit.map((v, i) => v | f.lab[i]);
    return {
      file: f.rel,
      statements: f.stmts.length,
      unit: sum(f.unit),
      lab: labInfo && f === api ? sum(f.lab) : null,
      covered: sum(both),
    };
  });
  const statementsTotal = rows.reduce((s, r) => s + r.statements, 0);
  const coveredTotal = rows.reduce((s, r) => s + r.covered, 0);
  return {
    files: rows,
    total: { statements: statementsTotal, covered: coveredTotal, percent: pct(coveredTotal, statementsTotal) },
    unitProcesses: processes,
    labRuns: labInfo ? labInfo.runs : 0,
    labSkipped: labInfo ? labInfo.skipped : 0,
  };
}

function plainText(r) {
  const lines = r.files.map((f) => {
    const lab = f.lab === null ? '' : `  lab ${String(pct(f.lab, f.statements)).padStart(5)}%`;
    return `${f.file.padEnd(40)} ${String(f.statements).padStart(6)} statements  unit ${String(pct(f.unit, f.statements)).padStart(5)}%${lab}  covered ${String(pct(f.covered, f.statements)).padStart(5)}%`;
  });
  lines.push(`${'TOTAL'.padEnd(40)} ${String(r.total.statements).padStart(6)} statements  covered ${r.total.covered} = ${r.total.percent}%`);
  lines.push(`(${r.unitProcesses} Node processes, ${r.labRuns} lab runs${r.labSkipped ? `, ${r.labSkipped} lab results of another api.js skipped` : ''})`);
  return lines.join('\n');
}

function markdown(r) {
  const out = ['### Statement coverage', '', '| file | statements | unit tests | lab | covered |', '|---|---:|---:|---:|---:|'];
  for (const f of r.files) {
    out.push(`| \`${f.file}\` | ${f.statements} | ${pct(f.unit, f.statements)}% | ${f.lab === null ? '' : `${pct(f.lab, f.statements)}%`} | ${pct(f.covered, f.statements)}% |`);
  }
  out.push(`| **total** | **${r.total.statements}** | | | **${r.total.percent}%** |`, '');
  out.push(`Unit tests: ${r.unitProcesses} Node processes. Lab: ${r.labRuns} scenario runs in a real Thunderbird.` +
    ' A statement counts as covered if it ran at least once (scripts/coverage/report.cjs).', '');
  return out.join('\n');
}

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const key = { '--unit': 'unit', '--lab': 'lab', '--json': 'json', '--markdown': 'markdown', '--min': 'min' }[argv[i]];
    if (!key || i + 1 >= argv.length) {
      console.error('usage: node scripts/coverage/report.cjs --unit DIR [--lab DIR] [--json FILE] [--markdown FILE] [--min PERCENT]');
      return 2;
    }
    opts[key] = argv[++i];
  }
  if (!opts.unit) {
    console.error('report.cjs: --unit DIR is required');
    return 2;
  }
  const r = report({ unit: opts.unit, lab: opts.lab });
  console.log(plainText(r));
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(r, null, 2) + '\n');
  if (opts.markdown) fs.appendFileSync(opts.markdown, markdown(r));
  if (opts.min !== undefined && r.total.percent < Number(opts.min)) {
    console.error(`statement coverage ${r.total.percent}% is below ${opts.min}%`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { analyze, mapLines, counts, report, isCode };
