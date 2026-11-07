# Architecture

This document describes how Commonpost MCP for Thunderbird is built: its components, where each one runs, how a tool
call travels through them, and how the project is built, released and tested. The security reasoning built on this
design is in [assurance-case.md](assurance-case.md). For installation and the list of tools, see the
[README](../README.md).

## What the system is

An MCP ([Model Context Protocol](https://modelcontextprotocol.io/)) server that gives an MCP client (an AI assistant
such as an editor, a desktop app or a command-line agent) access to the mail, contacts, calendars and message filters
of a running Thunderbird. It has two parts that are installed separately:

- a **Thunderbird add-on** (`extension/`), which does all the work inside Thunderbird;
- a **bridge** (`mcp-bridge.cjs`), a small Node.js program that the MCP client starts and talks to over stdio.

Everything runs on the user's computer. The add-on talks to the bridge only; the bridge talks to the MCP client only.

## Components

```
 MCP client                 mcp-bridge.cjs                      Thunderbird (one process)
 (started by the user)      (Node.js >= 22, child of            +------------------------------------------+
                             the MCP client)                    | add-on "Commonpost MCP for Thunderbird"  |
+-----------+   stdio    +------------------+   HTTP POST /     |  background.js -> commonpostMcp.start()  |
| assistant | <--------> | JSON-RPC relay   | <---------------> |  Experiment API "commonpostMcp":         |
+-----------+  JSON-RPC  | attachment paths |  127.0.0.1:8780-  |   httpd.sys.mjs (HTTP server)            |
                         | version header   |  8789, Bearer     |   api.js: auth, dispatch, 41 tools       |
                         +------------------+  token            |  options.html / options.js (settings)    |
                                 ^                              +------------------------------------------+
                                 |  reads port + token                       |  writes (0600, folder 0700)
                                 +---- <temp dir>/commonpost-mcp/connection.json <---+
```

### The add-on (`extension/`)

- `manifest.json`: a MailExtension (manifest version 2), id `commonpost-mcp@commonpost.github.io`, Thunderbird 140 or
  later, with its own `update_url`. It declares one Experiment API, `commonpostMcp`, whose parent script is
  `mcp_server/api.js` and whose schema is `mcp_server/schema.json` (20 functions: server start and status, bridge
  status, token, account and tool access, send-safety, network and encrypted-message settings; one event,
  `onRender`). It also sets a strict `content_security_policy` for the add-on's own pages.
- `background.js`: calls `browser.commonpostMcp.start()` at install, at startup and when the add-on is enabled again.
- `engine-visibility.js`: also loaded in the background page; renders messages for the judgement of hidden text
  (see "Hidden text in HTML bodies" below). It has no privileges: it only answers the `commonpostMcp.onRender`
  event.
- `options.html` / `options.js`: the settings page. It only calls `browser.commonpostMcp.*` functions; the settings
  are stored as Thunderbird preferences under `extensions.commonpost-mcp.*`.
- `mcp_server/api.js`: the Experiment implementation. It runs with Thunderbird's full privileges and uses
  Thunderbird's own modules (`MailServices`, Gloda, the compose and send services, the address book, the calendar
  modules, the filter service). It contains the HTTP request handler, the authentication, the access checks, the tool
  declarations and every tool handler. What it uses, and what could move to standard MailExtension APIs, is listed in
  [experiment-inventory.md](experiment-inventory.md).
- `httpd.sys.mjs`: Mozilla's embedded HTTP server (MPL-2.0, see [THIRD-PARTY.md](../THIRD-PARTY.md)), with local
  changes marked "Commonpost" in the code: a 32 MiB cap on the declared request size, read timeouts (30 s of silence,
  5 minutes in all), and the `Host` handling of the "listen on all interfaces" mode.

### The bridge (`mcp-bridge.cjs`)

A single file that uses only Node's built-in modules (`http`, `fs`, `path`, `os`, `crypto`); the project has no production npm
dependencies (`package.json` lists only `devDependencies`). It:

- reads newline-delimited JSON-RPC from stdin and writes responses to stdout;
- answers `initialize`, `ping`, `server/discover`, `resources/list` and `prompts/list` itself, so a client can connect
  before Thunderbird is ready;
- answers `tools/list` from its tool cache when Thunderbird cannot be reached (`listTools`, `loadToolCache`): the last
  list Thunderbird gave, kept in the user's cache folder (`toolCacheDir`) and written after each new live list
  (`saveToolCache`). Before the first one, the first `tools/list` waits up to 20 s for Thunderbird and then answers
  with an empty list. Meanwhile the bridge looks for Thunderbird every 3 s and sends
  `notifications/tools/list_changed` once Thunderbird lists other tools than the client got
  (`checkForThunderbird`); `initialize` declares `tools.listChanged`;
- finds the add-on through its connection file (`discoverConnectionInfo`): `COMMONPOST_MCP_CONNECTION_FILE` if set,
  otherwise the temporary directory and the Snap, Flatpak and macOS locations described in the README. Each candidate
  is checked before it is trusted (`checkConnectionFileSafety`, `checkConnectionDirSafety`,
  `readConnectionFileVerified`, `checkConnectionOwnerProcess`);
- forwards every other request with `POST /` to `127.0.0.1` on the recorded port, with `Authorization: Bearer
  <token>` and an `X-Commonpost-Bridge` header that states its version and packaging (`tryRequest`);
- for `sendMail`, `saveDraft`, `replyToMessage` and `forwardMessage`, reads attachments given as file paths, refuses
  sensitive ones, and sends their content inline as base64 (`inlineAttachmentPaths`);
- waits 30 s for an ordinary call and 180 s for a call that may send directly or save a draft
  (`requestOptionsFor`);
- with `COMMONPOST_MCP_READ_ONLY` set to `1` or `true`, lists only the tools the add-on marks `readOnlyHint`, plus
  `getMessage` and `getMessages` without `saveAttachments` (`readOnlyToolList`), and refuses any other `tools/call`
  before the attachment step, after asking the add-on for its current tool list (`readOnlyRefusal`).

### Packagings of the bridge

The bridge is the same file in every packaging:

- **the file itself**, attached to each release, which the user registers in the MCP client;
- **the Claude Desktop bundle** (`.mcpb`, built from `mcpb/manifest.json`): contains only the bridge, an icon and the
  licences, and sets `COMMONPOST_MCP_PACKAGING=mcpb`;
- **the Claude Code plugin** (`plugins/claude-code/`, listed by `.claude-plugin/marketplace.json` from the tag and
  commit of the latest release, which the release tool moves once a release is published): a copy of
  `mcp-bridge.cjs` that `scripts/check-versions.cjs` keeps identical to the one at the repository root, and a skill
  (`skills/thunderbird-mail/SKILL.md`, instructions without code) that `test/claude-code-plugin.test.cjs` checks
  against the tools/list snapshot.

None of them contains the add-on. The bridge is not updated automatically; the add-on tells the user when to replace
it (see "Versions" below).

## Startup and discovery

1. Thunderbird loads the add-on; `background.js` calls `commonpostMcp.start()`.
2. `api.js` takes the token from the "stable token" preference if the user set one, otherwise generates 32 random
   bytes with `nsIRandomGenerator` (`generateAuthToken`), shown as 64 hexadecimal characters.
3. It binds the HTTP server to the first free port from 8780 to 8789, on the loopback interface by default
   (`server.start`), or on all IPv4 interfaces if the user enabled "Listen on all interfaces" (`server.startAll`).
4. It writes `<TmpD>/commonpost-mcp/connection.json` (`writeConnectionInfo`): port, token, Thunderbird's process id,
   and the list of profile and mail-store folders that attachments must not come from (`protectedMailDirectories`).
   A timer checks the file every 30 s and rewrites it if it is gone or different.
5. When the MCP client starts the bridge, the bridge finds and checks that file, then uses its port and token.

