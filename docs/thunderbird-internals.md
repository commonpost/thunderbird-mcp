# Thunderbird internals for MCP tools

Notes on how Thunderbird itself composes, threads, searches and filters mail, collected while making the tools of
this add-on behave like Thunderbird. Each item names the Thunderbird code it comes from, so it can be re-checked on
a new release. Items marked **bench** were verified on a real, headless Thunderbird 156.0.1 with synthetic mail;
the rest were read from the source.

## Sources

- `omni.ja` of the installed Thunderbird is the exact JavaScript an Experiment runs against. Unpack it with
  `python3 -c "import zipfile; zipfile.ZipFile('<tb>/omni.ja').extractall('<dir>')"`. Most useful:
  `parent/ext-compose.js`, `parent/ext-messages.js`, `modules/MessageSend.sys.mjs`, `modules/MailUtils.sys.mjs`,
  `modules/GlodaAutoComplete.sys.mjs`, `modules/gloda/*`, `messengercompose/MsgComposeCommands.js`,
  `defaults/pref/all-thunderbird.js`, `defaults/pref/mailnews.js`.
- Localized strings live in the langpack under `<tb>/distribution/extensions/`
  (`messengercompose/composeMsgs.properties`, `mime.properties`).
- C++ at the release tag, e.g.
  `https://hg.mozilla.org/releases/comm-release/raw-file/THUNDERBIRD_156_0_1_RELEASE/<path>`:
  `mailnews/compose/src/nsMsgCompose.cpp`, `mailnews/mime/src/mimedrft.cpp`, `mailnews/db/msgdb/src/nsMsgDatabase.cpp`,
  `mailnews/search/src/nsMsgSearchTerm.cpp`, `mailnews/search/src/nsMsgLocalSearch.cpp`.
- Thunderbird's own xpcshell tests are the best usage examples for window-less code:
  `mailnews/compose/test/unit/head_compose.js` (new message without a window), `test_fccReply.js` (reply without a
  window).

A rule of thumb that saved a lot of time: before writing a feature, find the Thunderbird function that does it,
then either call the native API (when it works without a window) or port the rule 1:1 and test it against the same
cases. Unit tests on stubbed XPCOM only prove our own logic; they never prove an assumption about Thunderbird.

## Compose

### Drafts without a window: `nsIMsgCompose` (bench)

`nsIMsgCompose` works without a compose window, and it is the only path that gives Thunderbird's draft semantics:

1. `params.type = New` (or `Draft` with `compFields.draftId` set and an empty `originalMsgURI` to update a draft),
   `params.format`, `params.identity`, `params.composeFields`, and `originalMsgURI` = the original message for a
   reply or forward.
2. `msgCompose.initCompose(params)`.
3. For a reply or forward, set `msgCompose.type = Reply | ForwardInline` **after** `initCompose`. Initializing with
   the real type makes `CreateMessage` overwrite the subject and References with its own (`Re: ` / `Fwd: ` +
   original); setting it afterwards keeps our fields and still records the reply/forward state (this is what
   `test_fccReply.js` does).
4. `msgCompose.sendMsg(Ci.nsIMsgSend.nsMsgSaveAsDraft, identity, accountKey, null, null)`.

Details that matter:

- `progress` must be `null`. With a progress object, `nsMsgCompose::SendMsg` opens `sendProgress.xhtml` over the
  most recent window whenever `mailnews.show_send_progress` is true (the default).
- Completion is `nsIMsgComposeStateListener.ComposeProcessDone`. `RemoveCurrentDraftMessage` updates
  `compFields.draftId` right after it, in the same call, so read `draftId` after one main-thread dispatch.
- With `compFields.draftId` set, the old version is deleted (only if it is in Drafts or Templates; on IMAP it is
  marked `\Deleted`), exactly one draft remains, and `draftId` points to the new one.
