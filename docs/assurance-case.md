# Assurance case

This document argues why Commonpost MCP for Thunderbird meets its security requirements, and says where it does not.
It covers the threat model, the trust boundaries, the secure design principles applied, the common implementation
weaknesses countered, the supply chain, and the known limits. Each claim names the file (and, where useful, the
function) that implements it, and the test that covers it when there is one. The components are described in
[architecture.md](architecture.md); how to report a vulnerability is in [SECURITY.md](../SECURITY.md).

Security requirements, in short: only the user's own MCP client, through the bridge, can use the add-on; it sees only
the accounts and tools the user allows; nothing is sent without the user's review unless the user turned that
protection off (events and tasks are added at once on a new install, unless the user turns their block on or the
client asks for the dialog); encrypted mail stays encrypted unless the user allows otherwise; local files that
hold secrets or mail stores are not attached to outgoing mail; text written by third parties is handed over as data,
marked as such.

## 1. Threat model

### Assets

- Mail content and metadata of every Thunderbird account, including encrypted messages and attachments.
- Contacts and address books; calendars, events and tasks; message filter rules.
- The ability to send mail as the user, to change or delete mail, folders, contacts, events and filters.
- Local files the user's account can read (they could be attached to outgoing mail).
- The session token in `connection.json`, which grants all of the above.
- The update channel (`updates.json` on `gh-pages`) and the release files, which deliver code to Thunderbird.

### Actors

| Actor | Trust | What it can do |
|---|---|---|
| The user | Trusted | Installs and configures the add-on; reviews compose windows and dialogs. |
| The MCP client and its assistant | Trusted to call tools, but its decisions can be steered by content it reads | Calls any enabled tool with any arguments. |
| Senders of mail, invitations, shared calendars and contact cards | Untrusted | Control message bodies, headers, attachment names and calendar or contact text; can try to inject instructions (prompt injection). |
| Other processes of the same user | Trusted by design (same account; see SECURITY.md, "out of scope") | Can read the token file and the profile, as they can read the mail store itself. |
| Other local users of the same machine | Untrusted | Can try to read or replace the connection file, or race it in a shared temporary directory. |
| Web pages in a browser on the same machine | Untrusted | Can send requests to `127.0.0.1` ports (CSRF, DNS rebinding). |
| Devices on the local network | Untrusted | Can reach the port only if the user enabled "Listen on all interfaces". |
| The release and update channel | Must be protected | A compromised repository, workflow or organization could ship code to every installed add-on. |

## 2. Trust boundaries

1. **stdio, MCP client to bridge.** JSON-RPC on stdin/stdout of a process the client started. The client is trusted
   to call tools; the arguments are checked as if they were not (section 4).
2. **The local HTTP port, bridge to add-on.** `httpd.sys.mjs` and the handler on `/` in `api.js`. The token is the
   boundary; the `X-Commonpost-Bridge` header is self-declared and is not one (SECURITY.md).
3. **The add-on to Thunderbird.** The Experiment API `commonpostMcp` runs with Thunderbird's full privileges; the tool
   handlers decide what a caller may reach. Only `api.js` and `httpd.sys.mjs` hold privileged code
   ([experiment-inventory.md](experiment-inventory.md), CONTRIBUTING rule 5).
4. **Third-party content to instructions.** Text from messages, events, tasks and contact notes reaches the assistant
   inside tool results. It is data, never instructions; the add-on marks it but cannot make the assistant obey that.
5. **The file system.** The connection file (written by the add-on, read by the bridge), attachments read from paths
   for outgoing mail, attachments saved from messages, and the profile.
