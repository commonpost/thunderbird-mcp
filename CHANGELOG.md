# Changelog

All notable changes are listed here, newest first. This project is a continuation of
[thunderbird-mcp](https://github.com/TKasperczyk/thunderbird-mcp) by Tomasz Kasperczyk (MIT); the history of that
project is kept in this repository.

## [Unreleased]

### Breaking
- `replyToMessage` with `skipReview` now needs explicit `to` and `from`, and `forwardMessage` with `skipReview` an
  explicit `from`. A direct send no longer takes any address from the original message, which anyone can write: it
  goes only to the caller's `to` / `cc` / `bcc` plus the sending identity's own automatic Cc / Bcc, with that
  identity's Reply-To (a direct reply-all no longer adds the original's To / Cc). The result of a direct send lists
  the `from`, `to`, `cc`, `bcc` and `replyTo` it went out with.

### Added
- `replyToMessage` and `forwardMessage` take `mode`: `window` (the default, the review window as before), `draft` or
  `send`. `mode: "send"` is a direct send, the same as `skipReview: true`, with the same rules: explicit `to` and
  `from`, subject to **Block `skipReview`**, and the bridge waits up to 150 s for it. `mode: "draft"` saves the
  reply or forward to the identity's Drafts folder without opening a window and returns its `messageId` and
  `folderPath`. It sends nothing, so **Block `skipReview`** does not block it.
  - A reply draft gets the recipients Thunderbird's Reply / Reply All computes (`nsMsgCompose.cpp`, ported to a
    pure function): Reply-To and Mail-Reply-To, Mail-Followup-To for Reply All, the author instead of a mailing list
    that rewrites Reply-To, the recipients of your own message from the identity that sent it, your own addresses
    dropped, and the identity's automatic Cc / Bcc and Reply-To. A `to` or `cc` from the caller replaces the
    computed one.
  - The draft stores the state Thunderbird's own reply or forward draft stores (`origURIs`, `queuedDisposition`), so
    the original is marked as replied or forwarded when the draft is sent, not when it is saved.
  - Reply and forward drafts get the body described under Changed.
- `saveDraft` takes `draftId` (and optionally its `folderPath`) to edit an existing draft instead of deleting and
  recreating it, as Thunderbird does when a draft is reopened and saved. Passed fields replace, the others are kept:
  recipients, subject, body, attachments, Reply-To, priority, References, Content-Language, the return receipt / DSN /
  delivery format flags and the reply or forward state. The draft keeps the format of its body; `isHtml` changes it only
  when the whole body is replaced. The old version is removed once the new one is stored. The result has the new
  `messageId` (Thunderbird gives every saved draft a new one) and `replacedDraftId`. With a new `body`, `keepQuote`
  (default true) replaces only the typed text and keeps the cite line, quote, forwarded message and signature;
  `keepAttachments: false` drops the draft's attachments.
- Test bench on a real Thunderbird: `npm run test:tb` (`scripts/tb-bench.sh`) runs a downloaded Thunderbird headless
  with a throwaway profile and synthetic mail (`test/fixtures/mail`), and runs `test/bench/*.test.cjs` against it
  through `mcp-bridge.cjs`, with Marionette for privileged checks. Works with 140 ESR, 153 ESR and 156. See
  CONTRIBUTING.md.
- `docs/thunderbird-internals.md`: notes on how Thunderbird itself composes drafts and replies, quotes, threads,
  searches and filters mail, with the Thunderbird source of each rule and what was verified on a real Thunderbird.

### Changed
- A reply or forward without a window (`mode: "draft"` or `"send"`), `saveDraft` and `sendMail` with `skipReview`
  get the body Thunderbird's compose window would save with the same text typed at its caret: the localized cite line
  (`mailnews.reply_header_type`) and forward header (`mail.show_headers`), the quote from Thunderbird's own quoting
  (`nsIMsgQuote`) and the forwarded body with the original's HTML formatting, the identity's signature (text, HTML,
  file or image) placed by its reply position and signature settings, HTML in UTF-8, plain text as `format=flowed`
  wrapped at `mailnews.wraplength`. Before, a reply or forward quoted the plain-text body by hand under an English
  "On ..., ... wrote:" line or "Forwarded Message" header without a signature, a new message got no signature, a
  plain body went out labeled `format=flowed` without being flowed, and an HTML body (`isHtml: true`) had every
  non-ASCII character written as a `&#...;` reference, which made a Cyrillic body several times larger.
  - A plain-text forward keeps the signature below the forwarded message, as Thunderbird 140 and 158+ do.
    Thunderbird 150-157 drop it (bug 2063939, a regression from Gecko bug 2019689); the tool does not copy that bug.
- The subject of a forward without a window is `mail.forward_subject_prefix` (default `Fwd`) and the original's
  subject as the message database keeps it, as Thunderbird's forward makes it: a forward of "Re: x" is "Fwd: x", and
  of "Fwd: x" is "Fwd: Fwd: x". Before, the prefix was always `Fwd` and was not added to a subject that had it.
- `saveDraft` saves through `nsIMsgCompose`, as Thunderbird's compose window does, and returns the new draft's
  `messageId` and `folderPath`. If `nsIMsgCompose` cannot be used, it falls back to the previous `nsIMsgSend` path.
- `forwardMessage` no longer requires `to`, except with `mode: "send"` (or `skipReview`).
- A reply's References header is the original's References plus its Message-ID, as Thunderbird's reply builds it
  (it used to be the original's Message-ID only); Thunderbird trims a chain longer than the header limit when it
  writes the message, as for its own reply. A reply to a message without Message-ID gets no References. In-Reply-To
  is no longer set by the tool: Thunderbird derives it from the last References entry.
- Without `from`, `replyToMessage` and `forwardMessage` use the identity Thunderbird's own Reply / Forward picks
  (`MailUtils.getIdentityForHeader`, as `ComposeMessage` in `mailCommands.js` calls it) instead of the account's
  default identity: the identity the message was addressed to (To / Cc, then Delivered-To), the identity that sent
  it for a reply to your own message, and for a catch-all identity the address the message was sent to. Identities
  of accounts the MCP may not access are never picked.
- `mcp-bridge.cjs`: a `sendMail`, `replyToMessage` or `forwardMessage` call made with `skipReview`, or a
  `replyToMessage` or `forwardMessage` call with `mode: "send"` (direct send, no compose window), now waits up to 150 s for Thunderbird's answer instead of 30 s, so the bridge no longer gives up
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