- `RememberQueuedDisposition` stores `origURIs` and `queuedDisposition` (`replied` / `forwarded`) on the draft, so
  the original gets its replied/forwarded flag when the draft is sent later. An update through `draftId` carries
  them over. Quirk: a forward draft stores `forwarded`, but reopening compares with `forward`, so Thunderbird itself
  loses the forwarded state of a reopened forward draft.
- The Message-ID is cleared for SaveAsDraft (`SendMsgToServer`); every save gets a new one. Read
  `compFields.messageId` (or the header through `draftId`) after the save.
- `In-Reply-To` is derived from the last References entry by `MimeMessage` when it is not set.
- Identity auto-Cc / auto-Bcc / Reply-To are merged once (`RemoveDuplicateAddresses`) for every type except
  `Draft`, so updates keep the draft's own lists.
- `X-Mozilla-Draft-Info`, `X-Identity-Key` and `FCC` are written. `deliveryformat` stays `Unset` (4) unless set;
  the compose window first sets `mail.default_send_format` (0 = Auto).
- The body is stored as given, in UTF-8, with the type from `params.format`, so the format must follow the body.
  No entity encoding is needed: `MessageSend.sys.mjs` takes the body as an `AString`. Encoding every non-ASCII
  character as `&#...;` makes Cyrillic seven bytes per letter and pushes long lines into QP/base64.
- No windows or prompts open (checked with `domwindowopened` and `common-dialog-loaded` observers). A failed save
  still shows Thunderbird's send report, as `nsIMsgSend` does. A save takes 2-20 ms on a local mbox.

### Quoting: `nsIMsgQuote` (bench)

```js
Cc["@mozilla.org/messengercompose/quoting;1"]
  .createInstance(Ci.nsIMsgQuote)
  .quoteMessage(uri, false, listener, false, hdr);          // 157+
  // .quoteMessage(uri, false, listener, false, false, hdr); // up to 156 (headersOnly)
```

- 157 removed the `headersOnly` argument. XPConnect ignores extra arguments, so the six-argument call on 157 passes
  `false` as the header and drops the real one: the quote then comes from the text/plain part. Call the five-argument
  form first and fall back on `NS_ERROR_XPC_NOT_ENOUGH_ARGS` (`0x80570001`).

- `nsMsgQuote` keeps only a **weak** reference to the listener. The listener must QI to
  `nsIMsgQuotingOutputStreamListener`, `nsIStreamListener` and `nsISupportsWeakReference`, and the caller must hold
  it strongly until `onStopRequest`, or the quote silently never finishes.
- Data arrives as UTF-8 bytes (libmime decodes KOI8-R, windows-1251 and so on). 1-4 ms per message.
- Output: an HTML original gives a sanitized document `<html><head>...</head><body>...</body></html>`; plain text
  gives `<pre wrap class="moz-quote-pre">...</pre>`; `format=flowed` lines are joined with `<br>`; attachments are
  not included. `quoteHeaders = true` returns the same body as `false`.
- It is the quoted body only. `nsMsgCompose` and the editor add the rest: the cite line
  `<div class="moz-cite-prefix">`, then `InsertAsCitedQuotation(body, "mid:<escaped id>")`, which is
  `<blockquote type="cite" cite="mid:...">` around the body of the document, plus `mailnews.remove_plaintext_tag`.

### Reply recipients (`QuotingOutputStreamListener::OnStopRequest`, nsMsgCompose.cpp)

Thunderbird computes reply recipients only while quoting into an editor. Without a window it fills neither the
recipients nor References, so a window-less tool has to port the rules:

- Reply: `Mail-Reply-To` > `Reply-To` > `From`.
- Reply all: `Mail-Followup-To` when present; otherwise the reply target plus To and Cc of the original.
- Reply-To munging: when `Reply-To` is a list address (it contains the `List-Post` address), the reply goes to the
  author, unless `mail.override_list_reply_to` is false.
- Reply to self: the message is from one of the user's identities (checked over all identities when
  `mailnews.reply_to_self_check_all_ident` is true). Then the reply goes to the original To. An identity in To
  keeps this only if the message has Bcc; an identity in Cc cancels it (normal reply). The reply is sent from the
  identity that wrote the original, and the window swaps Reply-To / auto-Cc / auto-Bcc to that identity
  (`LoadIdentity` / `switchIdentityRecipients`).
