#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';
/**
 * Instruments extension/mcp_server/api.js of a COPY of the source tree, for statement and branch coverage in a real
 * Thunderbird (the end-to-end lab, commonpost/thunderbird-mcp-lab):
 *
 *   node scripts/coverage/instrument.cjs <copy of the tree>
 *
 * Statement i (statements.cjs) gets `__cpCov[i]=1;` in front of it. Branch j (branches.cjs) sets __cpCov[S + j], S
 * being the number of statements:
 *
 *   if (c) A else B     `__cpCov[k]=1;` at the start of A and of B (an arm without braces gets braces), and
 *                       ` else {__cpCov[k]=1;}` after A when there is no else
 *   c ? a : b           `(__cpCov[k]=1, (a))`, the same for b
 *   l || r, &&, ??      `__cpL((l), k, op)`, which sets k when l decides alone, and `(__cpCov[k]=1, (r))`
 *   case x:             `__cpCov[k]=1;` first in the clause
 *
 * Nothing is inserted on a new line, so line numbers do not move. A repeating timer writes the bitmap (hex, 4 bits
 * per digit, bit i = bit i % 4 of digit i / 4) to <profile>/cp-coverage.txt every 250 ms; the lab returns it as
 * coverage_hex. Never run an instrumented add-on outside the lab: it writes to the profile.
 */

const fs = require('fs');
const path = require('path');
const { statements, parse } = require('./statements.cjs');
const { branches } = require('./branches.cjs');

const API = 'extension/mcp_server/api.js';
const BODY_KEYS = { Program: 'body', BlockStatement: 'body', StaticBlock: 'body', SwitchCase: 'consequent' };
const LOGICAL_OP = { '||': 0, '&&': 1, '??': 2 };

// Offset just after the ":" of a case clause with no statement.
function afterColon(source, from) {
  let i = from;
  for (;;) {
    if (/\s/.test(source[i])) i++;
    else if (source.startsWith('//', i)) i = source.indexOf('\n', i);
    else if (source.startsWith('/*', i)) i = source.indexOf('*/', i) + 2;
    else break;
  }
  if (source[i] !== ':') throw new Error(`no ":" after the case clause at offset ${from}`);
  return i + 1;
}

