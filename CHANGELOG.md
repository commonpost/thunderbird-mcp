# Changelog

All notable changes are listed here, newest first. This project is a continuation of
[thunderbird-mcp](https://github.com/TKasperczyk/thunderbird-mcp) by Tomasz Kasperczyk (MIT); the history of that
project is kept in this repository.

## [Unreleased]

### Added

- Every release page now starts with a summary in plain words ("In short": what is new, what is fixed, what breaks),
  then the steps to update the add-on and the bridge, with a line that says whether the release changes the bridge,
  then the list of changes as before. `scripts/release-notes.cjs` writes it from `CHANGELOG.md` and `BRIDGE_VERSION`;
  from 0.13.0 on, a release whose CHANGELOG section has no summary is refused by the Version sync check.

### Changed

- The notice for a bridge to update, in a tool result and in the options page (section Bridge), says where the copy
  to replace is (the MCP configuration of the client; `claude mcp get <server name>` in Claude Code) and how to
  install the `.mcpb` bundle when the file does not open in Claude Desktop (Settings > Extensions > Advanced settings
  > Install Extension). The options page and the README say that each MCP client has its own bridge.
- A reply without a window (`mode: "draft"` or `"send"`), `saveDraft` and `sendMail` with `skipReview` get the body
  Thunderbird's compose window would save with the same text typed at its caret: the localized cite line
  (`mailnews.reply_header_type`), the quote from Thunderbird's own quoting (`nsIMsgQuote`) with the original's HTML
  formatting, the identity's signature (text, HTML, file or image) placed by its reply position and signature
  settings, HTML in UTF-8, plain text as `format=flowed` wrapped at `mailnews.wraplength`. Before, a reply quoted the
  plain-text body by hand under an English "On ..., ... wrote:" line without a signature, a new message got no
  signature, a plain body went out labeled `format=flowed` without being flowed, and an HTML body (`isHtml: true`)
  had every non-ASCII character written as a `&#...;` reference, which made a Cyrillic body several times larger. A
  forward draft's body is still quoted by the tool. By @mazixs in #28.
  While encrypted content is not allowed, Thunderbird's own quote, which decrypts, is taken only for a message that
  was read and holds no encrypted part: a reply to a message that could not be read in time quotes nothing, as before.

### Fixed

- `mcp-bridge.cjs`: a `saveDraft` call waits up to 150 s for Thunderbird, like `replyToMessage` and `forwardMessage`
  with `mode: "draft"`, instead of 30 s. Thunderbird can take up to 120 s to save a draft, so the bridge used to
  report a timeout for a draft that was still being saved, and a client that retried would create two. After that
  wait the error says the draft may still appear in the Drafts folder later.
- The notice for a bridge to update reached only one of several clients that share an entry, as every bridge 0.11
  or older does (it sends no version): a session that listed its tools within 10 minutes of that notice never got
  one. Its notice now waits and goes out with its first tool call after those 10 minutes.

## [0.12.0] - 2026-10-01

### Breaking

- `replyToMessage` with `skipReview` now needs explicit `to` and `from`, and `forwardMessage` with `skipReview` an
  explicit `from`. A direct send no longer takes any address from the original message, which anyone can write: it
  goes only to the caller's `to` / `cc` / `bcc` plus the sending identity's own automatic Cc / Bcc, with that
  identity's Reply-To (a direct reply-all no longer adds the original's To / Cc). The result of a direct send lists
  the `from`, `to`, `cc`, `bcc` and `replyTo` it went out with. By @mazixs in #26.
- The error that `replyToMessage` and `forwardMessage` return when direct sending is blocked has new text, and it now
  covers `mode: "send"` as well as `skipReview`: it was "User preference blocks skipReview. Retry with skipReview:
  false (or omitted) to open the review window instead.", it is now "User preference blocks direct sending (mode
  \"send\" or skipReview). Use mode \"draft\" to save a draft, or \"window\" (the default) to open a review
  window." A client that matches the old string exactly must be updated (`sendMail`, `createEvent` and `createTask`
  keep theirs). By @mazixs in #27.

### Added

- `replyToMessage` and `forwardMessage` take `mode`: `window` (the default, the review window as before), `draft` or
  `send`. `mode: "send"` is a direct send, the same as `skipReview: true`, with the same rules: explicit `to` and
  `from`, subject to **Block `skipReview`**, and the bridge waits up to 150 s for it. `mode: "draft"` saves the
  reply or forward to the identity's Drafts folder without opening a window and returns its `messageId` and
  `folderPath`. It sends nothing, so **Block `skipReview`** does not block it. By @mazixs in #27.
  `mode: "draft"` needs the `saveDraft` tool to be enabled: a tool the user disabled is not reachable through
  another tool, and the call returns an error saying so.
  - A reply draft gets the recipients Thunderbird's Reply / Reply All computes (`nsMsgCompose.cpp`, ported to a
    pure function): Reply-To and Mail-Reply-To, Mail-Followup-To for Reply All, the author instead of a mailing list
    that rewrites Reply-To, the recipients of your own message from the identity that sent it, your own addresses
    dropped, and the identity's automatic Cc / Bcc and Reply-To. A `to` or `cc` from the caller replaces the
    computed one.
  - The draft stores the state Thunderbird's own reply or forward draft stores (`origURIs`, `queuedDisposition`), so
    the original is marked as replied or forwarded when the draft is sent, not when it is saved.
  - The body is quoted by the tool, as for a direct send.
- The bridge tells the user, once per connection, when the add-on is older than the version it needs
  (`MIN_EXTENSION_VERSION`, 0.12.0). After the first `tools/list` or `tools/call` that Thunderbird answers, it sends
  the add-on an `initialize` on the same validated connection (1.5 s at most, answer capped at 64 KB) and, if the
  add-on is older, appends one text item to the result of the next `tools/call` (Check for Updates, then restart
  Thunderbird; the release page) and writes one line to stderr. Never for a direct send (`skipReview` or
  `mode: "send"`); silent when a version is missing, `0.0.0` or malformed, or when the server is not `commonpost-mcp`; only
  digits from the add-on reach the text. When the add-on is newer, the add-on judges the bridge (below).
