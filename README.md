# Commonpost MCP for Thunderbird

[![CI](https://github.com/commonpost/thunderbird-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/commonpost/thunderbird-mcp/actions/workflows/ci.yml)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14985/badge)](https://www.bestpractices.dev/projects/14985)
[![Tools](https://img.shields.io/badge/40_Tools-email%2C_compose%2C_filters%2C_calendar%2C_contacts-blue.svg)](#what-you-can-do)
[![Localhost Only](https://img.shields.io/badge/Privacy-localhost_only-green.svg)](#security)
[![Thunderbird](https://img.shields.io/badge/Thunderbird-140%2B-0a84ff.svg)](https://www.thunderbird.net/)
[![License: MIT](https://img.shields.io/badge/License-MIT-grey.svg)](LICENSE)

Give your AI assistant full access to Thunderbird -- search mail, compose messages, manage filters, and organize your inbox. All through the [Model Context Protocol](https://modelcontextprotocol.io/).

<p align="center">
  <img src="docs/demo.gif" alt="Demo of the MCP server for Thunderbird" width="600">
</p>

> **A continuation of [thunderbird-mcp](https://github.com/TKasperczyk/thunderbird-mcp) by Tomasz Kasperczyk** (MIT), started from its 0.7.5 release with its full history kept. It is an independent project by the Commonpost community, not the original and not endorsed by it; it can be installed beside the original (see [Migrating](#migrating-from-thunderbird-mcp)). If the original author wants any of this work back, we hand it over: our changes are MIT-licensed and offered upstream too. Thunderbird is a trademark of the Mozilla Foundation; this project is not affiliated with Mozilla or MZLA.
>
> The original was inspired by [bb1/thunderbird-mcp](https://github.com/bb1/thunderbird-mcp). What is in this release is listed in the [changelog](CHANGELOG.md).

---

## Why?

Thunderbird has no official API for AI tools. Your AI assistant can't read your email, can't help you draft replies, can't organize your inbox. This extension fixes that -- it exposes 40 tools over MCP so any compatible AI (Claude, GPT, local models) can work with your mail the way you'd expect.

Mail sends and event/task creation require review by default because **Block `skipReview`** starts enabled. `skipReview: true` is honored only after you explicitly disable that safety setting. **By default, nothing is sent or created without your review.**

---

## How it works

```
                    stdio              HTTP (localhost:8780-8789)
  MCP Client  <----------->  Bridge  <--------------------->  Thunderbird
  (Claude, etc.)           mcp-bridge.cjs                    Extension + HTTP Server
```

The Thunderbird extension embeds a local HTTP server with session-scoped auth tokens. The Node.js bridge translates between MCP's stdio protocol and HTTP, discovering the port and token automatically via a connection file. The bridge handles MCP lifecycle methods (initialize, ping) locally, so clients can connect even before Thunderbird is fully loaded.

---

## What you can do

### Mail

| Tool | Description |
|------|-------------|
| `listAccounts` | List all email accounts and their identities |
| `listFolders` | Browse folder tree with message counts -- filter by account or subtree |
| `searchMessages` | Search by subject, sender, recipient, body preview, date range, or tags. Multi-word queries are AND-of-tokens (every word must appear somewhere). Prefix with `from:`, `subject:`, `to:`, or `cc:` to restrict to one field. Set `searchBody: true` for full-text body search via Thunderbird's Gloda index. Supports `includeSubfolders`, `countOnly`, and offset-based pagination. Results include `threadId` and `preview` snippet. By default, `dedupByMessageId` collapses the same RFC Message-ID found in multiple folders/labels into one row and reports the other folder paths in `dupLocations`; set `dedupByMessageId: false` to return every location. |
| `getMessage` | Read full email content -- `bodyFormat`: `markdown` (default), `text`, or `html`. Set `rawSource: true` for the complete RFC 2822 source (all headers + MIME parts). Optional attachment saving. Set `includeInlineImages: true` to append supported inline CID images as MCP image blocks (PNG, JPEG, GIF, or WebP; max 1 MiB base64 per image and 4 MiB total). Skipped images are reported in attachment metadata. |
| `getMessages` | Read full email content for up to the configured batch limit in one call (default 10, max 20). Uses the same `bodyFormat`, `rawSource`, and attachment options as `getMessage`; each item supplies `messageId` and `folderPath`. |
| `getRecentMessages` | Get recent messages with date, unread, and tag filtering. Supports pagination. Results include `threadId` and `preview`. |
| `displayMessage` | Open a message in Thunderbird's GUI -- `3pane` (default), `tab`, or `window` mode |
| `updateMessage` | Mark read/unread, flag/unflag, add/remove tags, move between folders, or trash -- supports bulk via `messageIds` |
| `deleteMessages` | Delete messages -- drafts are safely moved to Trash |
| `createFolder` | Create new subfolders to organize your mail |
| `renameFolder` | Rename an existing mail folder |
| `deleteFolder` | Delete a folder (moves to Trash, or permanently deletes if already in Trash) |
| `moveFolder` | Move a folder to a new parent within the same account |
| `emptyTrash` | Permanently delete all messages in Trash (including subfolders) |
| `emptyJunk` | Permanently delete all messages in Junk/Spam (including subfolders) |

### Compose

| Tool | Description |
|------|-------------|
| `sendMail` | Compose a new email -- opens a review window; direct sending requires explicitly disabling the `skipReview` safety block |
| `replyToMessage` | Reply with quoted original and proper threading -- `skipReview` is subject to the same safety block |
| `forwardMessage` | Forward with all original attachments preserved -- `skipReview` is subject to the same safety block |

All compose tools open a window for you to review and edit before sending by default. The **Block `skipReview`** preference is on by default, so `skipReview: true` is rejected until you explicitly disable the preference; only then can it send directly. Attachments can be file paths or inline base64 objects.

A direct send can take a while: the bridge waits up to 150 s for Thunderbird (30 s for every other call). Your MCP client may also have its own time limit for a tool call; if it is shorter than 150 s, the client can give up while Thunderbird goes on sending, so check the Sent folder and the Outbox before retrying to avoid sending the message twice.

Compose tools validate the `from` identity strictly -- if the specified sender doesn't match any configured Thunderbird identity, the tool returns an error instead of silently substituting another account.

### Filters

| Tool | Description |
|------|-------------|
| `listFilters` | List all filter rules with human-readable conditions and actions |
| `createFilter` | Create filters with structured conditions (from, subject, date...) and actions (move, tag, flag...) |
| `updateFilter` | Modify a filter's name, enabled state, conditions, or actions |
| `deleteFilter` | Remove a filter by index |
| `reorderFilters` | Change filter execution priority |
| `applyFilters` | Run filters on a folder on demand -- let your AI organize your inbox |
| `getFilterConfirmation` | Read the state of a pending confirmation (see below) |

Full control over Thunderbird's message filters. Changes persist immediately. Your AI can create sorting rules, adjust priorities, and run them on existing mail.

Filter rules that **forward or reply** send mail without the review window that the compose tools keep. The **Block filter forward/reply** setting (Options > Send Safety) is on by default: while it is on, such rules cannot be created or changed through MCP, and a filter list that holds one cannot be run through `applyFilters`. Deleting the rule stays possible. If you choose **Ask me each time** instead, a request of that kind returns `pending_user_confirmation` and Thunderbird shows a dialog with the rule, its conditions and its full destination; nothing is written unless you confirm it there, and closing the dialog or not answering within ten minutes writes nothing.

### Encrypted messages

OpenPGP and S/MIME messages are not decrypted for the assistant by default: `getMessage` returns their headers and a short notice instead of their content. The setting **Let the assistant read encrypted messages** (Options > Encrypted messages) turns this on; the decrypted content is then handed to the assistant, and so to the service that runs it.

### Contacts

| Tool | Description |
|------|-------------|
| `searchContacts` | Search contacts across all address books by email or name and return full contact details. Supports `maxResults`. |
| `getContact` | Read full contact details by UID |
| `createContact` | Create a contact with optional email/name, phones, postal addresses, organization, title, note, and birthday. Phone-only contacts are supported. |
| `updateContact` | Update contact fields; omitted fields stay unchanged, while empty phone/address arrays clear those collections |
| `deleteContact` | Delete a contact by UID |

### Calendar

| Tool | Description |
|------|-------------|
| `listCalendars` | List all calendars with read-only, event, and task support flags |
| `createEvent` | Create a calendar event -- opens a review dialog; direct creation via `skipReview` requires explicitly disabling the default safety block. Accepts `status: tentative \| confirmed \| cancelled` (VEVENT STATUS per iCal RFC 5545). |
| `listEvents` | Query events by date range with recurring event expansion. Returns `status` on each event. |
| `updateEvent` | Modify an event's title, dates, location, description, or `status` |
| `deleteEvent` | Delete a calendar event by ID |
| `createTask` | Open a pre-filled task dialog for review; direct creation via `skipReview` requires explicitly disabling the default safety block |
| `listTasks` | List tasks/to-dos from calendars -- filter by completion status, due date, or calendar |
| `updateTask` | Update a task's title, due date, description, priority, completion status, or percent complete |

### Access Control

| Tool | Description |
|------|-------------|
| `getAccountAccess` | View which accounts the MCP server can access |

Account and tool access are configured via the extension settings page (Tools > Add-ons > Commonpost MCP for Thunderbird > Options). Access control is not MCP-exposed -- only the user can change it.

The same settings page has a "Send Safety" section. **Block `skipReview`** is enabled by default and rejects `skipReview: true` for `sendMail`, `replyToMessage`, `forwardMessage`, `createEvent`, and `createTask`; their review window or dialog still opens normally. `skipReview` is honored only after you explicitly disable this preference.

---

## Setup

### 1. Install the extension

Download `commonpost-mcp-v<version>.xpi` from the [latest release](https://github.com/commonpost/thunderbird-mcp/releases/latest), then in Thunderbird: Tools > Add-ons and Themes > gear menu > Install Add-on From File, and restart. Each release also carries a provenance attestation (`*.sigstore.json`) that ties the XPI to the commit and the workflow that built it; you can check it with `gh attestation verify <file>.xpi --repo commonpost/thunderbird-mcp`. The XPI can be rebuilt byte for byte from the tagged source with `node scripts/build-xpi-reproducible.cjs`.

The MCP bridge, `mcp-bridge.cjs`, is attached to each release next to the XPI (with its own provenance attestation). You can also `git clone --branch v<version> https://github.com/commonpost/thunderbird-mcp.git` and use the file from the clone; use the bridge of the same version as the extension.

Requires Thunderbird 140 or later, and Node.js 22 or later for the bridge (`mcp-bridge.cjs`). Tested on Thunderbird 140.16.0esr, 153.3.1esr and 156.0.1.

**Automatic updates:** the add-on checks `https://commonpost.github.io/thunderbird-mcp/updates.json` through Thunderbird's add-on update check; the file lists the hash of each release. Thunderbird downloads updates in the background and applies them on the next restart; because this add-on uses an Experiment API, updates are not hot-swapped. If updates do not arrive, check the Add-ons gear menu and make sure **Update Add-ons Automatically** is enabled. Thunderbird's default `xpinstall.signatures.required=false` lets unsigned add-ons install; a profile hardened to require signatures blocks both manual and automatic installs. Because the auto-update channel is a code-delivery channel, you can turn it off (per add-on, in its details page) and update by hand.

### 2. Configure your MCP client

Add to your MCP client config (e.g. `~/.claude.json` for Claude Code):

```json
{
  "mcpServers": {
    "commonpost-mail": {
      "command": "node",
      "args": ["/absolute/path/to/commonpost-mcp/mcp-bridge.cjs"]
    }
  }
}
```

### Sandbox-aware connection discovery

The bridge re-discovers `connection.json` on every cache miss. It tries these locations in order:

1. `COMMONPOST_MCP_CONNECTION_FILE`, if set
2. Native temp dir: `<os.tmpdir()>/commonpost-mcp/connection.json`
3. macOS fallback: `/var/folders/*/*/T/commonpost-mcp/connection.json` owned by the current user
4. Linux Snap: Thunderbird's live `TMPDIR` from `/proc/<pid>/environ`, plus the official snap fallback under `~/Downloads/thunderbird.tmp`
5. Linux Flatpak / Betterbird Flatpak: `$XDG_RUNTIME_DIR/app/*/commonpost-mcp/connection.json`

This covers native installs, the official Thunderbird snap, Thunderbird Flatpak, Thunderbird Beta Flatpak, and Betterbird Flatpak without changing the extension side. If multiple sandbox candidates exist at once, the bridge tries the newest file first. Set `COMMONPOST_MCP_CONNECTION_FILE` to force a single explicit path.

Example override:

```json
{
  "mcpServers": {
    "commonpost-mail": {
      "command": "node",
      "args": ["/absolute/path/to/commonpost-mcp/mcp-bridge.cjs"],
      "env": {
        "COMMONPOST_MCP_CONNECTION_FILE": "/absolute/path/to/connection.json"
      }
    }
  }
}
```

That's it. Your AI can now access Thunderbird.

### Migrating from thunderbird-mcp

Both add-ons can be installed at the same time: they use different ids, preferences, ports (8780-8789 here, 8765-8774 there) and temporary directories. Nothing is shared or migrated automatically:

- settings (`extensions.thunderbird-mcp.*`) are **not** copied; set them again in this add-on's options page. Until you do, **every account and tool is visible to MCP clients**: your account and tool restrictions are not carried over;
- your MCP client must point its bridge at this repository's `mcp-bridge.cjs` (or the `commonpost-mcp` binary) and, if you set it, use `COMMONPOST_MCP_CONNECTION_FILE` (the old `THUNDERBIRD_MCP_CONNECTION_FILE` is ignored on purpose, so that one bridge never reads the other add-on's file);
- if you keep both, the options page shows a notice, and each MCP client must be configured for the one you want. To avoid two servers touching the same mailbox, disable the one you do not use.

---

## Security

- **Auth tokens**: The HTTP server requires a session-scoped bearer token. Generated on startup, written to `<TmpD>/commonpost-mcp/connection.json` with 0600 permissions. The bridge re-discovers that file automatically across native installs, Snap, Flatpak, Betterbird Flatpak, and macOS temp directories.
- **Dynamic port**: Tries ports 8780-8789, records the actual port in the connection file. No hardcoded port dependency.
- **Account access control**: Restrict which email accounts are visible to MCP clients via the settings page. Changes take effect immediately.
- **Tool access control**: Disable specific tools via the settings page. Disabled tools are hidden from `tools/list` and blocked at dispatch.
- **Localhost only**: By default, the server binds to localhost only. The "Listen on all interfaces" option in settings binds to all IPv4 interfaces for WSL, Docker, or remote access. **This exposes the MCP server to every device on your local network.** Only enable on trusted networks. Auth token is always required.
- **Auto-update integrity**: Auto-update is a code-delivery channel whose integrity depends on continued control of the GitHub repository, the GitHub Actions token, and the `commonpost` GitHub organization.

---

## If Thunderbird disables Experiment add-ons on the Release channel

This add-on uses a Thunderbird Experiment API (see [docs/experiment-inventory.md](docs/experiment-inventory.md)).
Thunderbird's Add-ons team has announced plans to stop running Experiment-API add-ons on the Release channel, and to
keep supporting them on the ESR (Extended Support Release) channel. As of September 2026 this had not happened yet.

If that happens on your Thunderbird and this add-on stops working: switch to Thunderbird ESR. Downloads for every
platform are on the [official Thunderbird site](https://www.thunderbird.net/en-US/thunderbird/all/) (look for the
"ESR" builds). This continuation has supported Thunderbird ESR since 0.8.2 (minimum 140.0; see the badge above and
[CHANGELOG.md](CHANGELOG.md)).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Extension not loading | Check Tools > Add-ons and Themes. Errors: Tools > Developer Tools > Error Console |
| Connection refused | Make sure Thunderbird is running and the extension is enabled |
| Bridge can't find `connection.json` | Set `COMMONPOST_MCP_CONNECTION_FILE` explicitly if your environment uses a non-standard temp/runtime path |
| On Windows, bridge finds the file but still refuses it | The file must be under the *bridge process's own* `%TEMP%`. Running the bridge under WSL or in a container gives it a different `%TEMP%` than the one Thunderbird (native Windows) used, even if the file is reachable through `\\wsl.localhost\...` or a mount -- this is a correct refusal, not a bug. Set `COMMONPOST_MCP_CONNECTION_FILE` to the file's real path instead |
| On Windows, an attachment under `%TEMP%` is refused | `%TEMP%` sits under `AppData\Local`, which the deny-list treats like the rest of AppData (it holds credentials and app data for other programs on Windows). Copy the file to another folder first, for example Documents |
| Missing recent emails | IMAP folders can be stale. Click the folder in Thunderbird to sync, or right-click > Properties > Repair Folder |
| Tool not found after update | Reconnect MCP (`/mcp` in Claude Code) to pick up new tools |
| `searchBody` returns no results | IMAP accounts need offline sync enabled for Gloda to index message bodies |
| `rawSource` fails on IMAP | Requires local/offline message copy. Enable offline sync or click the message first to cache it. |

---

## Development

```bash
# Build the extension
./scripts/build.sh

# Test via the bridge (handles auth automatically)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp-bridge.cjs

# Test the HTTP API directly.
# On Snap / Flatpak / Betterbird Flatpak / macOS, point CONN_FILE at the
# real file or export COMMONPOST_MCP_CONNECTION_FILE first.
CONN_FILE="${COMMONPOST_MCP_CONNECTION_FILE:-/tmp/commonpost-mcp/connection.json}"
TOKEN=$(jq -r .token "$CONN_FILE")
PORT=$(jq -r .port "$CONN_FILE")
curl -X POST http://127.0.0.1:$PORT \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Dev-only extension reload:** After changing extension source locally, remove the add-on from Thunderbird, restart, reinstall the XPI, and restart again. Thunderbird caches aggressively.

Run the tests with `npm ci --ignore-scripts && npm test`; see [CONTRIBUTING.md](CONTRIBUTING.md). Everything that needs Thunderbird's full privileges is listed in [docs/experiment-inventory.md](docs/experiment-inventory.md).

---

## Project structure

```
commonpost-mcp/
├── mcp-bridge.cjs              # stdio <-> HTTP bridge (auth, port discovery)
├── extension/
│   ├── manifest.json
│   ├── background.js           # Extension entry point
│   ├── httpd.sys.mjs           # Embedded HTTP server (Mozilla)
│   ├── options.html            # Settings page UI
│   ├── options.js              # Settings page logic
│   ├── icons/                  # Extension icons
│   └── mcp_server/
│       ├── api.js              # All 40 MCP tools + auth + access control
│       └── schema.json
├── test/                       # Test suite (node:test; fast-check for the property tests)
├── docs/                       # Experiment inventory, filter API notes
└── scripts/
    ├── build-xpi-reproducible.cjs   # release build (byte-for-byte reproducible)
    ├── build.sh                # quick development build
    └── install.sh
```

## Known issues

- IMAP folder databases can be stale until you click on them in Thunderbird
- HTML-only emails are converted to plain text (original formatting is lost)
- Recurring calendar event CRUD operates on the series, not individual occurrences
- IMAP folder operations (rename, delete, move) are async -- verify with `listFolders` after
- Combining tags with move/trash on IMAP may not preserve tags on the moved copy -- use separate calls
- Pre-existing Thunderbird filters with cross-account move/copy targets are not restricted by account access control
- `searchBody` on IMAP without offline sync only searches headers (Gloda limitation)
- `rawSource` requires offline message copy for IMAP -- online-only messages will error

---

## License and credits

MIT (see [LICENSE](LICENSE)): copyright Tomasz Kasperczyk (original project) and the Commonpost contributors. `extension/httpd.sys.mjs` is Mozilla's embedded HTTP server under the MPL-2.0 (see [THIRD-PARTY.md](THIRD-PARTY.md)). Fixes and ideas taken from upstream pull requests keep their authors: Tony (TKasperczyk/thunderbird-mcp#209), safrano9999 (TKasperczyk/thunderbird-mcp#214), Daniel Glaser (the78mole; TKasperczyk/thunderbird-mcp#195, since superseded by TKasperczyk/thunderbird-mcp#222), Neel Radhakrishnan (TKasperczyk/thunderbird-mcp#175), JordanRO2 (TKasperczyk/thunderbird-mcp#126, and the idea and preference name of the filter send guard, TKasperczyk/thunderbird-mcp#127), KinJLy and coulof (forks).
