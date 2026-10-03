# Commonpost MCP for Thunderbird — Claude Code plugin

Thunderbird mail, contacts, calendars and filters as MCP tools for Claude Code and Cowork, through the
[Commonpost MCP add-on](https://github.com/commonpost/thunderbird-mcp) for Thunderbird.

This plugin contains one file that does anything: `mcp-bridge.cjs`, the MCP bridge of the release, a copy of the
repository's `mcp-bridge.cjs` that the project's version check keeps identical. The add-on itself is installed in
Thunderbird separately; see [Quick install](https://github.com/commonpost/thunderbird-mcp#quick-install-about-3-minutes).

## What it runs, and where it connects

- The plugin declares one local MCP server, `commonpost-mail`, started as `node mcp-bridge.cjs` on your computer.
  Node.js 22 or later must be on your `PATH`.
- The bridge talks to the add-on only: it reads the add-on's connection file in your temporary directory
  (`commonpost-mcp/connection.json`, written by Thunderbird, holding the port and a session token) and sends every
  request to `127.0.0.1` on that port, with the token. It opens no other connection, fetches nothing from the
  Internet, and sends nothing anywhere else.
- Your mail, contacts and calendar stay in Thunderbird; the bridge relays each tool call to the add-on and the answer
  back to Claude. Attachments are read and written only where the add-on allows (see the README of the project).
- Nothing runs when Thunderbird or the add-on is not running: the bridge then reports that it found no connection.
- The session token in that file is not a credential of yours: the add-on creates a new one each time Thunderbird
  starts and writes it there for the bridge to read. There is nothing to ask you for, so the plugin declares no
  `userConfig`; the bridge reads the file, checks that it belongs to you (owner and permissions), and uses the token
  for `127.0.0.1` only.

## For a reviewer: what the bridge reads, and what it never sends

- **Credentials.** The bridge reads no API key and no token from environment variables: the only `COMMONPOST_MCP_*`
  variables it reads are `COMMONPOST_MCP_CONNECTION_FILE` (a path), `COMMONPOST_MCP_PACKAGING`, `COMMONPOST_MCP_PROFILE`
  and `COMMONPOST_MCP_DEBUG`. The one secret it handles is the session token in the add-on's connection file
  (`commonpost-mcp/connection.json` in the temporary directory), which it sends to `127.0.0.1` only.
- **Other processes' environment.** On Linux, when Thunderbird runs as a Snap, the bridge reads `/proc/<pid>/environ`
  of processes whose executable is under `/snap/thunderbird/`, only to find their `TMPDIR` (the Snap keeps its
  temporary directory, and the connection file, under `~/snap/thunderbird/`). Nothing read there is kept or sent.
- **Remote hosts.** The two `github.com` addresses in the file are links printed in messages to the user (the
  project's README and a release page). The bridge never fetches them, and opens no connection other than to
  `127.0.0.1`.

## Updates

Each release of the add-on raises the plugin's version, so updating the plugin always gives you the bridge of the
release. Claude Code does not update third-party marketplaces on its own: turn on auto-update for the `commonpost`
marketplace in `/plugin`, or run `/plugin marketplace update commonpost`, then `/reload-plugins`.

## Tool names

Tools from this plugin are named `mcp__plugin_commonpost-mcp_commonpost-mail__<tool>`, for example
`mcp__plugin_commonpost-mcp_commonpost-mail__searchMessages`; use that form in permission rules.

Licensed under the MIT License (see `LICENSE`). Source, issues and releases:
<https://github.com/commonpost/thunderbird-mcp>.