- A `.mcpb` bundle for Claude Desktop (macOS and Windows), attached to each release from the next one on: `commonpost-mcp-v<version>.mcpb`, with a provenance attestation. It contains only the stdio bridge (`mcp-bridge.cjs`, `LICENSE`, `THIRD-PARTY.md`, an icon and a `manifest.json` in `mcpb/`, manifest_version 0.3), needs Node.js 22 or later and the add-on of the same release or newer, has no settings and is not signed. It is built by `scripts/build-mcpb-reproducible.cjs` like the XPI (committed files only, sorted stored entries, fixed date: the same bytes on any Node version), and the release job rebuilds it from the tag and refuses any difference. The zip writer moved to `scripts/zip-stored.cjs` (the XPI is byte for byte unchanged). The Version sync check and the tag check now cover `mcpb/manifest.json` too.
- The bridge ignores `COMMONPOST_MCP_CONNECTION_FILE` when its value is exactly an unexpanded `${user_config.…}` placeholder (a client passing an empty optional field through as text) and runs the automatic discovery, instead of pinning itself to a path that cannot exist.
- The bridge answers `server/discover` itself, at once, with the JSON-RPC error -32601 "Method not found", without
  contacting Thunderbird. Clients that speak both protocol eras (MCP 2026-07-28 and earlier, such as Claude Desktop)
  probe with it first and fall back to `initialize`; the probe used to reach Thunderbird and, with Thunderbird closed,
  came back after about 5 s with a discovery error that named local paths.
- The bridge announces itself on every request to the add-on, in the `X-Commonpost-Bridge` header: its version, how it
  was installed (`packaging=mcpb` when the `.mcpb` bundle sets `COMMONPOST_MCP_PACKAGING=mcpb`, otherwise `file`) and,
  when `COMMONPOST_MCP_PROFILE` holds a valid name (a-z, 0-9 and -, 32 at most), `profile=<name>`, reserved for
  per-client tool sets (nothing uses it yet). The header is self-declared: it is not a security boundary, the token
  is.
- The add-on judges bridges older than itself: once per client session (at most every 10 minutes) it adds a notice to
  a tool result when the bridge is older than 0.12.0 or reports no version (0.11 or older), with the release page and
  what to do (`.mcpb` or file); never on a direct send. It refuses `replyToMessage` / `forwardMessage` with
  `mode: "send"` or `"draft"` (without `skipReview`) from such a bridge before doing anything, because an old bridge stops
  waiting after 30 s and can report a failure for a message that is still being sent; `mode: "window"` and every other
  call keep working. A program that calls the HTTP API directly can declare itself with the header (README,
  Development).
- A local security floor in the add-on (`BRIDGE_SECURITY_FLOOR`), shipped disarmed (`0.0.0`): if a future release arms
  it, every tool call from an older bridge, or from a client without the header, is refused before anything acts, with
  the reason and the release page; `tools/list` keeps answering. No remote switch, no setting to bypass it.
- Options page, section "Bridge": the bridges that connected since Thunderbird started (version, installation,
  profile, last seen, status) and the release page to update one. Kept in memory only.

### Changed

- Without `from`, `replyToMessage` and `forwardMessage` use the identity Thunderbird's own Reply / Forward picks
  (`MailUtils.getIdentityForHeader`, as `ComposeMessage` in `mailCommands.js` calls it) instead of the account's
  default identity: the identity the message was addressed to (To / Cc, then Delivered-To), the identity that sent
  it for a reply to your own message, and for a catch-all identity the address the message was sent to. Identities
  of accounts the MCP may not access are never picked. By @mazixs in #26.
  An identity shared by an accessible and a restricted account counts as accessible, whatever the order of the
  accounts, as `findIdentity` already did. Fetching the original message for that choice gives up after 20 s: a
  compose window or a draft then opens without it, and a direct send returns an error instead of hanging. Encrypted
  messages stay withheld from a direct reply or forward while the "read encrypted messages" option is off.
- `saveDraft` saves through `nsIMsgCompose`, as Thunderbird's compose window does, and returns the new draft's
  `messageId` and `folderPath`. If `nsIMsgCompose` cannot be used, it falls back to the previous `nsIMsgSend` path.
  By @mazixs in #27.
- `forwardMessage` no longer requires `to`, except with `mode: "send"` (or `skipReview`). By @mazixs in #27.
- A reply's References header is the original's References plus its Message-ID, as Thunderbird's reply builds it
  (it used to be the original's Message-ID only); Thunderbird trims a chain longer than the header limit when it
  writes the message, as for its own reply. A reply to a message without Message-ID gets no References. In-Reply-To
  is no longer set by the tool: Thunderbird derives it from the last References entry. By @mazixs in #27.
- `mcp-bridge.cjs`: a `replyToMessage` or `forwardMessage` call with `mode: "send"` is a direct send like
  `skipReview: true`, so it waits up to 150 s and gets the same "outcome unknown" error on a timeout. By @mazixs in
  #27. On top, from the maintainers: the mode is compared trimmed and lower-cased to decide that (so `"SEND"`, which
  the extension refuses, still counts as a send: no version notice, the long wait), without changing what is sent to
  the extension; and `mode: "draft"` waits 150 s too, since Thunderbird can take up to 120 s to save a draft and a
  client that retries after 30 s would create two. After that wait the error says the draft may still appear in the
  Drafts folder later.
