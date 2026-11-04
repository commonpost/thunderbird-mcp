#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';
/**
 * Instruments extension/mcp_server/api.js of a COPY of the source tree, for statement coverage in a real Thunderbird
 * (the end-to-end lab, commonpost/thunderbird-mcp-lab):
 *
 *   node scripts/coverage/instrument.cjs <copy of the tree>
 *
 * Every statement (statements.cjs) gets `__cpCov[i]=1;` in front of it, on the same line, so that line numbers do not
 * move. A repeating timer writes the bitmap of the statements run (hex, 4 statements per digit, statement i = bit
 * i % 4 of digit i / 4) to <profile>/cp-coverage.txt every 250 ms; the lab returns it as coverage_hex. Never run an
 * instrumented add-on outside the lab: it writes to the profile.
 */

const fs = require('fs');
const path = require('path');
const { statements } = require('./statements.cjs');

const API = 'extension/mcp_server/api.js';

function instrument(source) {
  const points = statements(source);
  let out = '';
  let last = 0;
  points.forEach(([at], i) => {
    out += source.slice(last, at) + `__cpCov[${i}]=1;`;
    last = at;
  });
  out += source.slice(last);
  const header = [
    `var __cpCov = new Uint8Array(${points.length});`,
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
  const at = out.indexOf(directive);
  if (at < 0) throw new Error(`${API} has no "use strict" directive to put the coverage header after`);
  return { text: out.slice(0, at + directive.length) + ' ' + header + out.slice(at + directive.length), count: points.length };
}

function main(argv) {
  const tree = argv[0];
  if (!tree || argv.length !== 1) {
    console.error('usage: node scripts/coverage/instrument.cjs <copy of the source tree>');
    return 2;
  }
  const file = path.join(tree, API);
  const { text, count } = instrument(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, text);
  console.log(`instrumented ${count} statements of ${API} in ${tree}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { instrument };
