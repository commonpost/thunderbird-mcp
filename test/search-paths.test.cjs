// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Runs the real search paths of searchMessages / getRecentMessages (SEARCH MESSAGES, RECENT MESSAGES and
// MESSAGE SEARCH HELPERS of api.js) against fake accounts, folders and headers: encrypted messages stay
// withheld in every new output of #17, and the account restriction covers every new path.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function region(name) {
  const start = apiSource.indexOf(`// BEGIN ${name}`);
  const end = apiSource.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} markers missing`);
  return apiSource.slice(start, end);
}

const FLAGS = { Trash: 0x100, Junk: 0x40000000, Drafts: 0x400, Templates: 0x400000, Queue: 0x800, Inbox: 0x1000 };
const HAS_RE = 0x10;
const ATTACHMENT = 0x10000000;
const DAY = 86400000;

function folder(uri, flags = 0) {
  const f = {
    URI: uri, flags, hdrs: [], hasSubFolders: false, subFolders: [], localizedName: uri.split("/").pop(),
    isSpecialFolder: (mask) => (f.flags & mask) !== 0,
    server: { type: "none" }, offlineKeys: null, reads: [],
    hasMsgOffline: key => !f.offlineKeys || f.offlineKeys.includes(key),
    getMsgInputStream: (h) => { f.reads.push(h.messageId); return { raw: h._raw, close() {} }; },
  };
  f.msgDatabase = {
    enumerateMessages: () => f.hdrs.values(),
    getMsgHdrForKey: (key) => f.hdrs.find(h => h.messageKey === key),
  };
  return f;
}

let nextKey = 1;
function hdr(target, { id, subject, author, to = "me@lab.test", cc = "", refs = [], daysAgo = 1, re = false, preview = "",
  encrypted = false, wireSubject, raw }) {
  const h = {
    messageId: id, messageKey: nextKey++, subject, mime2DecodedSubject: subject, author, mime2DecodedAuthor: author,
    recipients: to, mime2DecodedRecipients: to, ccList: cc, bccList: "", date: (Date.now() - daysAgo * DAY) * 1000,
    flags: (re ? HAS_RE : 0) | (raw ? ATTACHMENT : 0), isRead: false, isFlagged: false, threadId: 1, numReferences: refs.length,
    getStringReference: (i) => `<${refs[i]}>`,
    getStringProperty: (name) => (name === "preview" ? preview : ""),
    folder: target, _encrypted: encrypted, _wireSubject: wireSubject, _raw: raw, messageSize: raw ? raw.length : 0,
  };
  target.hdrs.push(h);
  return h;
}

// Two accounts; "restricted" is left out when the restriction is on.
function world({ restricted = true, encryptedAllowed = false } = {}) {
  const inbox = folder("mailbox://me@lab.test/Inbox", FLAGS.Inbox);
  const sent = folder("mailbox://me@lab.test/Sent");
  const trash = folder("mailbox://me@lab.test/Trash", FLAGS.Trash);
  const root = folder("mailbox://me@lab.test");
  root.hasSubFolders = true;
  root.subFolders = [inbox, sent, trash];
  const otherInbox = folder("mailbox://other@lab.test/Inbox", FLAGS.Inbox);
  const otherRoot = folder("mailbox://other@lab.test");
  otherRoot.hasSubFolders = true;
  otherRoot.subFolders = [otherInbox];
  const accounts = [
    { key: "account1", incomingServer: { rootFolder: root }, folders: [root, inbox, sent, trash] },
    { key: "account2", incomingServer: { rootFolder: otherRoot }, folders: [otherRoot, otherInbox] },
  ];
  const allowed = key => !restricted || key === "account1";
  const accountOf = f => accounts.find(a => a.folders.includes(f));
  const byUri = uri => accounts.flatMap(a => a.folders).find(f => f.URI === uri);
  const sandbox = {
    Ci: { nsMsgFolderFlags: FLAGS, nsMsgMessageFlags: { HasRe: HAS_RE, Attachment: ATTACHMENT } },
    Uint8Array, TextDecoder, atob,
    Services: { tm: { dispatchToMainThread: fn => setImmediate(fn) } },
    readMessageStreamFully: (stream) => stream.raw,
    GlodaMsgSearcher: null,
    normalizeMessageIdForDedup: v => String(v || "").trim().replace(/^<|>$/g, ""),
    dedupeSearchMessageResults: rows => rows,
    getUserTags: () => [],
    decodeHeaderValue: v => v || "",
    resolveTagKey: t => t,
    refreshImapFolderSync() {},
    folderDisplayName: f => f?.localizedName ?? f?.prettyName,
    isEncryptedContentAllowed: () => encryptedAllowed,
    isRawMimeEnvelopeEncrypted: h => h._encrypted === true,
    outerWireSubject: (h, fallback) => h._wireSubject ?? fallback,
    getOwnEmails: () => new Set(["me@lab.test"]),
    isFolderAccessible: f => !!accountOf(f) && allowed(accountOf(f).key),
    getAccessibleFolder(uri) {
      const f = byUri(uri);
      if (!f) return { error: `Folder not found: ${uri}` };
      if (!allowed(accountOf(f).key)) return { error: `Account not accessible for folder: ${uri}` };
      return { folder: f };
    },
    getAccessibleAccounts: () => accounts.filter(a => allowed(a.key)),
  };
  sandbox.findMessage = (messageId, folderPath) => {
    const r = sandbox.getAccessibleFolder(folderPath);
    if (r.error) return r;
    const msgHdr = r.folder.hdrs.find(h => h.messageId === messageId);
    return msgHdr ? { msgHdr, folder: r.folder } : { error: `Message not found: ${messageId}` };
  };
  vm.createContext(sandbox);
  vm.runInContext(`${region("MESSAGE SEARCH HELPERS")}
