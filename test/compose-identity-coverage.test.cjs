// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// Which identity a reply, a forward or a new message is sent from, and the recipients a reply gets: the catch-all and
// Delivered-To hints, the switch to the identity that wrote the message being answered, the choice of a default
// identity under an account restriction. Runs the real functions of api.js against fake accounts and a fake header
// parser. Complements identity-restriction.test.cjs.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function slice(start, end) {
  const i = API.indexOf(start);
  assert.ok(i >= 0, `${start} not found`);
  const j = API.indexOf(end, i);
  assert.ok(j > i, `${end} not found`);
  return API.slice(i, j);
}

function fn(name) {
  const indent = "            ";
  const start = API.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  const end = API.indexOf(close, start);
  assert.ok(end > start, `end of ${name} not found in api.js`);
  return API.slice(start, end + close.length);
}

const code = `${slice("// BEGIN COMPOSE HELPERS", "// END COMPOSE HELPERS")}
${slice("function findIdentityIn(", "function mimeHeaderValue(")}
${slice("function parseMailboxes(", "/** Creates an nsIFile instance")}
${["splitAddressHeader", "extractAddressEmail", "mergeAddressHeaders", "getIdentityAutoRecipientHeader", "setReplyDraftRecipients", "setDirectSendRecipients",
  "setComposeIdentity", "resolveComposeFormat", "mimeHeaderValue"].map(fn).join("\n")}
this.api = { setDirectSendRecipients, resolveComposeFormat, mimeHeaderValue, findIdentityIn, deliveredToIdentityEmail, identityForMessage, setReplyIdentity, parseMailboxes, replySelfIdentities,
  replyRecipientsFor, setReplyDraftRecipients, setComposeIdentity };`;

// "Name <a@x>, b@y" -> [{ name, email, toString }]
const mailbox = (name, email) => ({ name, email, toString() { return name ? `${name} <${email}>` : email; } });
const parseAddresses = header => String(header || "").split(",").map(s => s.trim()).filter(Boolean).map(part => {
  const m = part.match(/^(.*?)\s*<([^>]+)>$/);
  return m ? mailbox(m[1].replace(/^"|"$/g, ""), m[2]) : mailbox("", part);
});
const plain = v => JSON.parse(JSON.stringify(v));

