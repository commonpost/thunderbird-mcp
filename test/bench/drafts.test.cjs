"use strict";
// Drafts are saved through nsIMsgCompose, like Thunderbird's compose window: identity, format, reply / forward state;
// a draft edited with draftId keeps what Thunderbird keeps when it reopens and saves a draft.
const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, mcp, tbLib, closeAll, FOLDER } = require("./helpers.cjs");

const ORIGINAL = "chain1@alpha.test";

const clearDrafts = () => tbLib("clearFolder(args.drafts);", { drafts: FOLDER.drafts });

const listDrafts = () => tbLib("return hdrs(args.drafts).map(h => h.messageId);", { drafts: FOLDER.drafts });

// Draft state, threading headers and how often each of them occurs in the stored message.
const DETAILS_OF = String.raw`
async function detailsOf(h) {
  const raw = await rawOf(h);
  const head = headersOf(raw);
  const block = raw.split(/\r?\n\r?\n/)[0];
  const count = name => (block.match(new RegExp("^" + name + ":", "gim")) || []).length;
  return {
    ...draftState(h),
    subject: head.subject || "",
    references: head.references || "", inReplyTo: head["in-reply-to"] || "", forwardedId: head["x-forwarded-message-id"] || "",
    counts: { references: count("References"), inReplyTo: count("In-Reply-To") },
  };
}
`;

const draftDetails = id => tbLib(`${DETAILS_OF}
  const h = hdrById(args.drafts, args.id);
  if (!h) return null;
  const head = headersOf(await rawOf(h));
  const identity = MailServices.accounts.defaultAccount.defaultIdentity;
  return {
    ...(await detailsOf(h)),
    identityKey: head["x-identity-key"], expectedIdentityKey: identity.key,
    draftInfo: head["x-mozilla-draft-info"] || "",
    sendFormat: Services.prefs.getIntPref("mail.default_send_format", 0),
  };
`, { drafts: FOLDER.drafts, id });

// What Thunderbird itself stores for a reply / forward draft of an Inbox message.
const nativeDraft = (type, messageId) => tbLib(`${DETAILS_OF}
  const win = await openNativeCompose(Ci.nsIMsgCompType[args.type], hdrById(args.inbox, args.messageId));
  const draft = await saveNativeDraft(win);
  const out = await detailsOf(draft);
  await closeCompose(win);
  draft.folder.deleteMessages([draft], null, true, false, null, false);
  return out;
`, { type, messageId, inbox: FOLDER.inbox });

const SKIPPED_HEADERS = ["message-id", "date", "x-mozilla-status", "x-mozilla-status2", "x-mozilla-keys"];

// Headers of a stored draft (without the ones every save changes) and its draft state.
const draftHeaders = (source, id) => tbLib(`${source}
  const head = headersOf(await rawOf(h));
  return {
    messageId: h.messageId, state: draftState(h),
    headers: Object.fromEntries(Object.entries(head).filter(([k]) => !args.skipped.includes(k)).sort()),
  };
`, { drafts: FOLDER.drafts, skipped: SKIPPED_HEADERS, id });

// The draft opened in Thunderbird's compose window and saved unchanged.
const nativeReopened = id => draftHeaders(`
  const win = await openNativeCompose(Ci.nsIMsgCompType.Draft, hdrById(args.drafts, args.id));
  const before = win.gMsgCompose.compFields.draftId;
  await win.SaveAsDraft();
  const uri = await waitFor(() => { const d = win.gMsgCompose.compFields.draftId; return d && d !== before ? d : null; }, "native draft");
  await closeCompose(win);
  const h = hdrOfURI(uri);
`, id);
const storedDraft = id => draftHeaders("const h = hdrById(args.drafts, args.id);", id);

const b64 = text => `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;
// A draft with the headers and flags mimedrft.cpp restores when a draft is reopened.
const reopenDraft = id => [
  `Message-ID: <${id}>`, "Date: Thu, 12 Mar 2026 11:00:00 +0000", "From: Bench <me@bench.test>",
  `To: ${b64("Зед Тест")} <zed@example.test>, "Doe, Jan" <jan@example.test>`, "Cc: yan@example.test", "Bcc: xu@example.test",
  "Reply-To: Desk <desk@example.test>", `Subject: Re: Re: ${b64("[mcp-test] черновик")}`,
  "References: <root@example.test> <mid@example.test>", "In-Reply-To: <other@example.test>", "X-Priority: 2 (High)",
  "X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=1; DSN=1; uuencode=0; attachmentreminder=1; deliveryformat=2",
  "Content-Language: de-DE", "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8; format=flowed",
  "Content-Transfer-Encoding: 8bit", "", "draft body", "",
].join("\n");
const addDrafts = raws => tbLib(`
  const identity = MailServices.accounts.defaultAccount.defaultIdentity;
  for (const raw of args.raws) folder(args.drafts).QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(raw.replace("X-Priority:", "X-Identity-Key: " + identity.key + "\\nX-Priority:"));