## How a tool call flows

1. The MCP client writes a `tools/call` request on the bridge's stdin.
2. The bridge inlines path attachments if the tool is one of the four compose tools (checks in
   [assurance-case.md](assurance-case.md)), then posts the request to the add-on.
3. `httpd.sys.mjs` reads the request (size and time limits) and checks the `Host` header.
4. The handler registered on `/` in `api.js` checks, in this order:
   - the bearer token (`timingSafeEqual`), on every request: a wrong or missing token gets `403`;
   - the method (`POST` only) and the declared length (`MAX_REQUEST_BODY`, 32 MiB);
   - JSON parsing; notifications get `202`;
   - for `tools/call`: that the tool exists (`buildTools`), the bridge compatibility decision
     (`bridgeCompatDecision`), that the tool is enabled (`isToolEnabled`), argument coercion and validation against the
     tool's input schema (`coerceToolArgs`, `validateToolArgs`), and the refusal of `mode: "send"` / `"draft"` for
     bridges too old to wait for them (`bridgeModeRefusal`).
5. `callTool` makes sure the folder databases the tool reads are ready, then calls the handler. Handlers apply the
   account restriction (`getAccessibleFolder`, `isAccountAllowed`, `isCollectionAllowed`), the encrypted-message
   setting (`isEncryptedContentAllowed`) and the send-safety settings (`isSkipReviewBlocked`,
   `isCalendarSkipReviewBlocked`, the filter send-rule policy).
6. For the message, calendar and contact read tools, `protectMessageToolResult` removes invisible and
   direction-changing characters from text fields, wraps free-text fields in `<email-content id="<random>">` markers,
   and adds a notice that the content is untrusted. A result too large to check this way is refused.
7. The add-on returns a JSON-RPC response; the bridge passes it to the client, adding a one-time notice if the add-on
   is older than the bridge needs (`versionNotice`, never on a direct send).

## How tools are declared, dispatched and limited

- **Declaration.** `buildTools()` in `api.js` returns the 41 tools, each with a name, title, description, group,
  `crud` kind and JSON input schema. `tools/list` returns the enabled ones through `toolListEntry`, which derives the
  MCP annotations (`readOnlyHint`, `destructiveHint`, ...). `test/tool-budget.test.cjs` keeps the list at 41 tools or
  fewer and within size limits; `test/fixtures/tools-list.snapshot.json` records it.
- **Dispatch.** `callTool(name, args)` is a `switch` on the tool name that calls one handler per tool.
- **Limits set by the user** (options page, read on every call):
  - *account access*: an allow-list of accounts; an empty list means all accounts, an unreadable or malformed value
    blocks all of them;
  - *tool access*: a list of disabled tools, hidden from `tools/list` and refused at dispatch; a malformed value
    disables all tools; `listAccounts`, `listFolders` and `getAccountAccess` cannot be disabled. Once a tool is
    disabled, a tool added by a later update is disabled too until the user enables it: `knownTools` holds the tools
    the options page listed at the last save (the 40 tools of 0.18.2 when it is not set);
  - *Block `skipReview`* for mail (on by default): compose tools open a review window; direct sending is refused
    while it is on;
  - *Block `skipReview`* for events and tasks (on by default; `blockCalendarSkipReview`): `createEvent` and
    `createTask` open a dialog; direct creation is refused while it is on. Until the user saves it, it follows the
    block for mail (`calendarSkipReviewBlocked`), so a configuration from before it existed behaves as it did. The
    dialog they open saves through Thunderbird's transaction (`calendarReviewSave`), and its outcome (open, saved,
    closed, failed) is kept in memory under the `reviewId` of the result (`createCalendarReviewStore`), which
    `listEvents` and `listTasks` read;
  - *Block filter forward/reply* (on by default), or *Ask me each time*: filter rules that would send mail are refused,
    or need a confirmation in a Thunderbird dialog;
  - *Let the assistant read encrypted messages* (off by default);
  - *Listen on all interfaces* (off by default) and *stable token* (off by default).