6. **Rendered mail, in the background page.** To judge hidden text, the HTML of a message is rendered in a frame of the
   background page ([architecture.md](architecture.md#hidden-text-in-html-bodies)). The frame is sandboxed without
   scripts, under the add-on's content security policy and its own (no remote resource), and URLs other than
   `http`, `https` and `data` never reach it. Its answer to `api.js` (which text is hidden) is checked for shape and
   can only decide what is left out of a body.

## 3. Secure design principles applied

**Least privilege.**
- The user can restrict the accounts (`isAccountAllowed`, `getAccessibleFolder`; for address books and calendars,
  `isCollectionAllowed`) and disable tools (`isToolEnabled`). A sender identity must belong to an allowed account
  (`test/identity-restriction.test.cjs`). Tests: `test/account-restriction.test.cjs`, `test/tool-access.test.cjs`.
- A tool the user disabled cannot be reached through another tool: `mode: "draft"` needs `saveDraft` enabled,
  `latestInThread` needs `searchMessages` (README, CHANGELOG 0.14.0).
- Encrypted messages are not decrypted for the assistant unless the user allows it (`isEncryptedContentAllowed`,
  default off; `isEncryptedMimeMessage`, `mayQuoteOriginal`). Test: `test/encrypted-messages.test.cjs`.
- Access control is not exposed over MCP: only the options page calls the setters of `schema.json`.

**Fail-safe defaults.**
- *Block `skipReview`* for mail is on by default and read as on if the preference cannot be read
  (`isSkipReviewBlocked`): compose tools open a review window; direct sending is refused (`composeModeRefusal`, test
  in `test/compose-helpers.test.cjs`).
- *Block `skipReview`* for events and tasks is not a fail-safe default: a new install turns it off, and
  `createEvent` and `createTask` then add the item at once unless the client asks for the dialog
  (`calendarCreateMode`). Adding an event or task sends nothing (these tools take no attendees) and can be undone with
  `deleteEvent` or `deleteTask`, and `updateEvent` already changes events without review. An update writes the value
  of the block for mail, and an install into a profile where the block for mail was set follows it
  (`applyCalendarInstallDefault`, on `onInstalled`; `test/background-install.test.cjs`), so an existing configuration
  keeps the dialog. Unset, it follows the block for mail; a value that is not a boolean, or one that cannot be read, blocks
  (`calendarSkipReviewBlocked`, tests in `test/compose-helpers.test.cjs`, `test/calendar-write-target.test.cjs` and
  `test/calendar-skipreview-block.test.cjs`). The options page saves it before the block for mail, so lifting one
  never lifts the other.
- *Block filter forward/reply* is on by default; "Ask me each time" needs a confirmation in a Thunderbird dialog, and
  no answer within ten minutes writes nothing (`filterSendRulePolicy`; `test/commonpost-filter-confirm.test.cjs`).
- A malformed account preference blocks every account; a malformed tool preference disables every tool
  (`getAllowedAccountIds`, `resolveToolAccess`). Once the user has disabled a tool, a tool added by a later update
  stays disabled until the user enables it (`knownTools`; `test/tool-access.test.cjs`).
- An address book or calendar that names a restricted account, or a remote one that names none, is refused
  (`isCollectionAllowed`).
- The server listens on loopback unless the user enables "Listen on all interfaces".
- The bridge forwards nothing without a valid connection file and token (`awaitConnectionInfo`).

**Complete mediation.** Every HTTP request is checked for the token before anything else, including non-`POST`
requests. Every `tools/call` passes through the same sequence in the handler on `/`: known tool, bridge
compatibility, tool enabled, argument coercion and schema validation (`validateToolArgs` rejects unknown parameters),
mode refusal. Settings are read on every call, so a change applies at once. The account restriction is checked inside
each handler (there are 24 `getAccessibleFolder` call sites), not at one central point: see section 6.

**Economy of mechanism.** One privileged Experiment with one HTTP endpoint (`POST /`); a bridge of one file with no
dependencies; no network access by either part apart from Thunderbird's add-on update check
([PRIVACY.md](PRIVACY.md)).

**Separation.** The bridge, in the MCP client's process tree, does the file-system work that needs a real path
(attachment checks, connection-file checks); the add-on does the mail work. Each re-checks what it can: attachment
deny-lists exist on both sides (`isSensitiveFilePath` in both files, kept in sync).

**Input validation and output marking.**
- Arguments: JSON Schema per tool (`validateAgainstSchema`), canonical base64 only (`isValidBase64`), clamped limits
  (`coerceToolArgs`). Tests: `test/validation.test.cjs`, `test/tool-arguments.test.cjs`, `test/stress.test.cjs`,
  property-based `test/properties.test.js`.
- Untrusted output: `protectMessageToolResult` removes invisible and direction-changing characters, wraps bodies,
  previews, raw source, event and task titles, descriptions, locations and contact notes in
  `<email-content id="<random nonce>">` markers, and adds a notice; a result too large to walk is refused rather than
  returned unmarked. Other results have hidden characters escaped (`escapeHiddenCharacters`). The server instructions
  sent at `initialize` say that email content is untrusted. Tests: `test/untrusted-content.test.cjs`,
  `test/search-untrusted-tables.test.cjs`.
- HTML converted to Markdown keeps only `http`, `https` and `mailto` links and never emits image URLs
  (`safeEmailUrl`; `test/html-link-schemes.test.cjs`).
- Hidden text: the text of an HTML body that a reader cannot see in Thunderbird is left out of the `markdown` and
  `text` bodies, judged on the message as Thunderbird's message pane renders it (`hiddenTextEngineJudgement`,
  `engine-visibility.js`), else on its inline styles (`hiddenContentJudge`). Tests:
  `test/hidden-text-engine.test.cjs`, `test/engine-visibility.test.cjs`, `test/html-hidden-*.test.cjs`, and the lab
  scenario `getmessage-hidden-text`.

**Limits on size and time.** Request body 32 MiB (in `httpd.sys.mjs` before buffering, and `MAX_REQUEST_BODY` in
`api.js`); request read 30 s of silence, 5 minutes in all (`REQUEST_READ_TIMEOUT_MS`, `REQUEST_READ_MAX_MS`;
`test/request-read-timeout.test.cjs`); message parse 20 s (`MIME_LOAD_TIMEOUT_MS`; `test/mime-load-timeout.test.cjs`);
send and draft save 120 s; attachments 20 per message, 50 MiB in all; search results 200; `getMessages` 20; body
paging (`maxBodyChars`); raw MIME parts and depth (`RAW_MIME_MAX_PARTS`, attachment search 1,000 parts, depth 10);
connection file 64 KiB in the bridge.

## 4. Common weaknesses countered

| Weakness | Where it is handled | Tests |
|---|---|---|
| Unauthenticated access to the port | Bearer token of 32 random bytes (`generateAuthToken`), compared in constant time on every request (`timingSafeEqual`); `403` otherwise. | `test/auth.test.cjs` |
| CSRF from a web page | Every request needs the `Authorization` header, which a page cannot add to a cross-origin request without a CORS preflight; the server sends no CORS headers and answers the preflight with `403`. | `test/auth.test.cjs` (token) |
| DNS rebinding | In loopback mode, `httpd.sys.mjs` answers `400` to a `Host` header that is not one of its own names (`resolveIdentityFromHostHeader`); the token is still required. In "listen on all interfaces" mode the `Host` is not checked. | `test/httpd-host-fallback.test.cjs` |
| Token theft or substitution through the connection file | Add-on: folder created `0700`, refused if a symlink or (POSIX) group/other-accessible; file created `O_EXCL`, mode `0600` (`writeConnectionInfo`). Bridge: regular file only, owner and mode checked, folder checked, opened with `O_NOFOLLOW` and re-checked by `fstat` (same device and inode), size capped, Windows file required under the user's `%TEMP%`, writer process alive and (Linux) Thunderbird or Betterbird; token must be 64 lowercase hex; sent only to `127.0.0.1`. | `test/mcp-bridge.test.cjs`, `test/commonpost-bridge.test.cjs`, `test/write-connection-info-windows.test.cjs`, `test/connection-file-placeholder.test.cjs` |
| Path traversal and secret exfiltration through attachments | Bridge and add-on deny-lists (`isSensitiveFilePath`): dotfiles, credential files, system folders, mail-client profiles, macOS `~/Library`, Windows AppData and its junction aliases, UNC/device paths, ambiguous Windows names; the bridge also checks the real path and the profile and mail-store folders listed in the connection file. The add-on checks symlinked parents and refuses all string paths on Windows. A refused attachment fails the whole call. | `test/commonpost-bridge.test.cjs`, `test/attachment-refusal.test.cjs`, `test/attachment-temp-cleanup.test.cjs` |
| Path traversal when saving attachments | File names reduced to `[A-Za-z0-9._-]`, message id to `[A-Za-z0-9]`, files created with `createUnique` and mode `0600` under a `0700` folder (`sanitizeFilename`, `ensureAttachmentDir` in `getMessage`). | none found |
| Remote fetch or local file read when composing (SSRF) | `moz-do-not-send="false"` from the caller or a message is neutralized (`neutralizeEmbedMarks`); images and links of a quoted message are marked not to be sent (`tagQuotedObjects`); attachments of a message that only point to a file or URL are never opened (`isExternalAttachment`). | `test/quoted-objects.test.cjs`, `test/compose-helpers.test.cjs`, `test/external-attachment.test.cjs` |
| Header injection | No project-specific check: subject and recipients are passed to Thunderbird's compose fields (`nsIMsgCompFields`), and Thunderbird writes the headers. | none |
| ReDoS and quadratic loops | Trailing-run stripping uses a loop (`stripTrailing`), and a test forbids the regular-expression form in the scanned files; base64 validation avoids a repeated group. | `test/no-trailing-strip-regex.test.cjs`, `test/properties.test.js` |
| Resource exhaustion through MIME | Part, depth and header-size limits in the raw MIME parser; encrypted-check walks are bounded and fail closed (`isEncryptedMimeMessage`); HTML over 2 MiB is not parsed into a DOM. | `test/raw-mime-*.test.cjs`, `test/encrypted-outer-subject.test.cjs` |
| Prototype pollution and unknown arguments | Unknown parameters are rejected using `hasOwnProperty` on the schema (`validateToolArgs`). | `test/validation.test.cjs` |
| A stale connection file leading the token to another program | Owner-process check in the bridge (`checkConnectionOwnerProcess`). | `test/mcp-bridge.test.cjs` |
| Instructions hidden from the user in an HTML message (prompt injection out of sight) | The message is rendered as Thunderbird's message pane shows it (libmime's output, the pane's size, Thunderbird's style sheet) and only the text a reader could see is kept; the inline styles decide when it cannot be rendered. The `html` format is unchanged. | `test/hidden-text-engine.test.cjs`, `test/engine-visibility.test.cjs`, lab `getmessage-hidden-text` |
| Network access or code from a rendered message | Frame sandboxed without scripts; the add-on's content security policy (checked at startup: the engine stays off when it is not in force) and the frame's own (`default-src 'none'`); DNS prefetch off; URLs of loading attributes other than `http`, `https` and `data` rewritten to an inert scheme before the HTML is parsed, and no rendering when the message's CSS would load or select them (those URLs must not be loaded outside Thunderbird's main process). | `test/engine-visibility.test.cjs`; lab runs observing every TCP connection and DNS query |
| A planted tool cache, to put instructions in tool descriptions the model reads | The bridge serves its tool cache only when Thunderbird cannot be reached. POSIX: folder created `0700`, refused if a symlink, owned by another user or group/other-writable; file opened with `O_NOFOLLOW`, then owner, mode and size checked by `fstat`; written through a `0600` temporary file and a rename. Windows: the user's own `%LOCALAPPDATA%`, never a UNC or device path. In read-only mode, every call is still checked against the add-on's live list (`readOnlyRefusal`). | `test/bridge-cold-start.test.cjs` |