`, { raws, drafts: FOLDER.drafts });

const draftRawText = id => tbLib("return rawOf(hdrById(args.drafts, args.id));", { drafts: FOLDER.drafts, id });

const originalFlags = () => tbLib(
  "const h = hdrById(args.inbox, args.id); return { replied: !!(h.flags & Ci.nsMsgMessageFlags.Replied), forwarded: !!(h.flags & Ci.nsMsgMessageFlags.Forwarded) };",
  { inbox: FOLDER.inbox, id: ORIGINAL }
);

const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const COMPARED = ["origURIs", "queuedDisposition", "subject", "references", "inReplyTo", "forwardedId", "counts"];

describe("drafts", { skip: SKIP }, () => {
  beforeEach(clearDrafts);
  after(async () => {
    await clearDrafts();
    closeAll();
  });

  it("saveDraft returns the draft it stored, with the identity and send format", async () => {
    const saved = await mcp().call("saveDraft", { to: "zed@example.test", subject: "[mcp-test] drafts", body: "first", isHtml: false });
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.folderPath, FOLDER.drafts);
    const draft = await draftDetails(saved.messageId);
    assert.ok(draft, "draft stored under the returned messageId");
    assert.equal(draft.identityKey, draft.expectedIdentityKey);
    assert.match(draft.draftInfo, new RegExp(`deliveryformat=${draft.sendFormat}`));
    assert.deepEqual(await listDrafts(), [saved.messageId]);
  });

  const cases = [
    { tool: "replyToMessage", type: "Reply", args: {} },
    { tool: "replyToMessage", type: "ReplyAll", args: { replyAll: true } },
    { tool: "forwardMessage", type: "ForwardInline", args: { to: "zed@example.test" } },
    { tool: "forwardMessage", type: "ForwardInline", args: {} },
  ];
  for (const { tool, type, args } of cases) {
    it(`${tool} ${JSON.stringify(args)} stores the draft state and threading headers of the native ${type} draft`, async () => {
      const native = await nativeDraft(type, ORIGINAL);
      assert.ok(native.origURIs && native.queuedDisposition, JSON.stringify(native));

      const saved = await mcp().call(tool, { messageId: ORIGINAL, folderPath: FOLDER.inbox, mode: "draft", body: "drafts body", ...args });
      assert.equal(saved.success, true, JSON.stringify(saved));
      assert.equal(saved.folderPath, FOLDER.drafts);
      const ours = await draftDetails(saved.messageId);
      assert.deepEqual(pick(ours, COMPARED), pick(native, COMPARED));
      assert.deepEqual(await listDrafts(), [saved.messageId]);
      // The original is marked only when the draft is sent
      assert.deepEqual(await originalFlags(), { replied: false, forwarded: false });
    });
  }

  it("saveDraft with draftId rewrites the draft: one version under a new Message-ID, attachments kept unless keepAttachments is false", async () => {
    const note = { name: "note.txt", contentType: "text/plain", base64: Buffer.from("note").toString("base64") };
    const saved = await mcp().call("saveDraft", { to: "zed@example.test", subject: "[mcp-test] edit", body: "first", isHtml: false, attachments: [note] });
    assert.equal(saved.success, true, JSON.stringify(saved));

    const updated = await mcp().call("saveDraft", { draftId: saved.messageId, subject: "[mcp-test] edit v2" });
    assert.equal(updated.success, true, JSON.stringify(updated));
    assert.notEqual(updated.messageId, saved.messageId);
    assert.equal(updated.replacedDraftId, saved.messageId);
    assert.equal(updated.folderPath, FOLDER.drafts);
    assert.deepEqual(await listDrafts(), [updated.messageId]);
    let raw = await draftRawText(updated.messageId);
    assert.match(raw, /^Subject: \[mcp-test\] edit v2$/m);
    assert.match(raw, /^To: zed@example\.test$/m);
    assert.match(raw, /^first/m);
    assert.match(raw, /filename="?note\.txt/);

    const dropped = await mcp().call("saveDraft", { draftId: updated.messageId, folderPath: FOLDER.drafts, keepAttachments: false, body: "second" });
    assert.equal(dropped.success, true, JSON.stringify(dropped));
    assert.deepEqual(await listDrafts(), [dropped.messageId]);
    raw = await draftRawText(dropped.messageId);
    assert.doesNotMatch(raw, /note\.txt/);
    assert.match(raw, /^second/m);
    assert.doesNotMatch(raw, /^first/m);
    assert.match(raw, /^Content-Type: text\/plain/m, "a plain draft stays plain");

    const html = await mcp().call("saveDraft", { draftId: dropped.messageId, body: "<p><b>third</b></p>", isHtml: true });
    assert.equal(html.success, true, JSON.stringify(html));
    raw = await draftRawText(html.messageId);
    assert.match(raw, /^Content-Type: text\/html/m, "isHtml switches a replaced body");
    assert.match(raw, /<b>third<\/b>/);
  });

  it("saveDraft with draftId keeps the headers and flags Thunderbird keeps when it reopens a draft", async () => {
    await addDrafts([reopenDraft("reopen-native@bench.test"), reopenDraft("reopen-ours@bench.test")]);
    const native = await nativeReopened("reopen-native@bench.test");
    const saved = await mcp().call("saveDraft", { draftId: "reopen-ours@bench.test", folderPath: FOLDER.drafts });
    assert.equal(saved.success, true, JSON.stringify(saved));
    const ours = await storedDraft(saved.messageId);
    assert.notEqual(native.messageId, "reopen-native@bench.test", "Thunderbird gives a saved draft a new Message-ID");
    assert.equal(saved.replacedDraftId, "reopen-ours@bench.test");
    assert.equal(ours.headers["reply-to"], "Desk <desk@example.test>");
    assert.equal(ours.headers.subject, b64("Re: [mcp-test] черновик"), "subject as the database keeps it");
    assert.equal(ours.headers["in-reply-to"], "<mid@example.test>", "In-Reply-To from the last References entry");
    assert.deepEqual(ours.headers, native.headers);
  });

  it("saveDraft with draftId refuses a message outside Drafts and an unknown draft", async () => {
    const outside = await mcp().call("saveDraft", { draftId: ORIGINAL, folderPath: FOLDER.inbox, body: "x" });
    assert.match(outside.error || "", /not a Drafts folder/);
    const unknown = await mcp().call("saveDraft", { draftId: "missing@bench.test", body: "x" });
    assert.match(unknown.error || "", /Draft not found/);
  });

  for (const { tool, type, args } of [cases[0], cases[2]]) {
    it(`${tool} draft edited with draftId keeps what a reopened ${type} draft keeps`, async () => {
      const make = async () => {
        const saved = await mcp().call(tool, { messageId: ORIGINAL, folderPath: FOLDER.inbox, mode: "draft", body: "drafts body", ...args });
        assert.equal(saved.success, true, JSON.stringify(saved));
        return saved.messageId;
      };
      const [first, second] = [await make(), await make()];
      const native = await nativeReopened(first);
      const updated = await mcp().call("saveDraft", { draftId: second });
      assert.equal(updated.success, true, JSON.stringify(updated));
      const ours = await storedDraft(updated.messageId);
      assert.deepEqual(ours.state, native.state);
      assert.ok(ours.state.origURIs && ours.state.queuedDisposition, JSON.stringify(ours.state));
      assert.deepEqual(ours.headers, native.headers);

      const edited = await mcp().call("saveDraft", { draftId: updated.messageId, body: "drafts body v2" });
      assert.equal(edited.success, true, JSON.stringify(edited));
      assert.deepEqual((await storedDraft(edited.messageId)).state, native.state);
      assert.deepEqual((await listDrafts()).sort(), [native.messageId, edited.messageId].sort());
      // The original is marked only when the draft is sent
      assert.deepEqual(await originalFlags(), { replied: false, forwarded: false });
    });
  }

  it("forward subject as Thunderbird's: mail.forward_subject_prefix before the stored subject, without its Re:", async () => {
    const id = "chain3@alpha.test";
    try {
      for (const prefix of ["Fwd", "WG"]) {
        await tbLib('Services.prefs.setStringPref("mail.forward_subject_prefix", args.prefix);', { prefix });
        const native = await nativeDraft("ForwardInline", id);
        assert.equal(native.subject, `${prefix}: Project kickoff`);
        const saved = await mcp().call("forwardMessage", { messageId: id, folderPath: FOLDER.inbox, mode: "draft", body: "drafts body" });
        assert.equal(saved.success, true, JSON.stringify(saved));
        assert.equal(saved.subject, native.subject);
        assert.equal((await draftDetails(saved.messageId)).subject, native.subject);
      }
    } finally {
      await tbLib('Services.prefs.clearUserPref("mail.forward_subject_prefix");');
    }
  });

  it("mode draft is not a direct send: allowed while direct sends are blocked", async () => {
    await tbLib('Services.prefs.clearUserPref("extensions.commonpost-mcp.blockSkipReview");');
    const reply = await mcp().call("replyToMessage", { messageId: ORIGINAL, folderPath: FOLDER.inbox, mode: "draft", body: "drafts body" });
    assert.equal(reply.success, true, JSON.stringify(reply));
    const send = await mcp().call("replyToMessage", {
      messageId: ORIGINAL, folderPath: FOLDER.inbox, mode: "send", body: "drafts body", to: "zed@example.test", from: "me@bench.test",
    });
    assert.match(send.error || "", /blocks direct sending/);
  });
});