// accounts: [{ key, identities, defaultIdentity?, incomingServer? }]; allowed: account keys ([] = no restriction)
function load({ accounts, allowed = [], mailUtils = {}, prefs = {}, defaultAccount, headerParser = {}, mimeConverter, extra = {} }) {
  const isAccountAllowed = key => allowed.length === 0 || allowed.includes(key);
  const getAccessibleAccounts = () => accounts.filter(account => isAccountAllowed(account.key));
  const parser = {
    parseEncodedHeader: (value) => parseAddresses(value),
    parseEncodedHeaderW: (value) => parseAddresses(value),
    makeMailboxObject: mailbox,
    makeMimeHeader: list => list.map(m => m.toString()).join(", "),
    makeFromDisplayAddress: value => parseAddresses(value),
    ...headerParser,
  };
  const warnings = [];
  const sandbox = {
    console: { warn: (...args) => warnings.push(args) },
    MailServices: {
      accounts: {
        accounts,
        allIdentities: accounts.flatMap(account => account.identities),
        defaultAccount,
        findAccountForServer: server => accounts.find(account => account.incomingServer === server) || null,
        getAccount: key => accounts.find(account => account.key === key) || null,
        getIdentitiesForServer: server => accounts.filter(account => account.incomingServer === server).flatMap(account => account.identities),
      },
      headerParser: parser,
      mimeConverter,
    },
    Services: {
      prefs: {
        getBoolPref: (name, fallback) => (name in prefs ? prefs[name] : fallback),
        getStringPref: (name, fallback) => (name in prefs ? prefs[name] : fallback),
      },
    },
    ChromeUtils: { importESModule: () => ({ MailUtils: mailUtils }) },
    Ci: { nsIMsgCompType: { ForwardInline: 4, ForwardAsAttachment: 5, Reply: 1 }, nsIMsgCompFormat: { Default: 0, HTML: 1, PlainText: 2, OppositeOfDefault: 3 } },
    isAccountAllowed,
    getAccessibleAccounts,
    ...extra,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { ...sandbox.api, warnings };
}

const identity = (key, email, extra = {}) => ({ key, email, ...extra });
const me = identity("id-me", "me@home.test");
const alias = identity("id-alias", "alias@home.test", { replyTo: "desk@home.test", doCc: true, doCcList: "boss@home.test", doBcc: true, doBccList: "archive@home.test" });
const server = { type: "imap" };
const accountOf = (key, identities, extra = {}) => ({ key, identities, defaultIdentity: identities[0], ...extra });

describe("findIdentityIn", () => {
  const accounts = [accountOf("a", [me, identity("id-noemail", undefined)])];

  it("finds an identity by key or by address, whatever the case of the address", () => {
    const { findIdentityIn } = load({ accounts });
    assert.equal(findIdentityIn(accounts, "id-me"), me);
    assert.equal(findIdentityIn(accounts, "ME@Home.Test"), me);
    assert.equal(findIdentityIn(accounts, "nobody@home.test"), null);
  });

  it("finds nothing for an empty request, and passes over an identity without address", () => {
    const { findIdentityIn } = load({ accounts });
    assert.equal(findIdentityIn(accounts, ""), null);
    assert.equal(findIdentityIn(accounts, undefined), null);
    assert.equal(findIdentityIn(accounts, "id-noemail").key, "id-noemail");
    assert.equal(findIdentityIn(accounts, "undefined"), null);
  });
});

describe("deliveredToIdentityEmail", () => {
  const accounts = [accountOf("a", [me, alias, identity("id-bare", undefined)])];

  it("names the identity a Delivered-To header addresses, plain or in angle brackets, whatever the case", () => {
    const { deliveredToIdentityEmail } = load({ accounts });
    assert.equal(deliveredToIdentityEmail({ headers: { "delivered-to": ["ME@home.test"] } }), "me@home.test");
    assert.equal(deliveredToIdentityEmail({ headers: { "delivered-to": ["Alias <Alias@Home.test>"] } }), "alias@home.test");
  });

  it("takes the earliest Delivered-To that names an identity: the last of the headers", () => {
    const { deliveredToIdentityEmail } = load({ accounts });
    assert.equal(deliveredToIdentityEmail({ headers: { "delivered-to": ["me@home.test", "other@x.test", "alias@home.test"] } }), "alias@home.test");
    assert.equal(deliveredToIdentityEmail({ headers: { "delivered-to": ["me@home.test", "other@x.test"] } }), "me@home.test");
  });

  it("is empty when no Delivered-To names an identity, or there is no message to read", () => {
    const { deliveredToIdentityEmail } = load({ accounts });
    assert.equal(deliveredToIdentityEmail({ headers: { "delivered-to": ["somebody@x.test", ""] } }), "");
    assert.equal(deliveredToIdentityEmail({ headers: {} }), "");
    assert.equal(deliveredToIdentityEmail(null), "");
  });
});

describe("identityForMessage with the catch-all headers", () => {
  const catchAll = identity("id-catch", "catch@home.test", { catchAll: true });
  const accounts = [accountOf("a", [me, catchAll])];
  const msgHdr = { folder: { server, customIdentity: null }, recipients: "Rosa <rosa@home.test>", ccList: "" };
  const mimeMsg = { headers: { to: ["Rosa <rosa@home.test>, other@x.test"], "x-original-to": ["rosa@home.test"], cc: ["ignored@x.test"] } };

  it("builds the hint from the headers named in mail.compose.catchAllHeaders, not from Delivered-To, and sends as the address that was written to", () => {
    const calls = [];
    const mailUtils = {
      getIdentityForHeader: (hdr, compType, hint) => { calls.push({ compType, hint }); return [catchAll, mailbox("", "rosa@home.test")]; },
      getBestIdentity: () => { throw new Error("not restricted"); },
    };
    const { identityForMessage } = load({ accounts, mailUtils, prefs: { "mail.compose.catchAllHeaders": " To , X-Original-To ,,", } });
    const result = identityForMessage(msgHdr, 1, mimeMsg);
    // each header value gives its addresses, one comma after each value; the name comes from the message
    assert.deepEqual(calls, [{ compType: 1, hint: "Rosa <rosa@home.test>,other@x.test,rosa@home.test," }]);
    assert.equal(result.identity, catchAll);
    assert.equal(result.from, "Rosa <rosa@home.test>");
  });

  it("keeps the bare address when the message shows no name for it, and the name it already has", () => {
    const run = matching => load({
      accounts,
      mailUtils: { getIdentityForHeader: () => [catchAll, matching] },
    }).identityForMessage({ ...msgHdr, recipients: "other@x.test" }, 1, { headers: {} });
    assert.equal(run(mailbox("", "rosa@home.test")).from, "rosa@home.test");
    assert.equal(run(mailbox("Rosa R.", "rosa@home.test")).from, "Rosa R. <rosa@home.test>");
  });

  it("sends as whatever the matching hint says when it holds no address", () => {
    const { identityForMessage } = load({ accounts, mailUtils: { getIdentityForHeader: () => [catchAll, { email: "", name: "", toString: () => "" }] } });
    assert.deepEqual(plain(identityForMessage(msgHdr, 1, mimeMsg)), { identity: catchAll, from: "" });
  });

  it("sends as the identity itself when the identity picked is not a catch-all one, or nothing matched", () => {
    const run = (picked, matching) => load({
      accounts,
      mailUtils: { getIdentityForHeader: () => [picked, matching] },
    }).identityForMessage(msgHdr, 1, mimeMsg);
    assert.deepEqual(plain(run(me, mailbox("", "rosa@home.test"))), { identity: me, from: "" });
    assert.deepEqual(plain(run(catchAll, null)), { identity: catchAll, from: "" });
  });

  it("does not use catch-all for a news folder or a folder with an identity of its own: the hint is Delivered-To", () => {
    const hints = [];
    const mailUtils = { getIdentityForHeader: (hdr, compType, hint) => { hints.push(hint); return [me, null]; } };
    const { identityForMessage } = load({ accounts, mailUtils });
    const withDelivered = { headers: { "delivered-to": ["me@home.test"] } };
    identityForMessage({ ...msgHdr, folder: { server: { type: "nntp" }, customIdentity: null } }, 1, withDelivered);
    identityForMessage({ ...msgHdr, folder: { server, customIdentity: me } }, 1, withDelivered);
    identityForMessage({ ...msgHdr, folder: null }, 1, withDelivered);
    assert.deepEqual(hints, ["me@home.test", "me@home.test", "me@home.test"]);
  });

  it("does not use catch-all when no identity is a catch-all one", () => {
    const hints = [];
    const { identityForMessage } = load({ accounts: [accountOf("a", [me])], mailUtils: { getIdentityForHeader: (hdr, type, hint) => { hints.push(hint); return [me, null]; } } });
    identityForMessage(msgHdr, 1, { headers: { "delivered-to": ["me@home.test"] } });
    assert.deepEqual(hints, ["me@home.test"]);
  });
});

describe("setReplyIdentity", () => {
  const accounts = [accountOf("a", [me, alias], { incomingServer: server })];
  const mailUtils = { getIdentityForHeader: () => [alias, null] };
  const msgHdr = { folder: { server, customIdentity: null }, recipients: "alias@home.test", ccList: "" };

  it("takes the identity named by from, and leaves the compose fields alone", () => {
    const { setReplyIdentity } = load({ accounts, mailUtils });
    const params = { composeFields: {} };
    assert.equal(setReplyIdentity(params, "me@home.test", msgHdr, 1, null), "");
    assert.equal(params.identity, me);
    assert.equal(params.composeFields.from, undefined);
  });

  it("refuses a from that is not an identity, with the reason", () => {
    const { setReplyIdentity } = load({ accounts, mailUtils });
    assert.deepEqual(plain(setReplyIdentity({ composeFields: {} }, "stranger@x.test", msgHdr, 1, null)), { error: "unknown identity: stranger@x.test -- no matching account configured in Thunderbird" });
  });

  it("picks the identity Thunderbird's own reply picks when from is empty", () => {
    const { setReplyIdentity } = load({ accounts, mailUtils });
    const params = { composeFields: {} };
    assert.equal(setReplyIdentity(params, "", msgHdr, 1, null), null);
    assert.equal(params.identity, alias);
    assert.equal(params.composeFields.from, undefined);
  });

  it("sends as the catch-all address when the pick comes with one, and passes an error on", () => {
    const catchAll = identity("id-catch", "catch@home.test", { catchAll: true });
    const both = [accountOf("a", [catchAll])];
    const { setReplyIdentity } = load({ accounts: both, mailUtils: { getIdentityForHeader: () => [catchAll, mailbox("Rosa", "rosa@home.test")] } });
    const params = { composeFields: {} };
    assert.equal(setReplyIdentity(params, "", msgHdr, 1, null), null);
    assert.equal(params.composeFields.from, "Rosa <rosa@home.test>");
    const restricted = load({ accounts: both, allowed: ["nothing"], mailUtils: { getIdentityForHeader: () => [catchAll, null], getBestIdentity: () => [null, null] } });
    assert.deepEqual(plain(restricted.setReplyIdentity({ composeFields: {} }, "", msgHdr, 1, null)), { error: "No accessible identity found -- all accounts are restricted" });
  });
});

describe("parseMailboxes and replySelfIdentities", () => {
  const accounts = [accountOf("a", [me, alias, identity("id-bare", undefined)], { incomingServer: server }), accountOf("b", [identity("id-b", "b@home.test")], { incomingServer: { type: "pop3" } })];

  it("reads a raw header into names and addresses, and nothing into an empty list", () => {
    const { parseMailboxes } = load({ accounts });
    assert.deepEqual(plain(parseMailboxes("Ann <ann@x.test>, bob@x.test")), [{ name: "Ann", email: "ann@x.test" }, { name: "", email: "bob@x.test" }]);
    assert.deepEqual(plain(parseMailboxes("")), []);
    assert.deepEqual(plain(parseMailboxes(undefined)), []);
  });

  it("reads text that holds a character above 255 as text and the rest as UTF-8 bytes, filling a missing name or address with nothing", () => {
    const seen = [];
    const headerParser = {
      parseEncodedHeader: (value, charset) => { seen.push(["bytes", value, charset]); return [{ name: undefined, email: "e@x.test" }]; },
      parseEncodedHeaderW: value => { seen.push(["text", value]); return [{ name: "\u4e2d", email: undefined }]; },
    };
    const { parseMailboxes } = load({ accounts, headerParser });
    assert.deepEqual(plain(parseMailboxes("\u00c9lise <e@x.test>")), [{ name: "", email: "e@x.test" }]);
    assert.deepEqual(plain(parseMailboxes("\u4e2d <e@x.test>")), [{ name: "\u4e2d", email: "" }]);
    assert.deepEqual(seen, [["bytes", "\u00c9lise <e@x.test>", "UTF-8"], ["text", "\u4e2d <e@x.test>"]]);
  });

  it("gives an empty list when the parser fails", () => {
    const failing = load({ accounts, headerParser: { parseEncodedHeader: () => { throw new Error("bad header"); } } });
    assert.deepEqual(plain(failing.parseMailboxes("x")), []);
  });

  it("checks all identities of all accounts, those with an address, unless the preference limits it", () => {
    const { replySelfIdentities } = load({ accounts });
    assert.deepEqual(plain(replySelfIdentities({}).map(id => id.key)), ["id-me", "id-alias", "id-b"]);
  });

  it("limits the check to the account of the message, or to the account of its server", () => {
    const prefs = { "mailnews.reply_to_self_check_all_ident": false };
    const { replySelfIdentities } = load({ accounts, prefs });
    assert.deepEqual(plain(replySelfIdentities({ accountKey: "b" }).map(id => id.key)), ["id-b"]);
    assert.deepEqual(plain(replySelfIdentities({ accountKey: "gone" })), []);
    assert.deepEqual(plain(replySelfIdentities({ accountKey: "", folder: { server } }).map(id => id.key)), ["id-me", "id-alias"]);
  });

  it("checks no identity when they cannot be read", () => {
    const { replySelfIdentities } = load({ accounts, prefs: { "mailnews.reply_to_self_check_all_ident": false } });
    assert.deepEqual(plain(replySelfIdentities({ accountKey: "", folder: null })), []);
  });
});

describe("replyRecipientsFor", () => {
  const accounts = [accountOf("a", [me, alias])];
  const msgHdr = { author: "Alice <alice@acme.test>", recipients: "Me <me@home.test>, Bob <bob@acme.test>", ccList: "Carol <carol@x.test>", bccList: "", folder: { server } };
  const emails = list => list.map(m => m.email).join(", ");
  const run = (options = {}, original = {}) => {
    const { replyRecipientsFor } = load({ accounts, ...options });
    return replyRecipientsFor(original.msgHdr || msgHdr, original.mimeMsg === undefined ? null : original.mimeMsg, "identity" in original ? original.identity : me, !!original.replyAll, original.senderFrom, original.keepIdentity);
  };

  it("takes the recipients of the message from its headers, or from the message header when the message cannot be parsed", () => {
    const fromHeaders = run({}, { mimeMsg: { headers: { from: ["Zoe <zoe@acme.test>"], to: ["me@home.test"], cc: ["Dan <dan@x.test>"], bcc: ["Eve <eve@x.test>"] } }, replyAll: true });
    assert.equal(emails(fromHeaders.to), "zoe@acme.test");
    assert.equal(emails(fromHeaders.cc), "dan@x.test");
    const fromMessage = run({}, { replyAll: true });
    assert.equal(emails(fromMessage.to), "alice@acme.test, bob@acme.test");
    assert.equal(emails(fromMessage.cc), "carol@x.test");
    assert.equal(fromMessage.identity, me);
    assert.equal(fromMessage.from, "");
  });

  it("gives the Reply-To of the original when the original has one, and the Reply-To of the identity otherwise", () => {
    const withReplyTo = run({}, { mimeMsg: { headers: { "reply-to": ["support@acme.test"] } } });
    assert.equal(emails(withReplyTo.to), "support@acme.test");
    const identityReplyTo = run({}, { identity: alias });
    assert.equal(emails(identityReplyTo.replyTo), "desk@home.test");
    assert.equal(emails(identityReplyTo.cc), "boss@home.test");
    assert.equal(emails(identityReplyTo.bcc), "archive@home.test");
  });

  it("keeps the sender the caller named, and answers the author of a list that munges Reply-To", () => {
    const listed = run({}, {
      mimeMsg: { headers: { "reply-to": ["List <list@lists.test>"], "list-post": ["<mailto:list@lists.test>"] } },
      senderFrom: "me@home.test",
    });
    assert.equal(emails(listed.to), "alice@acme.test");
    assert.equal(listed.from, "me@home.test");
    // the preference to keep what the list put in Reply-To
    const kept = run({ prefs: { "mail.override_list_reply_to": false } }, { mimeMsg: { headers: { "reply-to": ["List <list@lists.test>"], "list-post": ["<mailto:list@lists.test>"] } } });
    assert.equal(emails(kept.to), "list@lists.test");
  });

  it("decodes an encoded List-Post, and keeps the raw one when it cannot be decoded", () => {
    const original = { mimeMsg: { headers: { "reply-to": ["List <list@lists.test>"], "list-post": ["=?UTF-8?Q?=3Cmailto=3Alist=40lists.test=3E?="] } } };
    const decoded = run({ mimeConverter: { decodeMimeHeader: () => "<mailto:list@lists.test>" } }, original);
    assert.equal(emails(decoded.to), "alice@acme.test");
    const empty = run({ mimeConverter: { decodeMimeHeader: () => "" } }, original);
    assert.equal(emails(empty.to), "list@lists.test");
    const broken = run({ mimeConverter: { decodeMimeHeader: () => { throw new Error("bad"); } } }, original);
    assert.equal(emails(broken.to), "list@lists.test");
  });

  it("answers a message from one of the user's identities as that identity, with its Reply-To, Cc and Bcc", () => {
    const own = { ...msgHdr, author: "Alias <alias@home.test>", recipients: "Bob <bob@acme.test>", ccList: "" };
    const result = run({}, { msgHdr: own, identity: me, replyAll: true });
    assert.equal(result.identity, alias);
    assert.equal(result.from, "");
    assert.equal(emails(result.to), "bob@acme.test");
    assert.equal(emails(result.replyTo), "desk@home.test");
    assert.equal(emails(result.cc), "boss@home.test");
    assert.equal(emails(result.bcc), "archive@home.test");
  });

  it("does not switch identity when the caller named one, when it is the same one, or when it is not allowed", () => {
    const own = { ...msgHdr, author: "Alias <alias@home.test>", recipients: "Bob <bob@acme.test>", ccList: "" };
    const named = run({}, { msgHdr: own, identity: me, keepIdentity: true, senderFrom: "me@home.test" });
    assert.equal(named.identity, me);
    assert.equal(named.from, "me@home.test");
    assert.equal(emails(named.cc), "");
    const same = run({}, { msgHdr: own, identity: alias });
    assert.equal(same.identity, alias);
    const restricted = run({ accounts: [accountOf("a", [me]), accountOf("b", [alias])], allowed: ["a"] }, { msgHdr: own, identity: me });
    assert.equal(restricted.identity, me);
  });

  it("answers a message without any address of its own with no recipient", () => {
    const empty = run({}, { msgHdr: { folder: { server } } });
    assert.deepEqual(plain(empty.to), []);
    assert.deepEqual(plain(empty.cc), []);
    assert.equal(run({}, { identity: null }).identity, null);
  });
});

describe("setReplyDraftRecipients", () => {
  const accounts = [accountOf("a", [me, alias])];
  const msgHdr = { author: "Alice <alice@acme.test>", recipients: "Me <me@home.test>, Bob <bob@acme.test>", ccList: "Carol <carol@x.test>", bccList: "", folder: { server } };

  it("fills the reply fields with what Thunderbird's reply computes", () => {
    const { setReplyDraftRecipients } = load({ accounts });
    const params = { identity: alias, composeFields: { from: "" } };
    setReplyDraftRecipients(params, msgHdr, null, true, "", "", "", false);
    assert.equal(params.identity, alias);
    assert.deepEqual({ ...params.composeFields }, {
      // only the identity that sends is taken out of the recipients: the other address of the user stays in To
      from: "", to: "Alice <alice@acme.test>, Me <me@home.test>, Bob <bob@acme.test>", cc: "boss@home.test, Carol <carol@x.test>", bcc: "archive@home.test", replyTo: "desk@home.test",
    });
  });

  it("lets the recipients of the caller replace the computed ones, merging in the automatic Cc and Bcc of the identity", () => {
    const { setReplyDraftRecipients } = load({ accounts });
    const params = { identity: alias, composeFields: { from: "" } };
    setReplyDraftRecipients(params, msgHdr, null, false, "t@x.test", "c@x.test, Boss <boss@home.test>", "z@x.test", false);
    assert.equal(params.composeFields.to, "t@x.test");
    assert.equal(params.composeFields.cc, "boss@home.test, c@x.test");
    assert.equal(params.composeFields.bcc, "archive@home.test, z@x.test");
  });
});

describe("setComposeIdentity", () => {
  const second = identity("id-second", "second@home.test");
  const restrictedIdentity = identity("id-restricted", "restricted@home.test");
  const a = accountOf("a", [me], { incomingServer: server });
  const b = accountOf("b", [second], { incomingServer: { type: "pop3" } });
  const r = accountOf("r", [restrictedIdentity], { incomingServer: { type: "none" } });

  it("takes the identity from names by key or by address", () => {
    const { setComposeIdentity } = load({ accounts: [a, b] });
    const params = {};
    assert.equal(setComposeIdentity(params, "second@home.test", null), "");
    assert.equal(params.identity, second);
    assert.equal(setComposeIdentity(params, "id-me", null), "");
    assert.equal(params.identity, me);
  });

  it("refuses an identity of a restricted account, and one that does not exist, each with its own message", () => {
    const { setComposeIdentity } = load({ accounts: [a, r], allowed: ["a"] });
    const params = {};
    assert.deepEqual(plain(setComposeIdentity(params, "restricted@home.test", null)), { error: "identity restricted@home.test belongs to a restricted account" });
    assert.deepEqual(plain(setComposeIdentity(params, "stranger@x.test", null)), { error: "unknown identity: stranger@x.test -- no matching account configured in Thunderbird" });
    assert.equal(params.identity, undefined);
  });

  it("without from, takes the default identity of the account of the folder", () => {
    const { setComposeIdentity } = load({ accounts: [a, b], defaultAccount: a });
    const params = {};
    assert.equal(setComposeIdentity(params, "", b.incomingServer), "");
    assert.equal(params.identity, second);
  });

  it("without from and without folder, takes the default identity of the default account", () => {
    const { setComposeIdentity } = load({ accounts: [a, b], defaultAccount: b });
    const params = {};
    assert.equal(setComposeIdentity(params, "", null), "");
    assert.equal(params.identity, second);
  });

  it("falls back to the first accessible account that has a default identity when the contextual default is restricted or missing", () => {
    const noDefault = { key: "n", identities: [], defaultIdentity: null };
    for (const setup of [
      { defaultAccount: r, server: null },
      { defaultAccount: undefined, server: null },
      { defaultAccount: a, server: r.incomingServer },
      { defaultAccount: a, server: { type: "unknown" } },
    ]) {
      const { setComposeIdentity } = load({ accounts: [r, noDefault, b, a], allowed: ["n", "b", "a"], defaultAccount: setup.defaultAccount });
      const params = {};
      assert.equal(setComposeIdentity(params, "", setup.server), "", JSON.stringify(Object.keys(setup)));
      assert.equal(params.identity, second);
    }
  });

  it("is an error when there is no accessible identity at all", () => {
    const { setComposeIdentity } = load({ accounts: [r, { key: "n", identities: [], defaultIdentity: null }], allowed: ["n"], defaultAccount: r });
    assert.deepEqual(plain(setComposeIdentity({}, "", null)), { error: "No accessible identity found -- all accounts are restricted" });
  });
});

describe("setDirectSendRecipients", () => {
  const withLists = identity("id-lists", "lists@home.test", { replyTo: "desk@home.test", doCc: true, doCcList: "boss@home.test", doBcc: true, doBccList: "archive@home.test" });

  it("sends only to the addresses the caller gave, plus the automatic Cc, Bcc and Reply-To of the identity", () => {
    const { setDirectSendRecipients } = load({ accounts: [accountOf("a", [withLists])] });
    const fields = {};
    setDirectSendRecipients(fields, withLists, "t@x.test", "c@x.test, boss@home.test", "");
    assert.deepEqual({ ...fields }, { to: "t@x.test", cc: "boss@home.test, c@x.test", bcc: "archive@home.test", replyTo: "desk@home.test" });
  });

  it("leaves Reply-To alone for an identity without one, and writes empty fields for no recipient", () => {
    const { setDirectSendRecipients } = load({ accounts: [accountOf("a", [me])] });
    const fields = {};
    setDirectSendRecipients(fields, me, undefined, undefined, undefined);
    assert.deepEqual({ ...fields }, { to: "", cc: "", bcc: "" });
    setDirectSendRecipients(fields, null, "t@x.test", "", "");
    assert.equal(fields.to, "t@x.test");
    assert.equal("replyTo" in fields, false);
  });
});

describe("resolveComposeFormat", () => {
  const { resolveComposeFormat } = load({ accounts: [] });
  const Reply = 1;
  const Forward = 4;
  const asAttachment = 5;
  const run = (identityValue, isHtml, type) => plain(resolveComposeFormat(identityValue, isHtml, type));

  it("follows the identity when the caller does not say, and says so to Thunderbird by asking for its default", () => {
    assert.deepEqual(run({ composeHtml: true }, undefined, Reply), { useHtml: true, format: 0 });
    assert.deepEqual(run({ composeHtml: false }, undefined, Reply), { useHtml: false, format: 0 });
    assert.deepEqual(run(null, undefined, Reply), { useHtml: true, format: 0 });
  });

  it("follows the caller for a reply, whatever the identity prefers", () => {
    assert.deepEqual(run({ composeHtml: false }, true, Reply), { useHtml: true, format: 1 });
    assert.deepEqual(run({ composeHtml: true }, false, Reply), { useHtml: false, format: 2 });
  });

  it("asks a forward for the default, or for its opposite when the caller's format is not the identity's", () => {
    assert.deepEqual(run({ composeHtml: true }, true, Forward), { useHtml: true, format: 0 });
    assert.deepEqual(run({ composeHtml: true }, false, Forward), { useHtml: false, format: 3 });
    assert.deepEqual(run({ composeHtml: false }, true, asAttachment), { useHtml: true, format: 3 });
    assert.deepEqual(run({ composeHtml: false }, false, asAttachment), { useHtml: false, format: 0 });
  });
});

describe("mimeHeaderValue", () => {
  const { mimeHeaderValue } = load({ accounts: [] });

  it("reads a header through the get method of the parsed message when it has one, else from its header lists", () => {
    assert.equal(mimeHeaderValue({ get: name => (name === "message-id" ? "<m@x>" : undefined) }, "message-id"), "<m@x>");
    assert.equal(mimeHeaderValue({ get: () => undefined }, "message-id"), "");
    assert.equal(mimeHeaderValue({ headers: { "message-id": ["<a@x>", "<b@x>"] } }, "message-id"), "<a@x>");
    assert.equal(mimeHeaderValue({ headers: {} }, "message-id"), "");
    assert.equal(mimeHeaderValue(null, "message-id"), "");
  });

  it("gives an empty value when the message cannot be read", () => {
    assert.equal(mimeHeaderValue({ get() { throw new Error("gone"); } }, "message-id"), "");
  });
});
