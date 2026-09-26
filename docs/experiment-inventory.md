# Experiment API inventory

Commonpost MCP for Thunderbird uses one Thunderbird **Experiment API** (`commonpostMcp`, implemented in
`extension/mcp_server/api.js`). Experiments run with Thunderbird's full privileges and are not accepted on
addons.thunderbird.net (ATN) for new add-ons at the time of writing, so this add-on is distributed from GitHub
releases with its own update channel.

This document lists what needs the Experiment and what could move to standard MailExtension APIs. The goal is to
shrink the privileged surface to the minimum, and to keep it in one place. It is an assessment made from reading
the code; the "possible replacement" column has **not** been verified against the current MailExtension API
reference release by release. Corrections are welcome.

## What is privileged today

| Area | Privileged interfaces used | Standard MailExtension alternative |
|---|---|---|
| Local HTTP server for the bridge | `httpd.sys.mjs` (Mozilla's embedded server, MPL-2.0), `resource://` registration, `NetUtil` | None for a listening socket. Native messaging (a small native host started by Thunderbird) would replace the port entirely. |
| Discovery file for the bridge | `nsIFile` and file streams (temp directory, `connection.json`) | Not needed with native messaging. |
| Auth token | `nsIRandomGenerator` | `crypto.getRandomValues` in the background page. |
| Preferences (access control, send safety, token) | `Services.prefs` | `storage.local`. |
| Mail search and read | `MailServices`, `Services.folderLookup`, `Services.messageServiceFromURI`, Gloda (`GlodaMsgSearcher`, `MimeMessage`) | `messages.query`, `messages.getFull`, `messages.getRaw`, `messages.list` (permission `messagesRead`). Full-text body search through Gloda has no equivalent. |
| Folders | `MailServices`, folder methods | `folders.create`, `rename`, `move`, `delete` (permission `accountsFolders`). Emptying Trash and Junk is not exposed. |
| Move, tag, flag, delete messages | `MailServices.copy`, message headers | `messages.move`, `update`, `delete`, `tags` (permission `messagesMove`). |
| Compose, reply, forward, send | `@mozilla.org/messengercompose*`, `nsIMsgSend`, compose params and fields | `compose.beginNew`, `beginReply`, `beginForward`, `sendMessage` (permission `compose`). Direct-send control and inline attachment handling need checking. |
| Contacts | `@mozilla.org/addressbook/cardproperty;1`, `VCardUtils` | `addressBooks` and `contacts` APIs (permission `addressBooks`). |
| Calendar (events, tasks) | `CalEvent`, `CalTodo`, `calUtils`, calendar manager | No stable MailExtension API known to us. |
| Message filters | `@mozilla.org/messenger/filter-service;1`, `Services.filters` | No public MailExtension API. |
| Options page | Standard `options_ui` page; talks to the Experiment for the items above | Fully standard once the items above move. |

## Where the code is

- The Experiment schema is `extension/mcp_server/schema.json` (17 functions: server start and status, token,
  account and tool access, send-safety and network settings).
- All privileged code is in `extension/mcp_server/api.js` and `extension/httpd.sys.mjs`; the background page and the
  options page only call `browser.commonpostMcp.*`.
- Nothing is downloaded or evaluated at run time: the XPI contains the only code that runs, unminified.

## Plan

1. Keep the Experiment isolated in these files (no privileged calls elsewhere).
2. Move what can move to MailExtension APIs, tool by tool, starting with folders, messages and contacts.
3. Replace the local HTTP port with native messaging.
4. What is left (calendar, filters, full-text search) stays as a small residual Experiment, or becomes a proposal
   for a public API to the Thunderbird team.

When the Experiment is small enough and the rules of addons.thunderbird.net allow it, a listing there becomes
possible; the `update_url` in the manifest is then removed, because ATN serves the updates.
