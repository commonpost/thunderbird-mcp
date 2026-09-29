"use strict";
// Without `from`, replies and forwards use the identity Thunderbird's own Reply / Forward picks.
// A direct send (skipReview) takes the sender and the recipients from the caller only.
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
  hidden: { folder: FOLDER.inbox, raw: ["From: Xena Chi <xena@chi.test>", "To: Hidden <hidden@bench.test>", "Subject: For the hidden address", "Message-ID: <c3-hidden@chi.test>"] },
  replyTo: { folder: FOLDER.inbox, raw: ["From: Xena Chi <xena@chi.test>", "Reply-To: Mallory <mallory@evil.test>", "To: Bench Work <work@bench.test>", "Cc: Eve <eve@evil.test>", "Subject: Please reply", "Message-ID: <c3-reply-to@chi.test>"] },
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
async function saveAndSummarize(win) {
  const draft = await saveNativeDraft(win);
  await closeCompose(win);
  const out = await headersSummary(draft);
  draft.folder.deleteMessages([draft], null, true, false, null, false);
  return out;
}
`;

// What the user's Reply / Forward command saves as a draft, untouched.
const nativeDraft = (type, uri, id) => tbLib(`${HEADERS}
  return saveAndSummarize(await composeFromMessagePane(Ci.nsIMsgCompType[args.type], hdrById(args.uri, args.id)));
`, { type, uri, id });

// The compose window the tool opened for this message, saved the same way once the tool's body is in.
const toolWindowDraft = (uri, id) => tbLib(`${HEADERS}
  const target = uriOf(hdrById(args.uri, args.id));
  const win = await waitFor(() => [...Services.wm.getEnumerator("msgcompose")]
    .find(w => !w.closed && w.gMsgCompose?.originalMsgURI === target && w.GetCurrentEditor?.()?.document?.body?.textContent.includes("c3")), "tool compose window");
  await tick();
  return saveAndSummarize(win);
`, { uri, id });

// SMTP sink for direct sends: accepts every command, keeps the envelope recipients and the DATA of each message.
async function smtpSink() {
  const messages = [];
  const server = net.createServer(socket => {
    let buffer = "";
    let inData = false;
    let rcpt = [];
    socket.write("220 bench\r\n");
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push({ rcpt, data: buffer.slice(0, end + 2) });
          rcpt = [];
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write("250 OK\r\n");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        const verb = line.split(" ")[0].toUpperCase();
        buffer = buffer.slice(nl + 2);
        if (verb === "RCPT") rcpt.push(line.match(/<([^>]*)>/)?.[1] || line);
        if (verb === "DATA") { inData = true; socket.write("354 go\r\n"); }
        else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { messages, port: server.address().port, close: () => server.close() };
}

const allowDirectSend = allow => tbLib(`
  if (args.allow) Services.prefs.setBoolPref("extensions.commonpost-mcp.blockSkipReview", false);
  else Services.prefs.clearUserPref("extensions.commonpost-mcp.blockSkipReview");
`, { allow });

// The identity sends through the sink.
const useSmtp = (identityKey, port) => tbLib(`
  const service = MailServices.outgoingServer || MailServices.smtp;
  const server = service.createServer("smtp").QueryInterface(Ci.nsISmtpServer);
  server.hostname = "127.0.0.1";
  server.port = args.port;
  server.authMethod = Ci.nsMsgAuthMethod.none;
  server.socketType = Ci.nsMsgSocketType.plain;
  MailServices.accounts.getIdentity(args.identityKey).smtpServerKey = server.key;
  return server.key;
`, { identityKey, port });

const dropSmtp = (identityKey, serverKey, sentId) => tbLib(`
  if (args.sentId) {
    const copy = await waitFor(() => !folder(args.sent).locked && hdrById(args.sent, args.sentId), "sent copy");
    copy.folder.deleteMessages([copy], null, true, false, null, false);
  }
  const service = MailServices.outgoingServer || MailServices.smtp;
  MailServices.accounts.getIdentity(args.identityKey).smtpServerKey = "";
  service.deleteServer(service.getServerByKey(args.serverKey));