- Only the sending identity is removed from the recipients, not every address of the user. The identity's auto-Cc,
  auto-Bcc and Reply-To are merged first (as `CreateMessage` does), then `RemoveDuplicateAddresses` runs; the own
  address stays in Cc only when it is the auto-Cc.
- Headers are read raw and parsed as nsMsgCompose does: RFC 2047 decoded, 8-bit bytes as UTF-8.
- A reply to a message without a Message-ID gets no References.

### Sending identity (`mailCommands.js` `ComposeMessage`)

- `folder.customIdentity` first, else `MailUtils.getIdentityForHeader(hdr, type, hint)`, which matches To/Cc and
  then the hint.
- For the displayed message the hint is the earliest `Delivered-To` that names an identity.
- Catch-all: when an identity has catch-all enabled, the hint comes from `mail.compose.catchAllHeaders`, and a
  catch-all match becomes the reply's From, named from To/Cc when possible (`nsMsgComposeService::OpenComposeWindow`).
  ForwardInline ignores catch-all.
- Using the account's default identity instead replies from the wrong address as soon as a user has more than one
  identity per account.

### Cite line and forward header

- Cite line (`QuotingOutputStreamListener` constructor): the template is chosen by `mailnews.reply_header_type`
  from the **localized** `mailnews.reply_header_*` prefs (read with `NS_GetLocalizedUnicharPreference`, i.e.
  `Services.prefs.getComplexValue(name, Ci.nsIPrefLocalizedString)`); the first `#1` / `#2` / `#3` are replaced by
  the author, date and time. Date and time use the short styles (`Services.intl.DateTimeFormat` with
  `dateStyle: "short"` / `timeStyle: "short"`, as `AppDateTimeFormat` does). The author is the display name, else
  the address. HTML: `<div class="moz-cite-prefix">` with `<br>` after every line. A hard-coded English
  "On <date>, <author> wrote:" looks foreign in a localized Thunderbird.
- Forward inline (`mimedrft.cpp`, not `nsIMsgQuote`): the delimiter is `mailnews.forward_header_originalmessage`;
  the header rows come from `mime_insert_normal_headers` / `mime_insert_micro_headers` with labels from
  `mime.properties` (Bcc never, References only for news, empty address lists skipped), rendered as
  `MIME_HEADER_TABLE` in HTML and `Label: value` lines in plain text. The whole body is wrapped in
  `<div class="moz-forward-container">`. Links and images of the original get `moz-do-not-send` unless they point
  into the message (`TagEmbeddedObjects`, `IsEmbeddedObjectSafe`); conditional CSS is dropped
  (`mail.html_sanitize.drop_conditional_css`). Forward drafts and sends carry `References: <original>`, as
  `CreateMessage` does for ForwardInline.
- `nsMsgCompFields::ConvertBodyToPlainText` (`convertBodyToPlainText`) is not callable from JS in 156; a plain
  forward of an HTML original needs its own conversion.

### Signature (`ProcessSignature`)

Only the editor inserts the signature; `nsIMsgSend` and window-less `nsIMsgCompose` add none. The rules:

- `sig_on_reply` / `sig_on_fwd`; a signature file (`attach_signature`, image only in HTML, HTML/text converted to
  the compose format) or `htmlSigText` (`htmlSigFormat`).
- The `-- ` separator is added unless the signature goes above the quote of a reply/forward,
  `suppress_signature_separator` is set, or the text already has one.
- HTML frame: `<pre class="moz-signature" cols=N>` for text, `<div class="moz-signature">` for HTML, with a
  leading `<br>` when paragraph mode is off.