${region("ENCRYPTED MESSAGE HELPERS")}
${region("RAW MIME PARSING HELPERS")}
${region("ATTACHMENT SEARCH HELPERS")}
${region("SEARCH MESSAGES")}
${region("RECENT MESSAGES")}
this.searchMessages = searchMessages;
this.getRecentMessages = getRecentMessages;`, sandbox);
  return { sandbox, inbox, sent, trash, otherInbox, otherRoot };
}

const plain = v => JSON.parse(JSON.stringify(v));
const ids = res => plain(res).messages.map(m => m.id).sort();

describe("encrypted messages in the #17 search outputs", () => {
  function seed() {
    const w = world();
    hdr(w.inbox, { id: "plain@lab.test", subject: "Quarterly merger plan", author: "Ann <ann@acme.test>", preview: "plain preview", daysAgo: 3 });
    // Its stored subject and preview are what OpenPGP wrote back after decrypting it once.
    hdr(w.inbox, { id: "secret@lab.test", subject: "Quarterly merger plan", author: "Bob <bob@acme.test>", preview: "decrypted secret", encrypted: true, wireSubject: "...", daysAgo: 2 });
    return w;
  }

  it("searchMessages leaves an encrypted message out, matched on its subject or listed without a query", () => {
    const { sandbox } = seed();
    assert.deepEqual(ids(sandbox.searchMessages({ query: "merger" })), ["plain@lab.test"]);
    assert.deepEqual(ids(sandbox.searchMessages({ query: "" })), ["plain@lab.test"]);
    const groups = plain(sandbox.searchMessages({ query: "participant:@acme.test", groupBy: "sender" })).groups;
    assert.deepEqual(groups.map(g => g.latestId), ["plain@lab.test"]);
    const table = plain(sandbox.searchMessages({ query: "", format: "table" }));
    assert.equal(table.messages.rows.length, 1);
    assert.equal(JSON.stringify(table).includes("decrypted secret"), false);
    assert.equal(plain(sandbox.searchMessages({ query: "merger", countOnly: true })).count, 1);
  });

  it("getRecentMessages lists it with the wire-level subject, no preview and encrypted: true", () => {
    const { sandbox } = seed();
    const res = plain(sandbox.getRecentMessages({}));
    const secret = res.messages.find(m => m.id === "secret@lab.test");
    assert.deepEqual({ subject: secret.subject, encrypted: secret.encrypted, preview: secret.preview }, { subject: "...", encrypted: true, preview: undefined });
    assert.equal(res.messages.find(m => m.id === "plain@lab.test").preview, "plain preview");
    const legacy = plain(sandbox.getRecentMessages({ format: "legacy" }));
    const legacySecret = legacy.find(m => m.id === "secret@lab.test");
    assert.deepEqual([legacySecret.subject, legacySecret.encrypted, "preview" in legacySecret], ["...", true, false]);
    const table = plain(sandbox.getRecentMessages({ format: "table" }));
    assert.ok(table.messages.columns.includes("encrypted"));
    assert.equal(JSON.stringify(table).includes("decrypted secret"), false);
    const col = name => table.messages.columns.indexOf(name);
    const secretRow = table.messages.rows.find(r => r[col("id")] === "secret@lab.test");
    assert.deepEqual([secretRow[col("subject")], secretRow[col("encrypted")]], ["...", true]);
  });

  // A plain conversation, an encrypted reply joined by References, and plain replies without References.
  function seedThread(w) {
    hdr(w.inbox, { id: "w1@acme.test", subject: "Quarterly merger plan", author: "Ann <ann@acme.test>", daysAgo: 5 });
    // Its stored subject is the decrypted one (OpenPGP protected headers, opened once).
    hdr(w.inbox, { id: "x1@acme.test", subject: "Board approval", author: "Bob <bob@acme.test>", refs: ["w1@acme.test"], encrypted: true, wireSubject: "...", daysAgo: 4 });
    // Matches only x1's DECRYPTED subject: linking it would reveal that subject.
    hdr(w.inbox, { id: "y1@acme.test", subject: "Board approval", author: "Bob <bob@acme.test>", re: true, daysAgo: 3 });
    // A plain reply by subject to the plain conversation.
    hdr(w.inbox, { id: "z1@acme.test", subject: "Quarterly merger plan", author: "Ann <ann@acme.test>", re: true, daysAgo: 2 });
    return w;
  }
  const thread = w => plain(w.sandbox.searchMessages({ query: "", threadOf: { messageId: "w1@acme.test", folderPath: w.inbox.URI } })).messages
    .map(m => [m.id, m.linkedBy || "references"]);

  it("threadOf leaves an encrypted member out and never links by its stored subject", () => {
    assert.deepEqual(thread(seedThread(world())), [["w1@acme.test", "references"], ["z1@acme.test", "subject"]]);
    // Control: with the option on, the same data lists x1 and links y1 through x1's subject.
    assert.deepEqual(thread(seedThread(world({ encryptedAllowed: true }))), [
      ["w1@acme.test", "references"], ["x1@acme.test", "references"], ["y1@acme.test", "subject"], ["z1@acme.test", "subject"],
    ]);
  });
});

describe("account restriction in the #17 search paths", () => {
  function seed() {
    const w = world();
    hdr(w.inbox, { id: "a1@acme.test", subject: "Invoice 42", author: "Ann <ann@acme.test>", daysAgo: 2 });
    hdr(w.otherInbox, { id: "b1@acme.test", subject: "Re: Invoice 42", author: "Ann <ann@acme.test>", refs: ["a1@acme.test"], re: true, daysAgo: 1 });
    return w;
  }

  it("participant search, groupBy, getRecentMessages and threadOf never read the restricted account", () => {
    const { sandbox, inbox } = seed();
    assert.deepEqual(ids(sandbox.searchMessages({ query: "participant:@acme.test" })), ["a1@acme.test"]);
    assert.deepEqual(plain(sandbox.searchMessages({ query: "", groupBy: "thread" })).groups.map(g => g.latestId), ["a1@acme.test"]);
    assert.deepEqual(ids(sandbox.getRecentMessages({ includeTrash: true })), ["a1@acme.test"]);
    assert.deepEqual(ids(sandbox.searchMessages({ query: "", threadOf: { messageId: "a1@acme.test", folderPath: inbox.URI } })), ["a1@acme.test"]);
  });

  it("refuses a folder or a threadOf seed of the restricted account", () => {
    const { sandbox, otherInbox } = seed();
    assert.match(plain(sandbox.searchMessages({ query: "", folderPath: otherInbox.URI })).error, /not accessible/);
    assert.match(plain(sandbox.getRecentMessages({ folderPath: otherInbox.URI })).error, /not accessible/);
    assert.match(plain(sandbox.searchMessages({ query: "", threadOf: { messageId: "b1@acme.test", folderPath: otherInbox.URI } })).error, /not accessible/);
  });

  it("reads both accounts when the restriction is off", () => {
    const w = world({ restricted: false });
    hdr(w.inbox, { id: "a1@acme.test", subject: "Invoice 42", author: "Ann <ann@acme.test>", daysAgo: 2 });
    hdr(w.otherInbox, { id: "b1@acme.test", subject: "Re: Invoice 42", author: "Ann <ann@acme.test>", refs: ["a1@acme.test"], re: true, daysAgo: 1 });
    assert.deepEqual(ids(w.sandbox.searchMessages({ query: "participant:@acme.test" })), ["a1@acme.test", "b1@acme.test"]);
    assert.deepEqual(ids(w.sandbox.searchMessages({ query: "", threadOf: { messageId: "a1@acme.test", folderPath: w.inbox.URI } })), ["a1@acme.test", "b1@acme.test"]);
  });
});

describe("own addresses for conversation linking", () => {
  it("come from the identities of the accessible accounts only", () => {
    const accounts = [
      { key: "account1", identities: [{ email: "Me@Lab.test" }, { email: "" }] },
      { key: "account2", identities: [{ email: "hidden@other.test" }] },
    ];
    const sandbox = { getAccessibleAccounts: () => accounts.filter(a => a.key === "account1") };
    vm.createContext(sandbox);
    vm.runInContext(`${region("OWN ADDRESSES")}\nthis.getOwnEmails = getOwnEmails;`, sandbox);
    assert.deepEqual([...sandbox.getOwnEmails()], ["me@lab.test"]);
  });
});

describe("attachment search (attachmentName / attachmentType)", () => {
  const NOTE = { coverage: "Only messages Thunderbird flags as having attachments are read; signed (multipart/signed), multipart/related and single-part messages are usually not flagged." };
  const pdf = name => `Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n`
    + `--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="${name}"\r\n\r\n%PDF\r\n--b--\r\n`;
  const encrypted = `Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: application/pdf\r\n`
    + `Content-Disposition: attachment; filename="annex.pdf"\r\n\r\n%PDF\r\n--b\r\nContent-Type: multipart/encrypted; boundary="e"\r\n\r\n`
    + `--e\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--e--\r\n--b--\r\n`;
  function seed(options) {
    const w = world(options);
    hdr(w.inbox, { id: "plain@lab.test", subject: "Quarterly merger plan", author: "Ann <ann@acme.test>", raw: pdf("merger.pdf"), daysAgo: 3 });
    // Its stored subject is the decrypted one (OpenPGP protected headers, opened once).
    hdr(w.inbox, { id: "secret@lab.test", subject: "Quarterly merger plan", author: "Bob <bob@acme.test>", raw: encrypted, daysAgo: 2 });
    hdr(w.inbox, { id: "none@lab.test", subject: "Quarterly merger plan", author: "Ann <ann@acme.test>", daysAgo: 1 });
    hdr(w.otherInbox, { id: "other@lab.test", subject: "Quarterly merger plan", author: "Ann <ann@acme.test>", raw: pdf("merger.pdf"), daysAgo: 1 });
    return w;
  }

  it("lists the matching attachments and reads only flagged messages", async () => {
    const w = seed();
    const res = plain(await w.sandbox.searchMessages({ query: "", attachmentType: "application/pdf" }));
    assert.deepEqual(res.messages.map(m => [m.id, m.attachments]), [["plain@lab.test", [{ name: "merger.pdf", contentType: "application/pdf", size: 4 }]]]);
    assert.deepEqual(res.attachmentSearch, { checked: 1, skipped: { encrypted: 1 }, ...NOTE });
    assert.equal(res.incomplete, undefined);
    assert.deepEqual(w.inbox.reads.sort(), ["plain@lab.test", "secret@lab.test"]);
  });

  it("with query words, leaves out an encrypted envelope before reading it; counts an encrypted part the main search lists", async () => {
    const envelope = `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="e"\r\n\r\n`
      + `--e\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--e\r\nContent-Type: application/octet-stream; name="annex.pdf.asc"\r\n\r\nx\r\n--e--\r\n`;
    const w = seed();
    // Protected headers: the stored subject is the decrypted one
    hdr(w.inbox, { id: "envelope@lab.test", subject: "Quarterly merger plan", author: "Bob <bob@acme.test>", raw: envelope, encrypted: true, daysAgo: 2 });
    const res = plain(await w.sandbox.searchMessages({ query: "merger", attachmentName: "annex" }));
    assert.deepEqual(res.messages, []);
    // secret@lab.test (an encrypted part in a plain envelope) is counted; envelope@lab.test is in no count
    assert.deepEqual(res.attachmentSearch, { checked: 1, skipped: { encrypted: 1 }, ...NOTE });
    assert.equal(JSON.stringify(res).includes("secret@lab.test"), false);
    assert.equal(JSON.stringify(res).includes("envelope@lab.test"), false);
    assert.equal(w.inbox.reads.includes("envelope@lab.test"), false);
    // The search without attachment options lists the first and leaves the second out: the count tells nothing more
    assert.deepEqual(ids(w.sandbox.searchMessages({ query: "merger" })).sort(), ["none@lab.test", "plain@lab.test", "secret@lab.test"]);
    const count = plain(await w.sandbox.searchMessages({ query: "merger", attachmentName: "pdf", countOnly: true }));
    assert.deepEqual(count, { count: 1, attachmentSearch: { checked: 1, skipped: { encrypted: 1 }, ...NOTE } });
    // Without query words both are counted as encrypted, nothing in them read past the structure
    const all = plain(await w.sandbox.searchMessages({ query: "", attachmentName: "annex" }));
    assert.deepEqual(all.attachmentSearch, { checked: 1, skipped: { encrypted: 2 }, ...NOTE });
    // Control: with the option on, the encrypted message is checked on its structure (nothing decrypted)
    const allowed = plain(await seed({ encryptedAllowed: true }).sandbox.searchMessages({ query: "merger", attachmentName: "annex" }));
    assert.deepEqual(allowed.messages.map(m => m.id), ["secret@lab.test"]);
  });

  it("never reads the restricted account and refuses its folder", async () => {
    const w = seed();
    const res = plain(await w.sandbox.searchMessages({ query: "", attachmentName: "merger" }));
    assert.deepEqual(res.messages.map(m => m.id), ["plain@lab.test"]);
    assert.deepEqual(w.otherInbox.reads, []);
    assert.match(plain(await w.sandbox.searchMessages({ query: "", attachmentName: "x", folderPath: w.otherInbox.URI })).error, /not accessible/);
    const open = seed({ restricted: false });
    assert.deepEqual(ids(await open.sandbox.searchMessages({ query: "", attachmentName: "merger" })), ["other@lab.test", "plain@lab.test"]);
  });

  it("does not read a message without a local copy and reports it", async () => {
    const w = seed();
    w.inbox.server = { type: "imap" };
    w.inbox.offlineKeys = [];
    const res = plain(await w.sandbox.searchMessages({ query: "", attachmentName: "merger" }));
    assert.deepEqual(res.messages, []);
    assert.deepEqual(res.attachmentSearch, { checked: 0, skipped: { notOffline: 2 }, ...NOTE });
    assert.equal(res.incomplete, true);
    assert.deepEqual(w.inbox.reads, []);
  });

  it("rejects bad values and combinations", () => {
    const { sandbox } = seed();
    assert.match(sandbox.searchMessages({ query: "", attachmentType: "*/*" }).error, /MIME type or prefix/);
    assert.match(sandbox.searchMessages({ query: "", attachmentName: "x", threadOf: { messageId: "a", folderPath: "b" } }).error, /threadOf/);
    assert.match(sandbox.searchMessages({ query: "x", attachmentName: "x", searchBody: true }).error, /searchBody/);
    assert.match(sandbox.searchMessages({ query: "", attachmentName: "x", format: "legacy" }).error, /legacy/);
  });
});