`, { identityKey, serverKey, sentId, sent: FOLDER.sent });

const headOf = data => {
  const head = data.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
  const get = name => head.match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1] ?? null;
  return { messageId: get("Message-ID")?.replace(/^<|>$/g, "") || null, from: get("From"), to: get("To"), cc: get("Cc"), replyTo: get("Reply-To") };
};

const TOOL = { Reply: "replyToMessage", ReplyAll: "replyToMessage", ForwardInline: "forwardMessage" };

async function compare(type, key) {
  const { folder } = MESSAGES[key];
  const native = await nativeDraft(type, folder, idOf(key));
  const opened = await mcp().call(TOOL[type], {
    messageId: idOf(key), folderPath: folder, body: "c3",
    ...(type === "ReplyAll" ? { replyAll: true } : {}), ...(type === "ForwardInline" ? { to: "zed@example.test" } : {}),
  });
  assert.equal(opened.success, true, JSON.stringify(opened));
  const ours = await toolWindowDraft(folder, idOf(key));
  if (type === "ForwardInline") {
    // The recipient is typed in by the user in the native window
    for (const field of ["to", "cc", "bcc"]) delete native[field], delete ours[field];
  }
  assert.deepEqual(ours, native);
  return ours;
}

describe("identity for replies and forwards", { skip: SKIP }, () => {
  let work;
  before(async () => {
    await addMessages();
    work = await addIdentity({ email: "work@bench.test", fullName: "Bench Work", doCc: true, doCcList: "Boss <boss@bench.test>", replyTo: "Desk <desk@bench.test>" });
  });
  after(async () => {
    await allowDirectSend(false);
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

  it("a reply to an own message uses the identity that sent it, with its auto Cc / Reply-To", async () => {
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
      await compare("ForwardInline", "catchAll");
      // With a catch-all identity configured, other replies still pick their own identity
      await compare("Reply", "delivered");
      await compare("Reply", "work");
    } finally {
      await removeIdentity(catchAll);
    }
  });

  it("a direct send needs to and from", async () => {
    await allowDirectSend(true);
    for (const send of [{ skipReview: true }, { mode: "send" }]) {
      const base = { messageId: idOf("replyTo"), folderPath: FOLDER.inbox, body: "c3", ...send };
      for (const args of [{}, { to: "xena@chi.test" }, { from: "work@bench.test" }]) {
        const reply = await mcp().call("replyToMessage", { ...base, ...args });
        assert.match(reply.error || "", /needs explicit to and from/, JSON.stringify({ ...send, ...args }));
        const forward = await mcp().call("forwardMessage", { ...base, ...args });
        assert.match(forward.error || "", /needs explicit to and from/, JSON.stringify({ ...send, ...args }));
      }
    }
  });

  it("a direct reply goes only to the given addresses and the identity's auto Cc / Reply-To", async () => {
    await allowDirectSend(true);
    const sink = await smtpSink();
    let serverKey = null;
    let sentId = null;
    try {
      serverKey = await useSmtp(work, sink.port);
      const sent = await mcp().call("replyToMessage", {
        messageId: idOf("replyTo"), folderPath: FOLDER.inbox, body: "c3", replyAll: true, skipReview: true,
        to: "Xena Chi <xena@chi.test>", from: "work@bench.test",
      });
      assert.equal(sent.success, true, JSON.stringify(sent));
      assert.equal(sink.messages.length, 1, JSON.stringify(sent));
      const [{ rcpt, data }] = sink.messages;
      const head = headOf(data);
      sentId = head.messageId;
      assert.deepEqual(rcpt.sort(), ["boss@bench.test", "xena@chi.test"]);
      const expected = { from: "Bench Work <work@bench.test>", to: "Xena Chi <xena@chi.test>", cc: "Boss <boss@bench.test>", replyTo: "Desk <desk@bench.test>" };
      assert.deepEqual({ from: head.from, to: head.to, cc: head.cc, replyTo: head.replyTo }, expected);
      // The result names the addresses used
      assert.deepEqual({ from: sent.from, to: sent.to, cc: sent.cc, replyTo: sent.replyTo, bcc: sent.bcc }, { ...expected, bcc: undefined });
    } finally {
      if (serverKey) await dropSmtp(work, serverKey, sentId);
      sink.close();
    }
  });

  it("a direct forward goes only to the given addresses and the identity's auto Cc / Reply-To", async () => {
    await allowDirectSend(true);
    const sink = await smtpSink();
    let serverKey = null;
    let sentId = null;
    try {
      serverKey = await useSmtp(work, sink.port);
      // The original names Xena (From), Reply-To Mallory, To work@bench.test and Cc Eve: none of them may receive the forward
      const sent = await mcp().call("forwardMessage", {
        messageId: idOf("replyTo"), folderPath: FOLDER.inbox, body: "c3", skipReview: true,
        to: "Zed <zed@example.test>", from: "work@bench.test",
      });
      assert.equal(sent.success, true, JSON.stringify(sent));
      assert.equal(sink.messages.length, 1, JSON.stringify(sent));
      const [{ rcpt, data }] = sink.messages;
      const head = headOf(data);
      sentId = head.messageId;
      // Envelope: the caller's To and the identity's auto Cc, nothing from the original message
      assert.deepEqual(rcpt.sort(), ["boss@bench.test", "zed@example.test"]);
      // Headers
      const expected = { from: "Bench Work <work@bench.test>", to: "Zed <zed@example.test>", cc: "Boss <boss@bench.test>", replyTo: "Desk <desk@bench.test>" };
      assert.deepEqual({ from: head.from, to: head.to, cc: head.cc, replyTo: head.replyTo }, expected);
      assert.doesNotMatch(data.split("\r\n\r\n")[0], /xena@chi\.test|mallory@evil\.test|eve@evil\.test/i);
      // The result names the addresses used
      assert.deepEqual({ from: sent.from, to: sent.to, cc: sent.cc, replyTo: sent.replyTo, bcc: sent.bcc }, { ...expected, bcc: undefined });
    } finally {
      if (serverKey) await dropSmtp(work, serverKey, sentId);
      sink.close();
    }
  });
});

// Account restriction: the accessible accounts alone decide which identity a reply or forward can use.
const accountKeys = () => tbLib(`
  return {
    main: MailServices.accounts.defaultAccount.key,
    mainIdentity: MailServices.accounts.defaultAccount.defaultIdentity.key,
    local: MailServices.accounts.findAccountForServer(MailServices.accounts.localFoldersServer).key,
  };
