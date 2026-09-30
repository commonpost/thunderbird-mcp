# Changelog

All notable changes are listed here, newest first. This project is a continuation of
[thunderbird-mcp](https://github.com/TKasperczyk/thunderbird-mcp) by Tomasz Kasperczyk (MIT); the history of that
project is kept in this repository.

## [Unreleased]

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
