"use strict";
// C1: drafts are saved through nsIMsgCompose, like Thunderbird's compose window; an update keeps what a reopened draft keeps.
const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, mcp, tbLib, closeAll, FOLDER } = require("./helpers.cjs");

const ORIGINAL = "chain1@alpha.test";

const clearDrafts = () => tbLib("clearFolder(args.drafts);", { drafts: FOLDER.drafts });

const listDrafts = () => tbLib(
  "return hdrs(args.drafts).map(h => ({ id: h.messageId, subject: h.mime2DecodedSubject, ...draftState(h) }));",
  { drafts: FOLDER.drafts }
);

const draftDetails = id => tbLib(`
  const h = hdrById(args.drafts, args.id);
  if (!h) return null;
  const head = headersOf(await rawOf(h));
  const identity = MailServices.accounts.defaultAccount.defaultIdentity;
  return {
    ...draftState(h),
    identityKey: head["x-identity-key"], expectedIdentityKey: identity.key,
    draftInfo: head["x-mozilla-draft-info"] || "",
    sendFormat: Services.prefs.getIntPref("mail.default_send_format", 0),
    references: head.references || "", inReplyTo: head["in-reply-to"] || "",
  };
`, { drafts: FOLDER.drafts, id });

// Draft state Thunderbird itself stores for a reply / forward draft of an Inbox message.
const nativeDraftState = (type, messageId) => tbLib(`
  const win = await openNativeCompose(Ci.nsIMsgCompType[args.type], hdrById(args.inbox, args.messageId));
  const draft = await saveNativeDraft(win);
  const state = draftState(draft);
  await closeCompose(win);
  draft.folder.deleteMessages([draft], null, true, false, null, false);
  return state;
`, { type, messageId, inbox: FOLDER.inbox });

// Two copies of a draft with the headers and flags mimedrft.cpp restores when a draft is reopened.
const addReopenDrafts = ids => tbLib(`
  const identity = MailServices.accounts.defaultAccount.defaultIdentity;
  for (const id of args.ids) {
    const raw = ["Message-ID: <" + id + ">", "Date: Thu, 12 Mar 2026 11:00:00 +0000", "From: Bench <" + identity.email + ">",
      "To: Zed <zed@example.test>", "Cc: yan@example.test", "Bcc: xu@example.test", "Reply-To: Desk <desk@example.test>",
      "Subject: [mcp-test] reopen", "References: <root@example.test>", "In-Reply-To: <root@example.test>", "X-Priority: 2 (High)",
      "X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=1; DSN=1; uuencode=0; attachmentreminder=1; deliveryformat=2",
      "X-Identity-Key: " + identity.key, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8; format=flowed",
      "Content-Transfer-Encoding: 7bit", "", "draft body", ""].join("\\n");
    folder(args.drafts).QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(raw);
  }
`, { ids, drafts: FOLDER.drafts });

const SKIPPED_HEADERS = new Set(["message-id", "date", "x-mozilla-status", "x-mozilla-status2"]);
const draftHeaders = source => tbLib(`${source}
  const head = headersOf(await rawOf(h));
  return Object.fromEntries(Object.entries(head).filter(([k]) => !args.skipped.includes(k)).sort());
`, { drafts: FOLDER.drafts, skipped: [...SKIPPED_HEADERS] });

// The draft opened in Thunderbird's compose window and saved unchanged.
const nativeReopened = id => draftHeaders(`
  const win = await openNativeCompose(Ci.nsIMsgCompType.Draft, hdrById(args.drafts, "${id}"));
  const before = win.gMsgCompose.compFields.draftId;
  await win.SaveAsDraft();
  const uri = await waitFor(() => { const d = win.gMsgCompose.compFields.draftId; return d && d !== before ? d : null; }, "native draft");
  await closeCompose(win);
  const h = hdrOfURI(uri);
`);

const originalFlags = () => tbLib(
  "const h = hdrById(args.inbox, args.id); return { replied: !!(h.flags & Ci.nsMsgMessageFlags.Replied), forwarded: !!(h.flags & Ci.nsMsgMessageFlags.Forwarded) };",
  { inbox: FOLDER.inbox, id: ORIGINAL }
);

describe("drafts (C1)", { skip: SKIP }, () => {
  beforeEach(clearDrafts);
  after(async () => {
    await clearDrafts();
    closeAll();
  });

  it("saveDraft with draftId replaces the draft: exactly one remains", async () => {
    const saved = await mcp().call("saveDraft", { to: "zed@example.test", subject: "[mcp-test] c1", body: "first", isHtml: false });
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.folderPath, FOLDER.drafts);
    const first = await draftDetails(saved.messageId);
    assert.ok(first, "draft stored under the returned messageId");
    assert.equal(first.identityKey, first.expectedIdentityKey);
    assert.match(first.draftInfo, new RegExp(`deliveryformat=${first.sendFormat}`));

    const updated = await mcp().call("saveDraft", { draftId: saved.messageId, subject: "[mcp-test] c1 v2" });
    assert.equal(updated.success, true, JSON.stringify(updated));
    assert.equal(updated.replacedDraftId, saved.messageId);
    assert.notEqual(updated.messageId, saved.messageId);
    const drafts = await listDrafts();
    assert.deepEqual(drafts.map(d => d.id), [updated.messageId]);
    assert.equal(drafts[0].subject, "[mcp-test] c1 v2");
  });

  it("saveDraft with draftId keeps From, Reply-To, priority and draft flags like a reopened draft", async () => {
    await addReopenDrafts(["reopen-native@bench.test", "reopen-ours@bench.test"]);
    const native = await nativeReopened("reopen-native@bench.test");
    const saved = await mcp().call("saveDraft", { draftId: "reopen-ours@bench.test", folderPath: FOLDER.drafts });
    assert.equal(saved.success, true, JSON.stringify(saved));
    const ours = await draftHeaders(`const h = hdrById(args.drafts, "${saved.messageId}");`);
    assert.equal(ours["reply-to"], "Desk <desk@example.test>");
    assert.deepEqual(ours, native);
  });

  const cases = [
    { tool: "replyToMessage", type: "Reply", args: {} },
    { tool: "forwardMessage", type: "ForwardInline", args: { to: "zed@example.test" } },
  ];
  for (const { tool, type, args } of cases) {
    it(`${tool} draft stores the native ${type} draft state and keeps it on update`, async () => {
      const native = await nativeDraftState(type, ORIGINAL);
      assert.ok(native.origURIs && native.queuedDisposition, JSON.stringify(native));

      const saved = await mcp().call(tool, { messageId: ORIGINAL, folderPath: FOLDER.inbox, mode: "draft", body: "c1 body", ...args });
      assert.equal(saved.success, true, JSON.stringify(saved));
      const ours = await draftDetails(saved.messageId);
      assert.deepEqual({ origURIs: ours.origURIs, queuedDisposition: ours.queuedDisposition }, native);
      assert.match(ours.references, new RegExp(`<${ORIGINAL}>`));
      if (type === "Reply") assert.equal(ours.inReplyTo, `<${ORIGINAL}>`);

      const updated = await mcp().call("saveDraft", { draftId: saved.messageId, body: "c1 body v2" });
      assert.equal(updated.success, true, JSON.stringify(updated));
      const drafts = await listDrafts();
      assert.deepEqual(drafts.map(d => d.id), [updated.messageId]);
      assert.deepEqual({ origURIs: drafts[0].origURIs, queuedDisposition: drafts[0].queuedDisposition }, native);
      // The original is marked only when the draft is sent
      assert.deepEqual(await originalFlags(), { replied: false, forwarded: false });
    });
  }
});
