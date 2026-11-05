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
                         | version header   |  8789, Bearer     |   api.js: auth, dispatch, 40 tools       |
                         +------------------+  token            |  options.html / options.js (settings)    |
                                 ^                              +------------------------------------------+
                                 |  reads port + token                       |  writes (0600, folder 0700)
                                 +---- <temp dir>/commonpost-mcp/connection.json <---+
```

### The add-on (`extension/`)

- `manifest.json`: a MailExtension (manifest version 2), id `commonpost-mcp@commonpost.github.io`, Thunderbird 140 or
  later, with its own `update_url`. It declares one Experiment API, `commonpostMcp`, whose parent script is
  `mcp_server/api.js` and whose schema is `mcp_server/schema.json` (20 functions: server start and status, bridge
  status, token, account and tool access, send-safety, network and encrypted-message settings).
- `background.js`: calls `browser.commonpostMcp.start()` at install, at startup and when the add-on is enabled again.
  It does nothing else.
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

A single file that uses only Node's built-in modules (`http`, `fs`, `path`, `os`); the project has no production npm
dependencies (`package.json` lists only `devDependencies`). It:

- reads newline-delimited JSON-RPC from stdin and writes responses to stdout;
- answers `initialize`, `ping`, `server/discover`, `resources/list` and `prompts/list` itself, so a client can connect
  before Thunderbird is ready;
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
- **the Claude Code plugin** (`plugins/claude-code/`, listed by `.claude-plugin/marketplace.json`): a copy of
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
   setting (`isEncryptedContentAllowed`) and the send-safety settings (`isSkipReviewBlocked`, the filter send-rule
   policy).
6. For the message, calendar and contact read tools, `protectMessageToolResult` removes invisible and
   direction-changing characters from text fields, wraps free-text fields in `<email-content id="<random>">` markers,
   and adds a notice that the content is untrusted. A result too large to check this way is refused.
7. The add-on returns a JSON-RPC response; the bridge passes it to the client, adding a one-time notice if the add-on
   is older than the bridge needs (`versionNotice`, never on a direct send).

## How tools are declared, dispatched and limited

- **Declaration.** `buildTools()` in `api.js` returns the 40 tools, each with a name, title, description, group,
  `crud` kind and JSON input schema. `tools/list` returns the enabled ones through `toolListEntry`, which derives the
  MCP annotations (`readOnlyHint`, `destructiveHint`, ...). `test/tool-budget.test.cjs` keeps the list at 40 tools or
  fewer and within size limits; `test/fixtures/tools-list.snapshot.json` records it.
- **Dispatch.** `callTool(name, args)` is a `switch` on the tool name that calls one handler per tool.
- **Limits set by the user** (options page, read on every call):
  - *account access*: an allow-list of accounts; an empty list means all accounts, an unreadable or malformed value
    blocks all of them;
  - *tool access*: a list of disabled tools, hidden from `tools/list` and refused at dispatch; a malformed value
    disables all tools; `listAccounts`, `listFolders` and `getAccountAccess` cannot be disabled;
  - *Block `skipReview`* (on by default): compose tools and `createEvent` / `createTask` open a review window or
    dialog; direct sending or creation is refused while it is on;
  - *Block filter forward/reply* (on by default), or *Ask me each time*: filter rules that would send mail are refused,
    or need a confirmation in a Thunderbird dialog;
  - *Let the assistant read encrypted messages* (off by default);
  - *Listen on all interfaces* (off by default) and *stable token* (off by default).

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
