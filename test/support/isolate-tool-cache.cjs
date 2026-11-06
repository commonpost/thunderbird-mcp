// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';

// Loaded with --require by npm test and the coverage run: every bridge the tests start writes its tool cache into
// one throwaway folder, never into the user's cache folder. The test processes inherit the variable; the process
// that set it removes the folder on exit.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.COMMONPOST_MCP_CACHE_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commonpost-test-cache-'));
  process.env.COMMONPOST_MCP_CACHE_DIR = dir;
  process.on('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); });
}