- README: a "Quick install" section at the top, in five steps, with the Claude Code command (Windows example included) and a bold reminder that the bridge is not updated with the extension. It also corrects the old advice to replace the bridge's `package.json` too: the release ships only `mcp-bridge.cjs`, which needs nothing else.
- README: a new "Other MCP clients" section with the configuration file, location and format of Claude Desktop, VS Code, Cursor, OpenAI Codex CLI and Gemini CLI, checked against each client's documentation, and when and how to set `COMMONPOST_MCP_CONNECTION_FILE` (only if the bridge cannot find the connection file). The bridge is not tied to any client, and `mcpServers` is not the key every client uses.
- RELEASING: the verification step now says that a rebase merge rewrites the commit date, so the reproducible hash built from the pull request branch cannot match the release; compare with a rebuild from a checkout of the tag.
- `BRIDGE_VERSION` is now the release in which the bridge (or anything in its `.mcpb` bundle) last changed, not the
  product version: a release that changes only the add-on ships the same `mcp-bridge.cjs` and the same
  `commonpost-mcp-v<bridge version>.mcpb`, byte for byte. `scripts/check-versions.cjs` replaces the shell check of the
  Version sync job and the version part of the release tag check: product version in `package.json`,
  `package-lock.json` and the add-on manifest; `BRIDGE_VERSION` = `.mcpb` manifest, never newer than the product;
  bridge bundle compared with the previous release tag; thresholds at or below `BRIDGE_VERSION`; an armed floor must
  be announced here.
- `.mcpb` manifest: `homepage` points to the latest release, `documentation` to the README section of the bundle, and
  it sets `COMMONPOST_MCP_PACKAGING=mcpb`.
- Known effect: after a downgrade of the add-on below what the bridge needs, the bridge's notice comes back after each
  restart of Thunderbird.

### Fixed

- The bridge did not start under Claude Desktop's built-in Node.js, which loads the entry point of a .mcpb bundle through a host script with import(): it now also starts when process.argv[1] is this file. Found while testing the bundle of #44 in Claude Desktop 2.16120 (Windows).
- The bridge of a release announced version `0.0.0` in `serverInfo`: it read `package.json`, which the release does not ship (only `mcp-bridge.cjs`), and next to another project's `package.json` it announced that project's version. Its version is now written in `mcp-bridge.cjs` (`BRIDGE_VERSION`), checked by `scripts/check-versions.cjs` (see Changed).

## [0.11.0] - 2026-09-30

The MCP protocol changes below come from #16 by Konstantin (mazixs), rebased on 0.10.1. Its own removal of
invisible characters was replaced by 0.10.0's handling of untrusted content, which covers the same ground; the
escaping of what is left, the table and `dupLocations` handling and the disabled-tool wording were added on top.

The search and reading changes come from #17 by Konstantin (mazixs), rebased on top of #16. On top of it, the
maintainers keep encrypted messages withheld in its new outputs, apply the account restriction to its new paths,
treat its new identifiers and the decoded `rawSource` like the rest of 0.10.0's untrusted-content handling, find
addresses in headers in linear time (two of its regular expressions backtracked quadratically on a long header a
sender can write), and applied the review of #17.

### Breaking
- `getFilterConfirmation` is removed, which brings the server back to 40 tools, the limit Cursor accepts per MCP
  server. Call `listFilters` with `confirmation: true` instead: it returns the same read-only view (the pending
  request and the recent ones, with the limits) and ignores `accountId`; adding `confirmationId` reads one
  request, as before (an unknown id is the same error). `confirmationId` is ignored without `confirmation: true`.
  Without `confirmation`, `listFilters` is unchanged. A disabled-tools preference that still names `getFilterConfirmation` is harmless. Disabling
  `listFilters` now also disables the confirmation view.
- Tool failures are tool results with `isError: true` and `{ "error": "..." }` instead of JSON-RPC errors, as the
  MCP spec asks for errors the model can act on: invalid arguments, a disabled tool, a handler that throws or
  returns `{ error }` (including a message-tool result too large to check for untrusted content, which is still
  refused as a whole), an attachment path the bridge refuses, Thunderbird not reachable, a timeout (with a note
  that the operation may still complete, except for a direct send, whose error already says that the outcome is
  unknown). JSON-RPC errors remain for protocol problems only, with new codes: unknown tool or missing name
  `-32602`, internal errors `-32603` (the extension used `-32000`), unparsable input `-32700` (the bridge used
  `-32700` for every failure).
- Values outside their bounds are rejected with an error that names the bound: `priority` 0-9 (`createTask`,
  `updateTask`), `percentComplete` 0-100 (`updateTask` clamped 150 to 100 before). Only limits are clamped:
  `maxResults` of `listEvents` / `listTasks` is an integer from 1 to 500, a larger value becomes 500 and a fraction
  is floored, while 0 is an error (it meant the default of 100 before).
- `createEvent.status` is an enum (`tentative`, `confirmed`, `cancelled`, in any case); an empty string, which
  meant the default, is rejected, so omit the parameter instead. `updateEvent.status` stays a free string on
  purpose: an empty string there removes the event's status, and any other value is still checked against the
  same three values, in any case.