## 5. Supply chain and process

- **Dependencies.** No production npm dependencies; the bridge uses only Node's built-in modules. Dev dependencies
  are installed from the committed lockfile with `npm ci --ignore-scripts`.
- **Workflows.** Every action is pinned by full commit SHA; workflows default to `contents: read`; checkouts use
  `persist-credentials: false` (`.github/workflows/*.yml`). zizmor audits the workflows (`zizmor.yml`), CodeQL analyzes
  JavaScript and the workflows (`codeql.yml`), OpenSSF Scorecard runs weekly (`scorecard.yml`).
- **Dependabot** (`.github/dependabot.yml`) updates npm and GitHub Actions weekly with a 7-day cooldown.
- **Required checks and protected refs.** `main` is protected by a ruleset (no deletion, no force push, pull request
  required, review threads resolved) that requires the tests (Node 22 and 24), Lint, Version sync, zizmor, CodeQL and
  the end-to-end lab, on a branch up to date with `main`. A second ruleset protects the release tags, and the
  `release` environment needs a maintainer's approval ([RELEASING.md](../RELEASING.md)). The organization requires
  two-factor authentication.
- **Reproducible builds and provenance.** The XPI and the `.mcpb` are built byte for byte from the committed tree
  (`scripts/build-*-reproducible.cjs`; `test/build-reproducible.test.cjs`, `test/build-mcpb.test.cjs`). The release
  job runs only after approval of the protected `release` environment, rebuilds both from the tag and refuses any
  difference, then attests the XPI, the `.mcpb` and the bridge with Sigstore build provenance
  (`build-and-release.yml`). Users can check them with `gh attestation verify` (README).