`);

const addIdentityTo = (accountKey, values) => tbLib(`
  const identity = MailServices.accounts.createIdentity();
  Object.assign(identity, args.values, { valid: true });
  identity.setCharAttribute("draft_folder", args.drafts);
  identity.setCharAttribute("fcc_folder", args.sent);
  MailServices.accounts.getAccount(args.accountKey).addIdentity(identity);
  return identity.key;
`, { accountKey, values, drafts: FOLDER.drafts, sent: FOLDER.sent });

const removeIdentityFrom = (accountKey, key) => tbLib(`
  const identity = MailServices.accounts.getIdentity(args.key);
  MailServices.accounts.getAccount(args.accountKey).removeIdentity(identity);
  identity.clearAllValues();
`, { accountKey, key });

const restrictTo = accountKeys => tbLib(`
  if (args.keys) Services.prefs.setStringPref("extensions.commonpost-mcp.allowedAccounts", JSON.stringify(args.keys));
  else Services.prefs.clearUserPref("extensions.commonpost-mcp.allowedAccounts");
`, { keys: accountKeys });

// A message in a Local Folders folder of its own.
const LOCAL_ID = "c3-local@chi.test";
const addLocalMessage = () => tbLib(`
  const f = MailServices.accounts.localFoldersServer.rootFolder.createLocalSubfolder("BenchRestricted");
  const raw = ["From: Xena Chi <xena@chi.test>", "To: Bench Work <work@bench.test>", "Subject: In Local Folders", "Message-ID: <" + args.id + ">",
    "Date: Thu, 12 Mar 2026 10:00:00 +0000", "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", "c3 body", ""].join("\n");
  f.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(raw);
  return f.URI;
`, { id: LOCAL_ID });

const removeLocalFolder = () => tbLib(`
  const root = MailServices.accounts.localFoldersServer.rootFolder;
  const f = root.getChildNamed("BenchRestricted");
  if (f) root.propagateDelete(f, true);
`);

describe("identity with account restrictions", { skip: SKIP }, () => {
  let keys;
  let hidden;
  let localUri;
  before(async () => {
    await addMessages();
    keys = await accountKeys();
    // Only the Local Folders account holds this identity
    hidden = await addIdentityTo(keys.local, { email: "hidden@bench.test", fullName: "Hidden" });
  });
  after(async () => {
    await restrictTo(null);
    await allowDirectSend(false);
    await removeMessages();
    await removeLocalFolder();
    if (hidden) await removeIdentityFrom(keys.local, hidden);
    closeAll();
  });

  it("an identity of a restricted account is not picked: the accessible account's identity is used", async () => {
    // Control: unrestricted, Thunderbird's own pick and the tool's pick are the hidden identity
    const free = await compare("Reply", "hidden");
    assert.equal(free.identityKey, hidden);
    await restrictTo([keys.main]);
    const opened = await mcp().call("replyToMessage", { messageId: idOf("hidden"), folderPath: FOLDER.inbox, body: "c3" });
    assert.equal(opened.success, true, JSON.stringify(opened));
    const ours = await toolWindowDraft(FOLDER.inbox, idOf("hidden"));
    assert.equal(ours.identityKey, keys.mainIdentity);
    assert.notEqual(ours.identityKey, hidden);
    assert.ok(!ours.from.some(a => /hidden@bench\.test/.test(a)), JSON.stringify(ours.from));
    // The forward falls back the same way
    const forwarded = await mcp().call("forwardMessage", { messageId: idOf("hidden"), folderPath: FOLDER.inbox, body: "c3", to: "zed@example.test" });
    assert.equal(forwarded.success, true, JSON.stringify(forwarded));
    assert.equal((await toolWindowDraft(FOLDER.inbox, idOf("hidden"))).identityKey, keys.mainIdentity);
  });

  it("naming the identity of a restricted account in from is refused", async () => {
    await restrictTo([keys.main]);
    const reply = await mcp().call("replyToMessage", { messageId: idOf("hidden"), folderPath: FOLDER.inbox, body: "c3", from: "hidden@bench.test" });
    assert.ok(reply.error && !reply.success, JSON.stringify(reply));
  });

  it("returns an error when no accessible account holds an identity", async () => {
    // The message sits in Local Folders, the only accessible account, which has no identity
    localUri = await addLocalMessage();
    await restrictTo([keys.local]);
    for (const tool of [["replyToMessage", {}], ["forwardMessage", { to: "zed@example.test" }]]) {
      const result = await mcp().call(tool[0], { messageId: LOCAL_ID, folderPath: localUri, body: "c3", ...tool[1] });
      assert.match(result.error || "", /No accessible identity found -- all accounts are restricted/, tool[0]);
      assert.ok(!result.success, tool[0]);
    }
  });
});
