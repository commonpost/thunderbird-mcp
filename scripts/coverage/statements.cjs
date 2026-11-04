// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';
/**
 * The statements of a source file, for statement coverage: every statement of a block body (program, block, static
 * block, switch case), directives ("use strict") left out. Each one is [start offset, start line (1-based)], in
 * source order. instrument.cjs puts its probes in front of the same statements, in the same order, so that bit i of
 * the bitmap the lab returns is statement i of this list.
 */

// eslint-disable-next-line n/no-unpublished-require -- coverage tooling runs from a checkout with its dev dependencies
const espree = require('espree');

const BODY_KEYS = { Program: 'body', BlockStatement: 'body', StaticBlock: 'body', SwitchCase: 'consequent' };

function parse(source) {
  // A shebang line is not JavaScript: blank it out, keeping every offset.
  const end = source.startsWith('#!') ? source.indexOf('\n') : -1;
  const text = end >= 0 ? ' '.repeat(end) + source.slice(end) : source;
  let lastError;
  for (const sourceType of ['script', 'commonjs', 'module']) {
    try {
      return espree.parse(text, { ecmaVersion: 'latest', sourceType, range: true, loc: true });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function statements(source) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    const key = BODY_KEYS[node.type];
    if (key) {
      for (const st of node[key]) {
        if (!st.directive) out.push([st.range[0], st.loc.start.line]);
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'parent') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(parse(source));
  return out.sort((a, b) => a[0] - b[0]);
}

module.exports = { statements };
