'use strict';
// The files of the .mcpb bundle, [path in the repository, name in the archive], and the scripts whose change alters
// the bundle bytes without being in it. Shared by build-mcpb-reproducible.cjs and check-versions.cjs.
const INPUTS = [
  ['mcpb/manifest.json', 'manifest.json'],
  ['mcp-bridge.cjs', 'mcp-bridge.cjs'],
  ['LICENSE', 'LICENSE'],
  ['THIRD-PARTY.md', 'THIRD-PARTY.md'],
  ['extension/icons/icon-128.png', 'icon.png'],
];
const ENTRY_POINT = 'mcp-bridge.cjs';
const BUILDERS = ['scripts/mcpb-inputs.cjs', 'scripts/build-mcpb-reproducible.cjs', 'scripts/zip-stored.cjs'];

module.exports = { INPUTS, ENTRY_POINT, BUILDERS };
