"use strict";
// C3: without `from`, replies and forwards use the identity Thunderbird's own Reply / Forward picks.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { SKIP, mcp, tbLib, closeAll, FOLDER } = require("./helpers.cjs");

// Synthetic messages added for this test only (removed afterwards); LF like the fixture mbox, mixed EOL breaks its reader.
const MESSAGES = {
  work: { folder: FOLDER.inbox, raw: ["From: Xena Chi <xena@chi.test>", "To: Bench Work <work@bench.test>", "Subject: For the work address", "Message-ID: <c3-work@chi.test>"] },
  delivered: { folder: FOLDER.inbox, raw: ["Delivered-To: work@bench.test", "From: Yuri Chi <yuri@chi.test>", "To: All <all@chi.test>", "Subject: Via an alias", "Message-ID: <c3-delivered@chi.test>"] },
  catchAll: { folder: FOLDER.inbox, raw: ["From: Zed Chi <zed@chi.test>", "To: Shop <shop@catch.test>", "Subject: Catch-all order", "Message-ID: <c3-catch@chi.test>"] },
  self: { folder: FOLDER.sent, raw: ["From: Bench Work <work@bench.test>", "To: Olga Chi <olga@chi.test>", "Subject: Sent from work", "Message-ID: <c3-self@bench.test>"] },
};
const idOf = key => MESSAGES[key].raw.find(l => l.startsWith("Message-ID:")).match(/<(.+)>/)[1];

const addMessages = () => tbLib(`
  for (const m of args.messages) {
    const raw = [...m.raw, "Date: Thu, 12 Mar 2026 10:00:00 +0000", "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", "c3 body", ""].join("\\n");
    folder(m.folder).QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(raw);
  }
`, { messages: Object.values(MESSAGES) });

const removeMessages = () => tbLib(`
  for (const [uri, id] of args.ids) {
    const h = hdrById(uri, id);
    if (h) h.folder.deleteMessages([h], null, true, false, null, false);
  }
`, { ids: Object.keys(MESSAGES).map(k => [MESSAGES[k].folder, idOf(k)]) });

// Extra identities on the default account: work (own auto Cc / Reply-To) and, optionally, a catch-all one.
const addIdentity = values => tbLib(`
  const identity = MailServices.accounts.createIdentity();
  Object.assign(identity, args.values, { valid: true });
  identity.setCharAttribute("draft_folder", args.drafts);
  identity.setCharAttribute("fcc_folder", args.sent);
  MailServices.accounts.defaultAccount.addIdentity(identity);
  return identity.key;
`, { values, drafts: FOLDER.drafts, sent: FOLDER.sent });

const removeIdentity = key => tbLib(`
  const identity = MailServices.accounts.getIdentity(args.key);
  MailServices.accounts.defaultAccount.removeIdentity(identity);
  identity.clearAllValues();
`, { key });

const HEADERS = String.raw`
async function headersSummary(h) {
  const head = headersOf(await rawOf(h));
  const list = v => MailServices.headerParser.parseEncodedHeader(v || "", "UTF-8").map(a => a.toString());
  return { identityKey: head["x-identity-key"], from: list(head.from), to: list(head.to), cc: list(head.cc), bcc: list(head.bcc), replyTo: list(head["reply-to"]) };
}
`;

const nativeDraft = (type, uri, id) => tbLib(`${HEADERS}
  const win = await composeFromMessagePane(Ci.nsIMsgCompType[args.type], hdrById(args.uri, args.id));
  const draft = await saveNativeDraft(win);
  await closeCompose(win);
  const out = await headersSummary(draft);
  draft.folder.deleteMessages([draft], null, true, false, null, false);
  return out;
`, { type, uri, id });

const ourDraft = id => tbLib(`${HEADERS}
  const h = hdrById(args.drafts, args.id);
  return h ? headersSummary(h) : null;
`, { drafts: FOLDER.drafts, id });

