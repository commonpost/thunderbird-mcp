// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';
/**
 * The branches of a source file, for branch coverage: both outcomes of every decision.
 *
 *   if (c) A else B     'then' (A ran) and 'else' (B ran; with no else, the condition was false at least once)
 *   c ? a : b           'then' and 'else'
 *   l || r, &&, ??      'right' (r was evaluated) and 'short' (l decided alone, r was skipped)
 *   switch              'case' for each case clause, default included
 *
 * Each branch is { kind, anchor, line, col, node, decision }: anchor is the offset that identifies it (the if or the
 * case clause, the first arm of ?:, the right operand of a logical operator), line and col are where the anchor is,
 * so that code run through vm can be matched to the source (report.cjs). Branches are in source order of their
 * anchor; instrument.cjs puts its probes for the same branches in the same order, after the statements.
 *
 * Not counted: default values of parameters and destructuring (V8 does not report them), loops, optional chaining,
 * logical assignment (||=, &&=, ??=) and try/catch.
 */

const { parse } = require('./statements.cjs');

const ORDER = { then: 0, else: 1, right: 2, short: 3, case: 4 };

function branches(source) {
  const out = [];
  const add = (kind, anchor, node, decision) => {
    out.push({ kind, anchor: anchor.range[0], line: anchor.loc.start.line, col: anchor.loc.start.column, node, decision });
  };
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'IfStatement') {
      add('then', node, node.consequent, node);
      add('else', node, node.alternate, node);
    } else if (node.type === 'ConditionalExpression') {
      add('then', node.consequent, node.consequent, node);
      add('else', node.consequent, node.alternate, node);
    } else if (node.type === 'LogicalExpression') {
      add('right', node.right, node.right, node);
      add('short', node.right, node.left, node);
    } else if (node.type === 'SwitchCase') {
      add('case', node, node, node);
    }
    for (const k of Object.keys(node)) {
      if (k === 'parent') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(parse(source));
  return out.sort((a, b) => a.anchor - b.anchor || ORDER[a.kind] - ORDER[b.kind]);
}

/**
 * Whether a branch ran, from V8's run count at each offset of the script (report.cjs counts()). A branch whose arm is
 * code ran if its first character ran; the implicit else and the short-circuit have no code of their own: they ran if
 * the decision ran more often than its arm (an exception thrown by the condition itself would also count). In the
 * condition of a loop, V8 counts how often the loop was entered, not each test: a short-circuit there is seen only if
 * the loop was entered more often than the right operand ran, so the unit-test figure errs low (the lab's probes
 * see every short-circuit).
 */
function taken(b, cnt) {
  const at = (off) => (cnt[off] > 0 ? cnt[off] : 0);
  switch (b.kind) {
    case 'then':
    case 'right':
    case 'case':
      return at(b.node.range[0]) > 0;
    case 'else':
      return b.node ? at(b.node.range[0]) > 0 : at(b.decision.range[0]) > at(b.decision.consequent.range[0]);
    case 'short':
      return at(b.decision.range[0]) > at(b.decision.right.range[0]);
    default:
      return false;
  }
}

module.exports = { branches, taken };