- **Update channel.** `updates.json` is published by the release job after it re-downloads the XPI and checks its
  SHA-256; the manifest carries that hash as `update_hash` (`scripts/gen-updates.js`; `test/gen-updates.test.cjs`).
- **Vulnerability handling.** Private vulnerability reporting, response targets and coordinated disclosure are in
  [SECURITY.md](../SECURITY.md); security releases in [RELEASING.md](../RELEASING.md#security-releases). Security fixes
  are listed under "Security" in [CHANGELOG.md](../CHANGELOG.md) (0.14.0, 0.17.1, 0.17.4, 0.17.5, 0.18.1, 0.19.1).
  [Published advisories](https://github.com/commonpost/thunderbird-mcp/security/advisories?state=published), with the
  version that fixes each:
  [GHSA-vgv3-crg8-3rfh](https://github.com/commonpost/thunderbird-mcp/security/advisories/GHSA-vgv3-crg8-3rfh) (0.10.0),
  [GHSA-x2mh-cqhm-f8mg](https://github.com/commonpost/thunderbird-mcp/security/advisories/GHSA-x2mh-cqhm-f8mg) (0.14.0),
  [GHSA-65cp-vcv7-cf69](https://github.com/commonpost/thunderbird-mcp/security/advisories/GHSA-65cp-vcv7-cf69) (0.17.1),
  [GHSA-whwf-gghm-mwx9](https://github.com/commonpost/thunderbird-mcp/security/advisories/GHSA-whwf-gghm-mwx9) (0.18.1),
  [GHSA-8v8g-5qhh-q3wr](https://github.com/commonpost/thunderbird-mcp/security/advisories/GHSA-8v8g-5qhh-q3wr) (0.19.1).
- **Testing in a real Thunderbird.** The end-to-end lab and the compatibility workflows (see
  [architecture.md](architecture.md#testing)).

## 6. Known limits and residual risks

- **One maintainer.** The project has a single maintainer, who alone can approve releases ([GOVERNANCE.md](../GOVERNANCE.md)).
- **Full privileges.** The add-on is an Experiment and runs with all of Thunderbird's privileges; a flaw in `api.js`
  or `httpd.sys.mjs` is a flaw with those privileges. Thunderbird has announced it may stop running Experiment add-ons
  on its Release channel (README).
- **Unsigned add-on and its update channel.** The XPI is not signed by Mozilla and installs only where
  `xpinstall.signatures.required` is false (Thunderbird's default). Updates depend on the integrity of the GitHub
  repository, its Actions token and the `commonpost` organization (README, "Auto-update integrity"). The update can be
  turned off per add-on.
- **Prompt injection is reduced, not prevented.** Markers, hidden-character removal, the notice and the review
  defaults help; an assistant can still be persuaded by a message to call tools the user allowed. Subjects, sender
  names and attachment names are cleaned of hidden characters but are not wrapped in markers (only `body`,
  `rawSource`, `preview`, `title`, `description`, `location` and `note` are). With *Block `skipReview`* for mail turned off,
  an injected instruction can send mail without review. With the block for events and tasks off, the default of a new
  install, it can add events and tasks to any calendar the add-on may write to, shared ones included, without review
  and with no limit on their number: text with links that colleagues see, time shown as busy, and reminders that
  Thunderbird pops up later, outside the conversation. `updateEvent`, `updateTask`, `deleteEvent` and `deleteTask` change existing items without review whatever
  these settings say.
- **Hidden text is judged, not proven.** The rendering imitates the message pane at its current size, without the
  user's zoom, the images the user let load from the network, the dark-mode recolouring or a different window. Text in
  a font with blank glyphs is not detected, nor a box painted over the text that hit testing does not see
  (`pointer-events: none`, a pseudo-element, an image); a blend mode, a mask, a colour filter or a strong blur counts
  as hiding, which can remove readable text. The thresholds are a font below 3 px, an opacity below 0.1 and a colour
  contrast below 1.2. When the engine cannot render a message, the inline styles alone decide, which misses
  style-sheet rules.
- **Same-user processes are trusted.** Any program running as the user can read the token and call every enabled tool.
  The optional stable token is stored in a Thunderbird preference, in the profile.
- **"Listen on all interfaces"** exposes the port to the network over plain HTTP: the token and the mail content
  travel unencrypted, and the `Host` header is not checked. Only the token protects it. It is off by default; the
  README recommends running the bridge over SSH instead, which keeps the port on localhost.
- **Account restriction is per handler.** A handler that forgot it would bypass it. Pre-existing filters with
  cross-account move or copy targets are not restricted (README, "Known issues").
- **Encrypted messages in listings.** The cheap envelope check used in searches and listings fails open when the raw
  headers cannot be read (`isRawMimeEnvelopeEncrypted`), for example an IMAP message without a local copy;
  `getMessage` fails closed. For `getMessages` `headersOnly`, the subject of such a message is withheld.
- **Attachment search** finds only messages Thunderbird flags as having attachments; signed (`multipart/signed`),
  `multipart/related` and single-part messages are usually not found (README).
- **Thunderbird's behaviour.** Sending, header encoding, MIME parsing for display, Gloda indexing and IMAP state are
  Thunderbird's; the add-on inherits their bugs. IMAP folders can be stale until opened.
- **Attachment deny-lists are lists.** A secret in a file with an ordinary name in an ordinary folder is not
  recognized. Folders seen by the bridge under another path (WSL, containers), and profiles other than the running
  one, are not fully covered (README, "Attachments refused").
- **Bridge resource limits.** The bridge does not bound the length of a stdin line or of a response from the add-on;
  a local process that can write to it is already trusted (SECURITY.md).
- **Coverage.** The Coverage workflow measures statement and branch coverage from the unit tests and the end-to-end
  lab: 93.2% of the statements and 87.8% of the branches on 2026-11-04 (`api.js`: 91.9% and 86.7%; `mcp-bridge.cjs`:
  99.5% and 97.1%), and the workflow fails below 90% or 80%. A branch is one
  outcome of an `if`, `?:`, `&&`, `||` or `??`, or one `case`; default values, loops and optional chaining are not
  counted. Code that the tests run through `vm` is mapped back to `api.js` by text, and lines a test changed are not
  counted; the bench (`npm run test:tb`) is not counted.