## Hidden text in HTML bodies

`getMessage` and `getMessages` leave out of the `markdown` and `text` bodies the text of an HTML message that a reader
cannot see in Thunderbird, so that a sender cannot hand the assistant instructions out of the user's sight. The `html`
format returns the sender's HTML unchanged.

1. `api.js` reads the document Thunderbird's message pane shows for the message (`messageDisplayHtml`): the output of
   Thunderbird's MIME code for display, read through the MIME stream converter on a channel of the message URL. It
   has Thunderbird's header tables, its `div.moz-text-html` wrapper and its style sheet link; conditional CSS is
   removed and `cid:` images become message-part URLs, as for the pane.
2. It sends that document, the size of the message pane (`messagePaneViewport`) and the images of the message's own
   parts as `data:` URLs through the Experiment event `commonpostMcp.onRender` to the background page, and waits
   6 s at most (`requestEngineRender`).
3. The background page (`engine-visibility.js`):
   - rewrites, as text, every URL of a loading attribute that is not `http`, `https` or `data` into an inert one,
     and gives up when the message's style sheets would load such URLs or select those attributes (`inertHtml`,
     `checkLoads`): the URLs of Thunderbird's own message protocols must not be loaded outside its main process;
   - parses the document apart (DOMParser) and puts its tree into an empty `<iframe sandbox="allow-same-origin">` of
     the pane's size, which already holds the policy (`frameHtml`): the add-on's `content_security_policy`,
     inherited, plus `default-src 'none'; img-src data:` and `x-dns-prefetch-control: off`. No script runs and
     nothing is loaded from the network;
   - marks the images as the message pane does (`shrinktofit`, `overflowing`) and gives the message's part images
     their content through an adopted style sheet in a cascade layer, which no selector of the message can see;
   - judges every run of text, image and link with the engine's own values (`judge`): `checkVisibility`, visibility,
     opacity product below 0.1, font size below 3 px, SVG text without paint, rectangles clipped away by ancestors
     or outside the page, closed `<details>`, a blend mode, a mask, a colour filter or a strong blur on the text or
     above it, an opaque box painted over it (`elementsFromPoint` at up to three points), and its colour, stroke and
     shadows against what is under it (contrast below 1.2; every colour syntax read through a canvas);
   - answers the text of each unit and which ones are hidden.
4. `api.js` finds the units of the HTML it converts (`engineUnits`) once, in a row, among them (`alignEngineUnits`),
   and the converters take their verdicts (`engineHidingFor`).

Without that (no background page, a timeout, after which the engine rests for 60 s, an encrypted or signed message,
an IMAP message without a local copy, the body not found once in the rendered message, the hidden preference
`extensions.commonpost-mcp.hiddenTextEngine` false), the inline styles of the HTML are read as before
(`hiddenContentJudge`), and over 2 MiB a lexical reading (`stripHtml`). The hidden preference
`extensions.commonpost-mcp.hiddenTextDiagnostics` adds `hiddenTextJudge` to the result: which judge decided, or why
the engine did not.

## Data handled

Mail (headers, bodies, raw source, attachments, folders), contacts and address books, calendars (events, tasks,
categories) and message filters of the accounts the user allows. The add-on can also save attachments of a message to
`<TmpD>/commonpost-mcp/<message id>/` when a tool asks for it.

Nothing is sent by the add-on or the bridge to the developers or to any third party; see [PRIVACY.md](PRIVACY.md).
The content goes to the MCP client the user runs, and what that client does with it (for example, sending it to the
service that runs the assistant) is outside this project. Mail that a tool sends goes through Thunderbird's own send
path and the user's configured servers.

## Versions of the add-on and the bridge