- Layout by `reply_on_top` x `sig_bottom` (`ConvertAndLoadComposeWindow` and
  `MsgComposeCommands.js` `NotifyComposeBodyReady*`), including where the caret (the user's text) goes.
- Thunderbird bug: in Thunderbird 150-157 a plain-text forward has no bottom signature. Gecko bug 2019689 (150)
  made the editor delete the line break after the insertion point, which is the placeholder `<br>` of
  `moz-forward-container`, so the `DeleteNode` on it fails and `ConvertAndLoadComposeWindow` returns before the
  signature. 140 ESR is unaffected; bug 2063939 fixes it in 158 by deleting the div's last `<br>` instead. A tool
  should insert the signature (`InsertLineBreak` + signature block after the forward container) rather than copy
  the bug.

### Plain-text bodies

`nsMsgCompose::SendMsg` serializes the plain editor with flags that produce `format=flowed` space-stuffing and soft
breaks at `mailnews.wraplength`. A body that claims `format=flowed` without doing either renders wrongly in other
clients. Reopening a plain draft adds one stuffing space to lines that start with a space (mimedrft does not
unstuff); that is Thunderbird's behavior too.

### Reopened drafts

A draft reopened and saved again keeps Reply-To, priority and the flags stored in `X-Mozilla-Draft-Info`. When
editing a draft that contains a quote, only the gap before Thunderbird's markers (`moz-cite-prefix`,
`blockquote type=cite`, `moz-forward-container`, `moz-signature`, the forward delimiter) should be replaced, not the
whole body.

## Conversations and search

### Threading (`nsMsgDatabase::ThreadNewHdr`)

- Default threading is by References only (`mail.strict_threading` = true ignores subjects). With
  `mail.correct_threading` (default on) messages that reference the same missing parent are joined.
- Subject threading, when enabled, applies only to messages with the `HasRe` flag (or with
  `mail.thread_without_re`) and only when no reference found a thread.
- Thunderbird has no cross-folder thread table. A cross-folder `threadOf` needs two passes: collect id, References,
  subject and `HasRe` of every header in scope, then join (union-find). Growing the id set during a single scan
  makes the result depend on folder order.
- "Same subject + a shared participant" is too loose: the same outreach mail sent separately to several companies
  with a shared Cc would be merged. Joining by subject only for a `Re:` message whose references reach nothing
  else, and only with an earlier message whose author (or, for own mail, To) is among its participants, keeps such
  mail apart.
- The UI shows `"Re: " + mime2DecodedSubject` when `HasRe` is set; the stored subject has the prefix removed.

### Gloda conversations (bench)

- Gloda never merges existing conversations (bug 478162). `IndexMsg._indexMessage` puts a message into the
  conversation of its own ghost, else of its closest known ancestor. If a reply is indexed before its parent, the
  chain is split in two conversations, and which messages split depends on indexing order.
- A union "seed conversation + conversations of its references" finds the older half from the newer messages, but
  not the newer half from the older ones: there are no ghost links back and references are not queryable.
- Trash and Junk are not indexed. A message copied into a local folder shows up in Gloda about 260 ms later.
- Reading id, References, subject, flags and date from `msgDatabase` costs about 4.4 us per header (~0.45 s per
  100k headers with warm databases), so a header scan is a viable single path for `threadOf` and participant search.

### Participant and domain search

- Gloda's own domain query (as `GlodaAutoComplete` does) is
  `NOUN_IDENTITY.kind("email").valueLike(WILDCARD, "@example.com")`, i.e. SQL `LIKE '%@example.com'`: an exact,
  case-insensitive suffix. `oscar@example.community` does not match `@example.com`, unlike a substring match.
  `involves(...)` then returns incoming and sent mail (From/To/Cc/Bcc).
- Contacts often have no organization field, so "company -> contact -> domain" tends to find nothing; the domain is
  easier to get from mail (search the company name, read the sender addresses). Companies often use more than one
  domain.

### Full-text search (`GlodaMsgSearcher`, `fts3_porter.c`)

- `parseSearchString` splits into words and `"phrases"`; an unpaired quote is dropped. Terms are ANDed; the limit
  is 1000 results.
