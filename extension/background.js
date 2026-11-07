// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
// `browser` is declared as a global in eslint.config.mjs for the
// extension/ file group. The per-file /* global browser */ comment
// would trigger no-redeclare.
async function init() {
  try {
    const result = await browser.commonpostMcp.start();
    if (result.success) {
      console.log("MCP server started on port", result.port);
    } else {
      console.error("Failed to start MCP server:", result.error);
    }
  } catch (e) {
    console.error("Error starting MCP server:", e);
  }
}

// A new install writes its defaults (events and tasks are added at once); an update writes what the profile had, so
// a later "install" of the same profile changes nothing. The settings are read on every call, so a server started by
// the init() below follows them as soon as they are written.
async function onInstalled(details) {
  const reason = details && details.reason;
  if (reason === "install" || reason === "update") {
    try {
      await browser.commonpostMcp.applyInstallDefaults(reason);
    } catch (e) {
      console.error("Error writing the defaults of the install:", e);
    }
  }
  await init();
}

browser.runtime.onInstalled.addListener(onInstalled);
browser.runtime.onStartup.addListener(init);

// Also call init() directly — the event listeners above don't fire when
// a user disables and re-enables the extension.
init();