// SMTP sink for mode "send": accepts every command, keeps the DATA of each message.
async function smtpSink() {
  const messages = [];
  const server = net.createServer(socket => {
    let buffer = "";
    let inData = false;
    socket.write("220 bench\r\n");
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buffer.slice(0, end + 2));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write("250 OK\r\n");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const verb = buffer.slice(0, nl).split(" ")[0].toUpperCase();
        buffer = buffer.slice(nl + 2);
        if (verb === "DATA") { inData = true; socket.write("354 go\r\n"); }
        else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { messages, port: server.address().port, close: () => server.close() };
}

// The identity sends through the sink; the skip-review block is lifted for the test.
const useSmtp = (identityKey, port) => tbLib(`
  const service = MailServices.outgoingServer || MailServices.smtp;
  const server = service.createServer("smtp").QueryInterface(Ci.nsISmtpServer);
  server.hostname = "127.0.0.1";
  server.port = args.port;
  server.authMethod = Ci.nsMsgAuthMethod.none;
  server.socketType = Ci.nsMsgSocketType.plain;
  MailServices.accounts.getIdentity(args.identityKey).smtpServerKey = server.key;
  Services.prefs.setBoolPref("extensions.commonpost-mcp.blockSkipReview", false);
  return server.key;
`, { identityKey, port });

const dropSmtp = (identityKey, serverKey, sentId) => tbLib(`
  Services.prefs.clearUserPref("extensions.commonpost-mcp.blockSkipReview");
  if (args.sentId) {
    const copy = await waitFor(() => !folder(args.sent).locked && hdrById(args.sent, args.sentId), "sent copy");
    copy.folder.deleteMessages([copy], null, true, false, null, false);
  }
  const service = MailServices.outgoingServer || MailServices.smtp;
  MailServices.accounts.getIdentity(args.identityKey).smtpServerKey = "";
  service.deleteServer(service.getServerByKey(args.serverKey));
`, { identityKey, serverKey, sentId, sent: FOLDER.sent });

const clearDrafts = () => tbLib("clearFolder(args.drafts);", { drafts: FOLDER.drafts });

const TOOL = { Reply: "replyToMessage", ReplyAll: "replyToMessage", ForwardInline: "forwardMessage" };

async function compare(type, key) {
  const { folder } = MESSAGES[key];
  const native = await nativeDraft(type, folder, idOf(key));
  const saved = await mcp().call(TOOL[type], {
    messageId: idOf(key), folderPath: folder, mode: "draft", body: "c3",
    ...(type === "ReplyAll" ? { replyAll: true } : {}), ...(type === "ForwardInline" ? { to: "zed@example.test" } : {}),
  });
  assert.equal(saved.success, true, JSON.stringify(saved));
  const ours = await ourDraft(saved.messageId);
  await clearDrafts();
  if (type === "ForwardInline") {
    // The recipient is typed in by the user in the native window
    for (const field of ["to", "cc", "bcc"]) delete native[field], delete ours[field];
  }
  assert.deepEqual(ours, native);
  return ours;
}

describe("identity for replies and forwards (C3)", { skip: SKIP }, () => {
  let work;
  before(async () => {
    await clearDrafts();
    await addMessages();
    work = await addIdentity({ email: "work@bench.test", fullName: "Bench Work", doCc: true, doCcList: "Boss <boss@bench.test>", replyTo: "Desk <desk@bench.test>" });
  });
  after(async () => {
    await clearDrafts();
    await removeMessages();
    if (work) await removeIdentity(work);
    closeAll();
  });

  it("picks the identity the message was addressed to", async () => {
    for (const type of ["Reply", "ReplyAll", "ForwardInline"]) {
      const ours = await compare(type, "work");
      assert.equal(ours.identityKey, work, type);
    }
  });

  it("uses Delivered-To when no identity is in To / Cc", async () => {
    const ours = await compare("Reply", "delivered");
    assert.equal(ours.identityKey, work);
  });

  it("a reply to an own message switches to the identity that sent it, with its auto Cc / Reply-To", async () => {
    for (const type of ["Reply", "ReplyAll"]) {
      const ours = await compare(type, "self");
      assert.equal(ours.identityKey, work, type);
      assert.deepEqual(ours.replyTo, ["Desk <desk@bench.test>"], type);
    }
  });

  it("a catch-all identity replies from the address the message was sent to", async () => {
    const catchAll = await addIdentity({ email: "info@catch.test", fullName: "Catch Info", catchAll: true, catchAllHint: "*@catch.test" });
    try {
      const ours = await compare("Reply", "catchAll");
      assert.equal(ours.identityKey, catchAll);
      assert.deepEqual(ours.from, ["Shop <shop@catch.test>"]);
      // With a catch-all identity configured, other replies still pick their own identity
      await compare("Reply", "delivered");
      await compare("Reply", "work");
    } finally {
      await removeIdentity(catchAll);
    }
  });

  it("a catch-all reply sent directly goes out from that address too", async () => {
    const catchAll = await addIdentity({ email: "info@catch.test", fullName: "Catch Info", catchAll: true, catchAllHint: "*@catch.test" });
    const sink = await smtpSink();
    let serverKey = null;
    let sentId = null;
    try {
      serverKey = await useSmtp(catchAll, sink.port);
      const sent = await mcp().call("replyToMessage", { messageId: idOf("catchAll"), folderPath: FOLDER.inbox, mode: "send", body: "c3" });
      assert.equal(sent.success, true, JSON.stringify(sent));
      assert.equal(sink.messages.length, 1, JSON.stringify(sent));
      const head = sink.messages[0].split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
      sentId = head.match(/^Message-ID:\s*<([^>]+)>/im)?.[1] || null;
      assert.equal(head.match(/^From:\s*(.*)$/im)?.[1], "Shop <shop@catch.test>");
    } finally {
      if (serverKey) await dropSmtp(catchAll, serverKey, sentId);
      sink.close();
      await removeIdentity(catchAll);
    }
  });
});