- `buildFulltextQuery` silently drops terms shorter than 3 UTF-16 units, except `NEAR[/n]` and one or two CJK
  characters (code >= 0x2000). A query of only short terms becomes an empty `MATCH`.
- The tokenizer applies Porter stemming only to words of ASCII letters. Other words are normalized
  (`normalize_character`) and indexed whole, so Cyrillic and most non-Latin text match the exact word form only.

## Reading

- `MsgHdrToMimeMessage` (libmime) converts parts to UTF-8 with charset detection; it is the right source for bodies.
- Raw source has no native decoding. Thunderbird's View Source loads the message URL into `viewSource.xhtml`
  without a declared charset, so Gecko's detector decides; the same detector is exposed as
  `MailStringUtils.detectCharset`. A good order: strict UTF-8, else the charsets declared in `Content-Type`
  headers (non-UTF-8 first), else the detector. Decoding bytes as Latin-1 produces mojibake for every non-ASCII
  message.

## Filters

- `AllAddresses` matches From, To, Cc and Bcc (`nsMsgSearchOfflineMail::ProcessSearchTerm`).
- `nsMsgSearchTerm::MatchRfc822String` tests every parsed address and name, so `endsWith "@example.com"` is
  checked per address; `contains` alone matches the raw header.
- "All mail with company X" is therefore one filter: `allAddresses endsWith "@example.com"` (one condition per
  domain, OR), with the incoming and outgoing triggers. Pairs of "incoming from contains" / "outgoing to or cc
  contains" filters drift apart over time.

## Experiment and platform pitfalls

- Experiment scripts have no web globals. `TextDecoder` is silently `undefined`; import what you need with
  `Cu.importGlobalProperties(["atob", "btoa", "DOMParser", "TextDecoder"])`.
- `folder.addMessage` must use the mbox's own line endings. CRLF messages in an LF mbox made Thunderbird 156's mbox
  reader reject the preceding message (`0x80550023`).
- A compose window's `compose-window-init` event does not bubble; listen on the window itself.
- `nsIMsgSend.createAndSendMessage` returns a promise on 128+ (`MessageSend.sys.mjs`). For `SaveAsDraft` and the
  queue modes it resolves after the copy; for `Now` it resolves as soon as SMTP delivery **starts**
  (`_deliverAsMail` awaits only the request). The outcome of a send is `onStopSending`, `onSendNotPerformed` or
  `onTransportSecurityError` on the listener; `onStopCopy` after a send is only the copy to Sent. Treating the
  promise as success reports rejected recipients or failed authentication as sent. On 140 an identity without an
  outgoing server also resolves the promise without any listener call.
- Thunderbird caches extension code aggressively. After changing the source, remove the add-on, restart, install
  the new XPI and restart again.

## Running a real Thunderbird headless for tests

- Download the release tarball, create a fresh profile from a `user.js`, run with `--headless` and `HOME` /
  `TMPDIR` pointing into a cache directory, so the user's own profile and `connection.json` are never touched.
- Set `network.proxy.type` to 0: on Linux the default (system proxy) takes `HTTP(S)_PROXY` from the environment,
  so a developer's proxy catches even the local SMTP sink, and a proxy asking for credentials opens a dialog that
  blocks Marionette.
- Local Folders alone is not a realistic profile: its server type `none` cannot be the default account, so
  `MailServices.accounts.defaultAccount` is null. A POP3 account on `127.0.0.1` with login and checks disabled
  gives an identity, Inbox, Drafts and Sent without any network.
- `--marionette --remote-allow-system-access` plus a small Marionette client (`len:json` framing,
  `WebDriver:NewSession`, `Marionette:SetContext` chrome, `WebDriver:ExecuteAsyncScript`) runs privileged JS in the
  test profile. That makes the native compose window usable as an oracle: open it as `ComposeMessage` does, save
  with `SaveAsDraft()` and compare the draft with the one the tool produced.
- Never use `--remote-allow-system-access` with a real profile: any local process that reaches the Marionette port
  can then run privileged JavaScript in that profile, with access to its mail, passwords and keys. Use it only on
  a throwaway test profile.
