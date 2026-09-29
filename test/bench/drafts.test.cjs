"use strict";
// Drafts are saved through nsIMsgCompose, like Thunderbird's compose window: identity, format, reply / forward state.
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

const originalFlags = () => tbLib(
  "const h = hdrById(args.inbox, args.id); return { replied: !!(h.flags & Ci.nsMsgMessageFlags.Replied), forwarded: !!(h.flags & Ci.nsMsgMessageFlags.Forwarded) };",
  { inbox: FOLDER.inbox, id: ORIGINAL }
);

const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const COMPARED = ["origURIs", "queuedDisposition", "references", "inReplyTo", "forwardedId", "counts"];

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
