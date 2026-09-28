"use strict";
// C2: replyToMessage recipients and threading headers match Thunderbird's own reply window for every fixture.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, mcp, tbLib, closeAll, FOLDER } = require("./helpers.cjs");

const clearDrafts = () => tbLib("clearFolder(args.drafts);", { drafts: FOLDER.drafts });

const messageIds = folder => tbLib("return hdrs(args.folder).map(h => h.messageId).sort();", { folder });

// Address and threading headers as stored in a draft.
const RECIPIENTS_OF = String.raw`
async function recipientsOf(h) {
  const head = headersOf(await rawOf(h));
  const list = v => MailServices.headerParser.parseEncodedHeader(v || "", "UTF-8").map(a => a.toString());
  const ids = v => (v || "").split(/\s+/).filter(Boolean);
  return { to: list(head.to), cc: list(head.cc), bcc: list(head.bcc), replyTo: list(head["reply-to"]), from: list(head.from),
    references: ids(head.references), inReplyTo: ids(head["in-reply-to"]) };
}
`;

// Threading edge cases, added for this test only: no Message-ID (the database gets an "md5:" id), In-Reply-To only.
const EXTRA = [
  ["From: Nia Nu <nia@nu.test>", "To: Bench User <me@bench.test>", "Subject: Without message id"],
  ["From: Nia Nu <nia@nu.test>", "To: Bench User <me@bench.test>", "Subject: Re: Parent elsewhere", "Message-ID: <c2-irt@nu.test>", "In-Reply-To: <c2-parent@nu.test>"],
];

const addExtra = () => tbLib(`
  for (const head of args.extra) {
    const raw = [...head, "Date: Thu, 12 Mar 2026 11:00:00 +0000", "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", "c2 body", ""].join("\\n");
    folder(args.inbox).QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(raw);
  }
`, { extra: EXTRA, inbox: FOLDER.inbox });

const removeExtra = () => tbLib(`
  const list = hdrs(args.inbox).filter(h => h.author.includes("nia@nu.test"));
  if (list.length) folder(args.inbox).deleteMessages(list, null, true, false, null, false);
`, { inbox: FOLDER.inbox });

// What Thunderbird's own reply window saves as a draft, untouched.
const nativeRecipients = (type, folder, id) => tbLib(`${RECIPIENTS_OF}
  const win = await openNativeCompose(Ci.nsIMsgCompType[args.type], hdrById(args.folder, args.id));
  const draft = await saveNativeDraft(win);
  await closeCompose(win);
  const out = await recipientsOf(draft);
  draft.folder.deleteMessages([draft], null, true, false, null, false);
  return out;
`, { type, folder, id });

const draftRecipients = id => tbLib(`${RECIPIENTS_OF}
  const h = hdrById(args.drafts, args.id);
  return h ? recipientsOf(h) : null;
`, { drafts: FOLDER.drafts, id });

// Auto Cc (with the own address), auto Bcc and Reply-To on the identity; returns the previous values.
const setIdentityAuto = values => tbLib(`
  const identity = MailServices.accounts.defaultAccount.defaultIdentity;
  const keys = ["doCc", "doCcList", "doBcc", "doBccList", "replyTo"];
  const previous = Object.fromEntries(keys.map(k => [k, identity[k]]));
  for (const k of keys) identity[k] = args.values[k];
  return previous;
`, { values });

async function compare(type, folder, id) {
  const native = await nativeRecipients(type, folder, id);
  const saved = await mcp().call("replyToMessage", {
    messageId: id, folderPath: folder, mode: "draft", replyAll: type === "ReplyAll", body: "c2",
  });
  assert.equal(saved.success, true, JSON.stringify(saved));
  const ours = await draftRecipients(saved.messageId);
  await clearDrafts();
  assert.deepEqual(ours, native);
}

describe("reply recipients (C2)", { skip: SKIP }, () => {
  let fixtures = [];
  before(async () => {
    await clearDrafts();
    await addExtra();
    fixtures = [
      ...(await messageIds(FOLDER.inbox)).map(id => [FOLDER.inbox, id]),
      ...(await messageIds(FOLDER.sent)).map(id => [FOLDER.sent, id]),
    ];
  });
  after(async () => {
    await clearDrafts();
    await removeExtra();
    closeAll();
  });

  for (const type of ["Reply", "ReplyAll"]) {
    it(`${type}: every Inbox and Sent fixture`, async t => {
      assert.ok(fixtures.length >= 20, `fixtures: ${fixtures.length}`);
      for (const [folder, id] of fixtures) {
        await t.test(id, () => compare(type, folder, id));
      }
    });
  }

  it("identity auto Cc / Bcc / Reply-To", async t => {
    const previous = await setIdentityAuto({
      doCc: true, doCcList: "Boss <boss@bench.test>, Bob Alpha <bob@alpha.test>, me@bench.test",
      doBcc: true, doBccList: "archive@bench.test, Jane Theta <jane@theta.test>",
      replyTo: "Desk <desk@bench.test>",
    });
    try {
      const subset = ["chain3@alpha.test", "reply-to@theta.test", "list@kappa.test", "followup@iota.test",
        "own-generated@bench.test", "own-sent@bench.test", "own-bcc@bench.test", "group@omega.test"];
      for (const [folder, id] of fixtures.filter(([, id]) => subset.includes(id))) {
        for (const type of ["Reply", "ReplyAll"]) await t.test(`${type} ${id}`, () => compare(type, folder, id));
      }
    } finally {
      await setIdentityAuto(previous);
    }
  });
});