The two parts are installed separately and only the add-on updates itself. Details are in
[RELEASING.md](../RELEASING.md#compatibility-thresholds); in short:

- the add-on's version is the product version (`package.json`, `extension/manifest.json`);
- `BRIDGE_VERSION` in `mcp-bridge.cjs` (and the version in `mcpb/manifest.json`) is the release in which the bridge
  last changed, so it can be lower than the add-on's;
- the bridge warns about an add-on older than `MIN_EXTENSION_VERSION`;
- the add-on reads `X-Commonpost-Bridge` and compares it with `MIN_BRIDGE_VERSION`, `CURRENT_BRIDGE_VERSION`,
  `MODE_MIN_BRIDGE_VERSION` and `BRIDGE_SECURITY_FLOOR` (in `api.js`, "BRIDGE COMPAT"). It can add a notice to a
  result, show a system notification once per bridge, refuse `mode: "send"` / `"draft"` from an old bridge, and,
  only if a release arms the floor (shipped as `0.0.0`), refuse every tool call from older bridges;
- `scripts/check-versions.cjs` enforces these rules in CI and in the release workflow.

## Build and release

- `scripts/build-xpi-reproducible.cjs` builds the XPI from the files of `extension/` as committed (`git ls-tree`),
  as a stored (uncompressed) zip with sorted entries and fixed dates (`scripts/zip-stored.cjs`), with a
  `buildinfo.json` derived from the commit. `scripts/build-mcpb-reproducible.cjs` builds the `.mcpb` the same way.
  Two builds of the same commit give the same bytes.
- `.github/workflows/build-and-release.yml` runs on a `v*.*.*` tag. A `build` job (read-only token) checks the
  version rules, builds both files and runs the tests. A `release` job, in the protected `release` environment that a
  maintainer must approve, rebuilds both from the tag and refuses any difference, creates Sigstore build-provenance
  attestations for the XPI, the `.mcpb` and `mcp-bridge.cjs` (`actions/attest-build-provenance`), publishes them with
  the files and an `.intoto.jsonl` file, then writes `updates.json` (with the XPI's `sha256` as `update_hash`) to the
  `gh-pages` branch, from which installed add-ons update.
- The steps and the checks a maintainer makes are in [RELEASING.md](../RELEASING.md).

## Testing

- **Unit tests** (`npm test`, `node --test test/*.cjs test/*.js`, Node 22 and 24 in CI). Most tests of the add-on
  load a region of `api.js` or `httpd.sys.mjs` between `// BEGIN <name>` and `// END <name>` markers into a Node `vm`
  context with stubbed Thunderbird services, and test it directly. Bridge tests `require()` the bridge, which exports
  its functions without starting. `test/properties.test.js` uses fast-check for property-based tests of the input
  validators. Some tests read the source to check wiring (for example `test/no-trailing-strip-regex.test.cjs`).
- **Real Thunderbird, locally** (`npm run test:tb`, `scripts/tb-bench.sh`): a downloaded Thunderbird runs headless
  with a throwaway profile and the synthetic mail of `test/fixtures/mail`, and `test/bench/*.test.cjs` call it through
  the bridge. See [CONTRIBUTING.md](../CONTRIBUTING.md#tests-on-a-real-thunderbird).
- **Compatibility in CI**: `tb-compat-test.yml` (pull requests that touch the add-on; stable, beta and the next ESR)
  and `tb-version-check.yml` (weekly) load the add-on in current Thunderbird releases.
- **End-to-end lab** (`e2e-lab.yml`, every pull request and push to `main`): the
  [thunderbird-mcp-lab](https://github.com/commonpost/thunderbird-mcp-lab) repository, at a pinned commit, runs the
  extension and the bridge of the tree in a real Thunderbird inside an offline, disposable container, and checks what
  Thunderbird wrote (drafts, filter rules, preferences, mail delivered to a local SMTP sink).
- **Static analysis**: ESLint (`npm run lint`), CodeQL (JavaScript and GitHub Actions), zizmor on the workflows, and
  OpenSSF Scorecard.

How Thunderbird itself composes, threads, searches and filters, which the tools imitate, is documented in
[thunderbird-internals.md](thunderbird-internals.md).
