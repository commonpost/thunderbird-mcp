# Privacy

Commonpost MCP for Thunderbird (the Thunderbird add-on, the MCP bridge, the `.mcpb` bundle and the Claude Code plugin)
collects no data and sends nothing to its developers or to any third party.

- Everything runs on your computer. The add-on serves your mail, contacts, calendars and filters to the bridge on
  `127.0.0.1` only; the bridge relays them to the MCP client you run (Claude Code, Claude Desktop, Cowork or another
  client). What that client then does with the content is governed by its own privacy policy.
- The add-on's only outbound connection is Thunderbird's add-on update check against
  `https://commonpost.github.io/thunderbird-mcp/updates.json`, which you can turn off in Thunderbird. It carries no
  data about you beyond what Thunderbird sends for any add-on update check.
- To leave hidden text out of what the assistant reads, the add-on renders messages in a hidden frame of its own
  background page. That frame loads nothing from the network: the add-on's content security policy allows no remote
  resource, and remote content stays blocked as in Thunderbird.
- No telemetry, no analytics, no crash reports, no accounts, no cookies.
- The session token the add-on writes for the bridge lives in a file of your temporary directory, readable by your
  user only, and is replaced at each Thunderbird start.
- The bridge keeps the last tool list Thunderbird gave it (tool names, descriptions and parameters; no mail and no
  token) in your cache folder, so that a client started before Thunderbird still sees the tools. You can delete it
  at any time.

Questions: open an issue at <https://github.com/commonpost/thunderbird-mcp/issues>; security reports: see
[SECURITY.md](../SECURITY.md).