function instrument(source) {
  const stmts = statements(source);
  const brs = branches(source);
  const S = stmts.length;
  const stmtIndex = new Map(stmts.map(([at], i) => [at, i]));
  const branchIndex = new Map(brs.map((b, j) => [`${b.kind}@${b.anchor}`, S + j]));
  const bit = (kind, anchor) => {
    const k = branchIndex.get(`${kind}@${anchor}`);
    if (k === undefined) throw new Error(`no ${kind} branch at offset ${anchor}`);
    return k;
  };
  // Insertions by offset. At one offset, what closes comes first, in the order it was added (inner nodes first, as
  // they are left before their parents), then what opens (outer nodes first, as they are entered before their
  // children).
  const closes = new Map();
  const opens = new Map();
  const add = (map, at, text) => {
    if (!map.has(at)) map.set(at, []);
    map.get(at).push(text);
  };
  const openArm = (arm, k) => {
    if (arm.type === 'BlockStatement') add(opens, arm.range[0] + 1, `__cpCov[${k}]=1;`);
    else add(opens, arm.range[0], `{__cpCov[${k}]=1;`);
  };
  const closeArm = (arm) => {
    if (arm.type !== 'BlockStatement') add(closes, arm.range[1], '}');
  };

  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'IfStatement') {
      openArm(node.consequent, bit('then', node.range[0]));
      if (node.alternate) openArm(node.alternate, bit('else', node.range[0]));
    } else if (node.type === 'ConditionalExpression') {
      add(opens, node.consequent.range[0], `(__cpCov[${bit('then', node.consequent.range[0])}]=1, (`);
      add(opens, node.alternate.range[0], `(__cpCov[${bit('else', node.consequent.range[0])}]=1, (`);
    } else if (node.type === 'LogicalExpression') {
      add(opens, node.left.range[0], '__cpL((');
      add(opens, node.right.range[0], `(__cpCov[${bit('right', node.right.range[0])}]=1, (`);
    } else if (node.type === 'SwitchCase') {
      const at = node.consequent.length ? node.consequent[0].range[0]
        : afterColon(source, node.test ? node.test.range[1] : node.range[0] + 'default'.length);
      add(opens, at, `__cpCov[${bit('case', node.range[0])}]=1;`);
    }
    const key = BODY_KEYS[node.type];
    if (key) {
      for (const st of node[key]) if (!st.directive) add(opens, st.range[0], `__cpCov[${stmtIndex.get(st.range[0])}]=1;`);
    }
    for (const k of Object.keys(node)) {
      if (k === 'parent') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
    if (node.type === 'IfStatement') {
      closeArm(node.consequent);
      if (node.alternate) closeArm(node.alternate);
      else add(closes, node.consequent.range[1], ` else {__cpCov[${bit('else', node.range[0])}]=1;}`);
    } else if (node.type === 'ConditionalExpression') {
      add(closes, node.consequent.range[1], '))');
      add(closes, node.alternate.range[1], '))');
    } else if (node.type === 'LogicalExpression') {
      add(closes, node.left.range[1], `), ${bit('short', node.right.range[0])}, ${LOGICAL_OP[node.operator]})`);
      add(closes, node.right.range[1], '))');
    }
  };
  walk(parse(source));

  const at = [...new Set([...closes.keys(), ...opens.keys()])].sort((a, b) => a - b);
  let out = '';
  let last = 0;
  for (const off of at) {
    out += source.slice(last, off) + (closes.get(off) || []).join('') + (opens.get(off) || []).join('');
    last = off;
  }
  out += source.slice(last);

  const header = [
    `var __cpCov = new Uint8Array(${S + brs.length});`,
    'function __cpL(v, k, op) { if (op === 0 ? v : op === 1 ? !v : v !== null && v !== undefined) __cpCov[k] = 1; return v; }',
    'var __cpCovTimer = (function () {',
    '  try {',
    '    const t = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);',
    '    t.initWithCallback({ notify() {',
    '      try {',
    '        let h = "";',
    '        for (let i = 0; i < __cpCov.length; i += 4) h += (__cpCov[i] | __cpCov[i + 1] << 1 | __cpCov[i + 2] << 2 | __cpCov[i + 3] << 3).toString(16);',
    '        const f = Services.dirsvc.get("ProfD", Ci.nsIFile); f.append("cp-coverage.txt");',
    '        const o = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);',
    '        o.init(f, 0x02 | 0x08 | 0x20, 0o600, 0); o.write(h, h.length); o.close();',
    '      } catch (e) { dump("cp-coverage: " + e + "\\n"); }',
    '    } }, 250, Ci.nsITimer.TYPE_REPEATING_SLACK);',
    '    return t;',
    '  } catch (e) { dump("cp-coverage timer: " + e + "\\n"); return null; }',
    '})();',
  ].join(' ');
  // On the line of the "use strict" directive, after it, so that the directive stays first and no line moves.
  const directive = '"use strict";';
  const d = out.indexOf(directive);
  if (d < 0) throw new Error(`${API} has no "use strict" directive to put the coverage header after`);
  return {
    text: out.slice(0, d + directive.length) + ' ' + header + out.slice(d + directive.length),
    count: S,
    branches: brs.length,
  };
}

function main(argv) {
  const tree = argv[0];
  if (!tree || argv.length !== 1) {
    console.error('usage: node scripts/coverage/instrument.cjs <copy of the source tree>');
    return 2;
  }
  const file = path.join(tree, API);
  const { text, count, branches: nb } = instrument(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, text);
  console.log(`instrumented ${count} statements and ${nb} branches of ${API} in ${tree}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { instrument };