- `searchMessages` and `getRecentMessages` return a new envelope and compact rows, for every client (#17).
  `format: "legacy"` returns the old envelope and rows: it is deprecated and will be removed in a later release,
  keeps the new folder default (pass `includeTrash: true` for the old one) and the decoded `ccList`, and cannot be
  combined with `groupBy`.

  | | 0.10.x | now |
  |---|---|---|
  | Result | a plain array; `{ messages, totalMatches, offset, limit, hasMore }` only when `offset` is passed | always `{ messages, totalMatches, offset, limit, hasMore }`, plus `incomplete: true` when the scan stopped at 10,000 matches |
  | Default rows | 50 (max 200) | 20 (max 200); `format: "legacy"` keeps 50 |
  | Folders | every folder, Trash and Junk included | Trash and Junk skipped unless `includeTrash: true` or an explicit `folderPath` |
  | `threadId`, `folder` | present | omitted (`threadId` is folder-local; `folderPath` identifies the folder) |
  | Empty fields, `flagged: false` | present (`""`, `[]`, `false`) | omitted |
  | `preview` | the whole stored preview | the first 120 characters, then `...` |
  | `subject` of a reply | without `Re:`, as stored in the database | with `Re:`, as Thunderbird displays it |
  | `ccList` | as stored (may hold MIME encoded-words) | decoded |

- `getMessage` / `getMessages` cut long bodies by default: 20,000 characters for `getMessage` and 4,000 per message
  for `getMessages` (`maxBodyChars`, up to 200,000). A longer body sets `bodyTruncated`, `nextBodyOffset` and
  `bodyTotalChars`; `getMessage` reads the rest with `bodyOffset`. The same cap applies to `rawSource` (#17).
- `rawSource` is decoded text instead of a Latin-1 byte string (see Added), and hidden characters are removed from
  it and counted, as in a body. `rawEncoding: "base64"` returns the exact bytes (#17).
- `getMessage`: the `subject` of a reply keeps `Re:` as Thunderbird displays it (the database stores it without),
  and `ccList` is decoded, also in the result of an encrypted message. The subject of an encrypted message and of
  `rawSource` stays the wire-level one, as in 0.10.0; `displayMessage` is unchanged (#17).
- Search parameters are checked like the others (#17): `offset` must be a whole number from 0, `daysBack` a whole
  number from 1 (0 meant the default of 7, and fractions were floored), `bodyOffset` a whole number from 0, and
  `sortOrder` `asc` or `desc`; other values are errors. `maxResults` of `searchMessages`, `getRecentMessages` and
  `searchContacts` is an integer from 1 to 200 and `maxBodyChars` one from 1 to 200,000: a larger value becomes the
  maximum and a fraction is floored, while 0 is an error (for `maxResults` it meant the default before).
- `searchContacts` leaves empty fields out of each contact and also matches the organization (#17).

### Added
- `initialize` returns short server `instructions` (IDs, untrusted mail content, search, review windows, stale
  IMAP folders), identical in the bridge and the extension. The three lines on search (counts, tables, body
  paging, company mail, conversations) come with #17.
- `tools/list` entries carry `title` and all four annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) set explicitly, since the spec defaults assume a destructive open-world tool. They err on the
  cautious side: `sendMail`, `replyToMessage`, `forwardMessage`, `createFilter`, `updateFilter` and `applyFilters`
  are destructive and open-world (a sent message can't be taken back, and filter rules can forward or reply), and
  `getMessage` / `getMessages` (`saveAttachments` writes files) and `displayMessage` (a displayed message is marked
  read) are not read-only.
- `searchMessages`: `participant:` matches From, To, Cc or Bcc; `participant:@example.com` matches the domain of each
  address exactly, as Gloda's `LIKE '%@domain'` does (`@example.com` no longer matches `example.community`), and
  commas list alternatives for companies with several domains. Operators and quoted phrases combine:
  `participant:@example.com subject:"invoice 42"` (#17).
- `searchMessages` `threadOf: { messageId, folderPath }`: the whole conversation across folders (Sent included),
  oldest first. Headers are read first and then joined by References (union-find), so the result does not depend
  on folder order. A `Re:` message without threading headers joins by subject only the earlier message whose
  author (or, for own mail, a recipient) it involves (`linkedBy: "subject"`), so the same mail sent separately to
  several companies and repeated notifications stay apart. It reads at most 10,000 headers (the search limit) and
  sets `incomplete: true` when it stops there. See `docs/thunderbird-internals.md` (#17).
- `searchMessages` `groupBy: "sender" | "thread"`: one row per sender or conversation, with `count`, `unread`, the
  first and last date, and `latestId` / `latestFolderPath`, the newest message that is not a draft (#17).
- `format: "table"` (`{ columns, rows }`) for `searchMessages`, `getRecentMessages`, `searchContacts`, `listEvents`
  and `listTasks`: fewer tokens on long lists (#17).
- `searchMessages` `tag` accepts a tag's label (`Important`) as well as its key (`$label1`) (#17).
- `searchBody` reports the terms Gloda leaves out (under 3 characters) in `warning`, and errors instead of running
  an empty full-text query; its description says that only English words are stemmed (#17).
- `getMessage` / `getMessages`: `maxBodyChars` and `bodyOffset` page long bodies and raw sources (#17).
- `rawSource` names its charset in `rawCharset`: strict UTF-8, else the charset of the top-level `Content-Type`,
  then those of the parts, else Thunderbird's charset detector. Encodings that cannot decode a whole message are
  refused, declared or detected: the "replacement" labels (`iso-2022-kr`, `hz-gb-2312`, ...), UTF-16 and
  `x-user-defined`. `warning` says when parts declare different charsets (listed in `rawMixedCharsets`) or when
  invalid UTF-8 was replaced with U+FFFD. `rawEncoding: "base64"` returns the exact bytes instead, for 8bit/binary
  parts; its pages are multiples of 4 characters, so each one decodes on its own. Before, 8-bit sources came back
  as Latin-1 mojibake (#17).

### Changed
- Tool results are compact JSON (no indentation). Hidden characters left in them are written as `\uXXXX` escapes: in
  what the untrusted-content handling only counts (`id`, `folderPath`, `filePath`, `dupLocations`, and `latestId` /
  `latestFolderPath`, see below) and in the results of the tools it does not clean (folder, account or filter names,
  ...). The value is the same once parsed, so an id passed back unchanged still finds the same message or folder,
  but the character is visible in the text. The bridge passes compact results through unchanged. **An older bridge
  (0.10.1 or earlier) paired with this extension undoes the escaping**: it parses and re-serializes every result
  (`JSON.parse` / `JSON.stringify`), which writes those characters back raw, as in 0.10.x. Update `mcp-bridge.cjs`
  along with the add-on.
- The untrusted-content handling judges a cell of a `{ columns, rows }` table (`format: "table"`) by its column,
  exactly like the same property of the object form: the tables of #17 get the same treatment as their rows.
- `getRecentMessages` runs the search code with a date filter (#17): every folder of the accessible accounts except
  Trash and Junk (its description said Inboxes; the code already read every folder), newest first, and it asks each
  IMAP folder to update (`updateFolder`) before reading it, as `searchMessages` does. An encrypted message is still
  listed with its content withheld (wire-level subject, no preview, `encrypted: true`), now also in tables and in
  `format: "legacy"`.
- Encrypted messages in the other new outputs of #17, while the option is off: `searchMessages` still leaves out a
  message its query matched (also with `groupBy`), `threadOf` leaves them out of its rows and never links a
  conversation through their stored subject (it can be the decrypted one), and `rawEncoding: "base64"` returns the
  wire-level subject.
- The account restriction covers the new paths of #17: participant search, `groupBy` and `threadOf` (its scope and
  its message) read the accessible accounts only, and the own addresses that tell conversations apart come from
  their identities only.
- The untrusted-content handling counts `latestId` and `latestFolderPath` (the newest message of a `groupBy` row)
  without rewriting them, like `id` and `folderPath`: the assistant passes them back to `getMessage`.
- Argument coercion: enum values match case-insensitively, object parameters passed as JSON strings are parsed.
  Calendar and contact tool descriptions say which ids they take and what they return.
- README lists `saveDraft` and `listCategories`, which were missing from the tool tables, and gives the tool count (40, after `getFilterConfirmation` was folded into `listFilters`).
- A test fails on any regular expression literal that strips a trailing run (`/x+$/`, `/^<+|>+$/g`), which backtracks
  quadratically (CodeQL `js/polynomial-redos`); the remaining ones use a linear `stripTrailing` / `stripLeading`.

### Fixed
- `searchMessages`: the folder URIs in `dupLocations` had their hidden characters removed by the untrusted-content
  handling of 0.10.0, which could desync them from the folder they name. They are now counted only, like
  `folderPath`.
- Filters under an account restriction: an "is in address book" condition naming a mailing list of an accessible
  address book (the book's URI followed by `/<id>`), or a URI with a query string, is no longer refused. The match
  needs a `/` separator, so a look-alike such as `abook.sqlite2` is still refused.
- A local folder whose summary (`.msf`) Thunderbird finds out of date or missing (mbox changed outside Thunderbird, `.msf` deleted) is rebuilt and read again, within 20 s per call, instead of failing with `0x80550005`/`0x80550006` or being skipped silently by `searchMessages` / `getRecentMessages`: the folder a message tool names, each folder a search walks, each message of `getMessages`, the Templates folders of reply rules.
- README: troubleshooting entry for a bridge in a container or under WSL that is refused after it used to find the
  connection file through a mounted temp folder.
- README: the automatic-updates section now says that the bridge does not update itself and must be replaced with the one from the same release.

## [0.10.1] - 2026-09-30

### Changed
- Attachments: the bridge refuses a file that has other hard links ("attach a copy instead"). The extension alone
  cannot see the link count, so that check is made by the bridge only.
- The bridge checks that the process named in the connection file is still running and, on Linux when it can be
  read, is Thunderbird or Betterbird; a stale file is skipped. A file named with `COMMONPOST_MCP_CONNECTION_FILE` is
  not checked (under WSL or in a container, its process id belongs to another system). The bridge also checks that
  the folder holding a discovered connection file is closed to other users.
- Filter conditions "is / isn't in address book" follow the account restriction for address books, when a rule is
  created or updated (and for a condition an update keeps).
- On Windows, attachment paths naming a reserved device (such as `CON`, `NUL`, `COM1`) are refused.
- `updateFilter` can switch a rule off even if it keeps a move/copy target that is no longer accessible; any other
  change is still refused.

### Fixed
- `createEvent` and `createTask` no longer write to a disabled calendar. Thunderbird creates its default "Home"
  calendar disabled until the user turns it on, and a disabled calendar accepts new items but shows and lists none:
  the call reported success for an event or task that neither Thunderbird nor `listEvents` / `listTasks` showed.
  Without a `calendarId` the first writable calendar that is turned on is used; when every writable calendar is
  disabled, or the `calendarId` names a disabled one, the call fails and says to turn the calendar on.
  `listCalendars` now reports `disabled` for each calendar.

### Thanks
- The `SNAP_NAME` check in the Snap Thunderbird detection (0.10.0) was first proposed by @mazixs in #14.

## [0.10.0] - 2026-09-30

Security hardening in filters, attachments, the bridge's connection file, encrypted messages, account restrictions
and message content handed to the assistant. Details will be published on November 10, 2026. Updating is
recommended.

### Added
- Test bench on a real Thunderbird: `npm run test:tb` (`scripts/tb-bench.sh`) runs a downloaded Thunderbird headless
  with a throwaway profile and synthetic mail (`test/fixtures/mail`), and runs `test/bench/*.test.cjs` against it
  through `mcp-bridge.cjs`, with Marionette for privileged checks. Works with 140 ESR, 153 ESR and 156. See
  CONTRIBUTING.md.
- `docs/thunderbird-internals.md`: notes on how Thunderbird itself composes drafts and replies, quotes, threads,
  searches and filters mail, with the Thunderbird source of each rule and what was verified on a real Thunderbird.
- Options: "Let the assistant read encrypted messages", off by default. While it is off, `getMessage` returns the
  headers of an OpenPGP or S/MIME message and a short notice instead of its content ("message chiffré : contenu non
  transmis (option à activer)", with an English rendering), and `replyToMessage` / `forwardMessage` with
  `skipReview` do not quote it and send nothing. Turning the option on lets Thunderbird decrypt such messages for
  the tools; their decrypted content is then handed to the assistant.
- Filter rules that send mail: when "Block filter forward/reply" is switched off (it is on by default and keeps
  refusing such rules), a request to create or change a rule that forwards or replies, or to change or run a filter
  list holding one, needs the user's confirmation in Thunderbird before anything is written. The call returns
  `pending_user_confirmation` and Thunderbird shows its own dialog with the account, the rule, its conditions and
  the full destination; nothing is written unless the user confirms, and refusing, closing the dialog or waiting
  ten minutes writes nothing. The options page presents the two choices as "Always block" (default) and "Ask me
  each time". New read-only tool
  `getFilterConfirmation` reports the state of a request.
- The message tools (`getMessage`, `getMessages`, `searchMessages`, `getRecentMessages`) wrap `body`, `rawSource`
  and `preview` in `<email-content id="...">` markers with a random identifier for each call, and add a text block
  saying that the message text comes from third parties and is to be read as data. Hidden characters (zero-width,
  bidirectional controls, tag characters and similar) are removed from the returned text and counted in that
  notice.

### Changed
- Attachments: a `sendMail`, `saveDraft`, `replyToMessage` or `forwardMessage` call whose attachment is refused
  (missing, too large, on the deny-list, an unsupported path form, more attachments than the per-message limit,
  ...) fails as a whole and names the attachment. `saveDraft` attachments go through the same checks as the other
  tools. The bridge also checks the resolved real path of an attachment. The deny-list covers credential and
  secret filenames (wallet files, private keys, keystores, saved browser/OS credentials, ...), the whole
  Thunderbird/mail-client profile, the signed-in user's macOS `Library` folder (in both its usual and its APFS
  Data-volume real-path form), and, on Windows, AppData together with its compatibility-junction aliases -- except
  the extension's own `<TEMP>\commonpost-mcp\` backup folder, with `connection.json` itself refused even there. On
  Windows, a file path attachment can only be verified through the bridge (which resolves the real path); the
  extension refuses one outright.
- The bridge's connection-file discovery computes `/run/user/<uid>` itself and checks it belongs to the current
  user (rather than trusting `$XDG_RUNTIME_DIR` from the environment), only follows a Snap Thunderbird process
  confirmed by its own binary path and environment marker (with the official snap's Downloads fallback tried only
  after such a process was seen), and checks a Flatpak app id against a closed list.
- Account restrictions apply to calendars and address books (including CardDAV) as well: one that names a
  restricted account is no longer reachable, and a remote one that names no account is refused while a restriction
  is active. An unreadable restriction, or one with an empty selection, refuses everything, on the options page
  as on the server.
- Filter names, condition values and action values are validated: control characters, backslashes and overlong
  values are rejected before they reach Thunderbird's filter file.
- The bridge only accepts a connection file that belongs to the current user (no group or other access on POSIX,
  the user's temporary directory on Windows), checked again immediately before it is read.
- Options: the "Listen on all interfaces" warning now says that the token travels in clear text and that the check
  of the Host header is off in that mode. Removing the add-on while it is still enabled clears the stable token and
  that setting from the profile; removing an add-on that was disabled first does not, so clear the token yourself
  (uncheck "Use stable token") before removing a disabled add-on.
- `mcp-bridge.cjs`: a `sendMail`, `replyToMessage` or `forwardMessage` call made with `skipReview` (direct send, no
  compose window) now waits up to 150 s for Thunderbird's answer instead of 30 s, so the bridge no longer gives up
  before Thunderbird's own 120 s send timeout. Every other call keeps the 30 s limit. If the wait still runs out,
  the error says the outcome is unknown and asks to check the Sent folder and the Outbox before retrying, so the
  message is not sent twice. The same goes for a direct send whose connection to Thunderbird is lost after it was
  opened (reset, closed socket, interrupted response); a connection that could never be opened is still an
  ordinary, retryable error. Note that an MCP client may have its own time limit for a tool call: if it is shorter
  than 150 s, the client can give up while Thunderbird goes on sending, so check the Sent folder before retrying.
- Message bodies converted to Markdown (`bodyFormat: "markdown"`, the default) keep only `http:`, `https:` and
  `mailto:` links. A link with any other scheme (`javascript:`, `file:`, `data:`, `vbscript:`, `cid:`, ...) or
  without an absolute URL becomes its plain text, without the URL. Schemes are compared case-insensitively,
  ignoring leading control characters and spaces and any tab or newline inside the URL. Images become their
  alternative text (or nothing when it is empty), and their addresses are no longer returned, so that a client
  which displays the Markdown does not load tracking images or other remote content; this supersedes the 0.8.2
  behavior that returned remote image URLs. `bodyFormat: "html"` still returns the sender's HTML unchanged.
- HTML bodies larger than 2 MiB are no longer given to the DOM parser: they go through the existing tag-stripping
  path instead, which prints no link or image URL.

### Fixed
- Folder names on Thunderbird 141 and later: `nsIMsgFolder.prettyName` was renamed `localizedName` there, so
  search and recent-message rows had no `folder`, `listFolders` and the folder tools' messages fell back to the
  unlocalized `folder.name`, and the Trash lookup by name found nothing. Folder names now come from
  `localizedName`, or `prettyName` on 140 ESR.
- The Experiment now imports `atob`, `btoa`, `DOMParser` and `TextDecoder`
  (`Cu.importGlobalProperties`). Experiment scripts do not get these web globals, so inside Thunderbird:
  - `getMessage`/`getMessages` returned HTML bodies as flat text instead of Markdown (no links, bold or lists:
    `htmlToMarkdown` fell back to `stripHtml`);
  - `includeInlineImages` never returned an image (`btoa` threw, every image was skipped with
    "Inline image fetch failed");
  - the raw-MIME body fallback returned no body (`TextDecoder` threw) and RFC 2231 attachment names stayed
    percent-encoded;
  - HTML compose bodies with a full document or a `moz-signature` were not cleaned up.
  The unit tests did not catch this because their sandboxes provide Node's globals. A new test fails when
  `api.js` uses one of these globals without importing it, or imports one it does not use.
- Direct sends (`sendMail`, `replyToMessage`, `forwardMessage` with `skipReview`) reported "sent" as soon as the
  SMTP connection started: on Thunderbird 128+ the promise of `createAndSendMessage` resolves when delivery begins
  (`MessageSend._deliverAsMail` awaits only the request), not when it ends. A rejected recipient, failed
  authentication or unreachable server came back as success, and on 140 ESR an identity without an outgoing server
  did too. A send is now settled only by the SMTP outcome (`onStopSending`, `onSendNotPerformed`,
  `onTransportSecurityError`); the copy to Sent (`onStopCopy`) no longer counts. Drafts still complete on the
  promise or on `onStopCopy`. When a send hits the 120 s timeout, the error says that the outcome is unknown and
  to check Sent and the Outbox before retrying.
- `applyFilters` runs only the rules that are enabled and marked "Manually Run", as Thunderbird's own "Run Filters on
  Folder" does, and skips a rule that moves or copies to a folder of an account the restriction does not allow; the
  result lists what ran and what was skipped. It used to run every rule of the list, disabled or not. `updateFilter`
  no longer keeps such a move/copy target on a rule it modifies.
- The Outbox ("Unsent Messages") is refused as a destination: `updateMessage` `moveTo` and filter rules created or
  changed through MCP cannot file messages there. `applyFilters` skips an existing rule that moves or copies to it,
  and `updateFilter` refuses to keep such a target.

## [0.8.3] - 2026-09-27

### Added
- README: a section on what to do if Thunderbird disables Experiment-API add-ons on the Release channel, as its
  Add-ons team has announced (switch to Thunderbird ESR, supported since 0.8.2).
- `mcp-bridge.cjs`: when Thunderbird cannot be reached (no connection file, or the connection is refused), the
  error now also suggests checking that the add-on is enabled, since Thunderbird Release may disable Experiment
  add-ons, with a link to the new README section. The bridge is not updated with the add-on: download
  `mcp-bridge.cjs` from this release to get the new message.

### Changed
- `docs/experiment-inventory.md`: the Calendar row now notes Thunderbird's announced (but, as far as we found,
  not yet shipped or documented) WebExtension calendar API.

## [0.8.2] - 2026-09-27

### Added
- `listFolders` accepts `favoritesOnly` and reports `isFavorite` on every folder, so a client can find the folders
  the user has marked as favorites in Thunderbird without listing hundreds of others (upstream
  TKasperczyk/thunderbird-mcp#201 by Peter D Bethke). In `format: "table"`, `isFavorite` is appended as the last
  column; the pre-existing columns keep their order.

### Changed
- Supports Thunderbird ESR 140 and 153 again (minimum 140.0); tested on 140.16.0esr, 153.3.1esr and 156.0.1.
- With `bodyFormat: "markdown"` (the default) or `"html"`, a `multipart/alternative` body now comes from its HTML
  part when it has one, including its links and image URLs, converted to Markdown -- not the plain-text
  alternative, as before. This does not apply outside an alternative: a container that mixes a plain-text part
  with a separate HTML part (not offered as an alternative of each other) still returns whichever comes first, as
  it already did. Remote image URLs now show up in the Markdown output; a client that renders it may load them --
  only inline tracking pixels (3px or smaller) are filtered.

### Fixed
- `getMessage`/`getMessages` honor `bodyFormat` when a message's body is a structured `multipart/alternative`
  container instead of always preferring the plain-text part, and concatenate every inline part of the requested
  type found in a container that is not itself an alternative -- instead of returning only the first one -- so a
  message such as Apple Mail's `alternative[plain, mixed[html, inline PDF, html]]` no longer loses everything past
  the inline attachment (upstream TKasperczyk/thunderbird-mcp#186 by Przemysław Pietrzak). With `bodyFormat:
  "markdown"` or `"html"`, a text/plain or text/html leaf that is a real attachment (e.g. an attached `.txt`
  file) is excluded from the body, matched against `allUserAttachments` the same way an inline image already
  was elsewhere in this file. This does not extend to `bodyFormat: "text"` (or the plain-text quoting used by
  `replyToMessage`/`forwardMessage`), which goes through Thunderbird's own `coerceBodyToPlaintext()` instead and
  is not attachment-aware there either -- not a regression from main, which never excluded attachments on any path.
- `getRecentMessages` result rows now carry `ccList`, like `searchMessages` already does (upstream
  TKasperczyk/thunderbird-mcp#174 by Gunther Schulz).
- `scripts/install.sh` discovers a Thunderbird profile installed through Snap on Linux (upstream
  TKasperczyk/thunderbird-mcp#201 by Peter D Bethke), and shows the full path instead of the ambiguous bare
  directory name in its profile-picker menu when two profiles share one -- for example after Ubuntu's Thunderbird
  deb-to-snap migration, which commonly leaves a Snap profile alongside a leftover one with the same name.

### Also fixed upstream
These upstream pull requests fix problems already fixed here:
- TKasperczyk/thunderbird-mcp#223 by Daniel Glaser (the78mole): unhandled rejection in the reply/forward promise
  chains -- the same fix is in 0.8.1 (PR #5).
- Windows: TKasperczyk/thunderbird-mcp#170, TKasperczyk/thunderbird-mcp#183, TKasperczyk/thunderbird-mcp#189,
  TKasperczyk/thunderbird-mcp#191, TKasperczyk/thunderbird-mcp#199, TKasperczyk/thunderbird-mcp#204,
  TKasperczyk/thunderbird-mcp#206.
- Attachments: TKasperczyk/thunderbird-mcp#188 (large Base64 attachments).
- Filters: TKasperczyk/thunderbird-mcp#200.

## [0.8.1] - 2026-09-27

Filter validation is adapted from the third commit of TKasperczyk/thunderbird-mcp#222 (Daniel Glaser, the78mole),
which addressed our own review of #195 (#222's predecessor). Not everything below comes from #222: `stripHtml` and
the code-scanning cleanups are separate fixes, listed under Fixed.

### Breaking
- `listFilters` now reports a `date` condition's value as `YYYY-MM-DD` (a local calendar day) instead of an
  ISO-8601 instant in UTC.
- Only `YYYY-MM-DD` is accepted for a `date` condition's value: every other form `Date.parse` would read (a
  date-time, with or without a time zone) and a bare number are now refused. A date-time was never reliable here --
  see the note for 0.8.0 users below -- so rather than keep guessing which local day it meant, it is refused
  outright, with a hint pointing at `YYYY-MM-DD`.
- `hasAttachment` now refuses any supplied value; only an empty one is accepted (the operator, `is`/`isnt`, carries
  has/hasn't).
- **Note for 0.8.0 users:** a `date` condition saved with a `YYYY-MM-DD` value under 0.8.0 may have been stored one
  day earlier than intended, anywhere west of UTC (see Fixed below); and a `hasAttachment` condition given the
  value `"false"` meant "has an attachment", not "has none" (0.8.0 silently ignored the value it was given, and
  Thunderbird's own filter engine reads only the operator). Neither is fixed by installing 0.8.1: check existing
  filters with `listFilters` and recreate any that are wrong.

### Changed
- Integer condition and action values are validated strictly (`/^-?\d+$/`, no `parseInt` rounding) and bounded
  where Thunderbird itself bounds them: `size`/`status` up to 4294967295 (`unsigned long`), `ageInDays` up to
  2147483647 (`long`), `junkPercent`/`junkScore` 0-100, `priority`/`changePriority` within
  `nsMsgPriority.lowest..highest`. Schema hints spell the values out (units, bounds, `2=lowest`..`6=highest`,
  `1=read`, `2=replied`, ...).
- Error messages say "Action value" or "Condition value" depending on where they come from, not always the latter.
- Internal assertion: `buildRuleActions`/`planFilterUpdate` now check up front that they were given the
  folder-access helper (`resolveFolder`); no change in behaviour.

### Fixed
- A `date` condition's value used to be stored one day earlier than intended anywhere west of UTC: Thunderbird
  stores and displays filter dates as a local calendar day (fix from TKasperczyk/thunderbird-mcp#175 by
  @ncrosty58).
- `listFilters` reads back the `hdrProperty` of a term on a header-property attribute, which used to be dropped on
  read-back.
- An error raised while replying to or forwarding a message now ends the tool call with an error instead of
  leaving it pending.
- Plain-text conversion of HTML mail (`stripHtml`) now ends a `<script>` or `<style>` block on an end tag with
  whitespace or other characters before `>` (e.g. `</script >`), as HTML parsers do, so the block's contents no
  longer show up in the text.
- Code scanning cleanups: tags are removed until none are left in link text of task descriptions (the text was
  already HTML-escaped, so no markup could get through), and two tests escape every regular-expression character.

Our "first readable member" fallback (`copySearchValue`) for attributes outside the typed table is unchanged, as is
`updateFilter` giving up (no rule saved) when copying an existing condition or action fails -- both already worked
this way before this release.

## [0.8.0] - 2026-09-26

First release of **Commonpost MCP for Thunderbird**, a continuation of thunderbird-mcp 0.7.5.

### Changed
- New identity so that it can be installed **beside** the original add-on in the same profile: add-on id
  `commonpost-mcp@commonpost.github.io`, preferences `extensions.commonpost-mcp.*`, temporary directory
  `commonpost-mcp/`, environment variables `COMMONPOST_MCP_*` (no fallback on the old names), Experiment namespace
  `commonpostMcp`, default port range 8780-8789 (the original uses 8765-8774), MCP server name `commonpost-mcp`.
  See "Migrating from thunderbird-mcp" in the README.
- Automatic updates come from `https://commonpost.github.io/thunderbird-mcp/updates.json`.
- Requires Thunderbird 156 or later and Node.js 22 or later for the bridge and the tests: the tested versions.

### Added
- The options page warns when the original thunderbird-mcp add-on is also active.
- Reproducible XPI build (`scripts/build-xpi-reproducible.cjs`); the release carries a build provenance
  attestation (`*.sigstore.json`); LICENSE and THIRD-PARTY.md are inside the XPI.
- Filter rules that forward or reply can no longer be created or changed through MCP while the new
  **Block filter forward/reply** setting is on (default: on). Idea and preference name from
  TKasperczyk/thunderbird-mcp#127 by JordanRO2.
- Property-based tests (fast-check); CI with pinned actions, CodeQL, zizmor and OpenSSF Scorecard; lockfile.

### Fixed
- Windows: the server no longer fails to start because of a POSIX permission check on the temporary directory
  (TKasperczyk/thunderbird-mcp#209 by Tony).
- A failed server start is now visible in the options page and can be retried without restarting Thunderbird (TKasperczyk/thunderbird-mcp#179).
- Large inline attachments (Base64) no longer overflow the regular-expression stack; the size limit is checked
  first (TKasperczyk/thunderbird-mcp#214 by safrano9999).
- Filters: search attributes, operators and actions are resolved by name instead of hand-numbered tables,
  values are typed, and updating a filter copies what it does not change faithfully (TKasperczyk/thunderbird-mcp#195 by Daniel
  Glaser (the78mole), since superseded by TKasperczyk/thunderbird-mcp#222, and ideas from
  TKasperczyk/thunderbird-mcp#175 by Neel Radhakrishnan).
- Removed a source of ESLint errors in the filter code (rethrown errors keep their `cause`).

### Removed
- The pre-built `dist/thunderbird-mcp.xpi` is no longer tracked in git; releases carry the XPI.
