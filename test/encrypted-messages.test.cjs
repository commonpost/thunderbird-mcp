"use strict";

// Encrypted messages (OpenPGP, S/MIME) are not decrypted for the assistant
// unless the option is on; the tools return a short notice instead.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const apiSource = fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8");

const start = apiSource.indexOf("// BEGIN ENCRYPTED MESSAGE HELPERS");
const end = apiSource.indexOf("// END ENCRYPTED MESSAGE HELPERS");
assert.ok(start >= 0 && end > start, "encrypted-message helpers block missing");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${apiSource.slice(start, end)}
this.api = { isEncryptedMimeMessage, mayQuoteOriginal, ENCRYPTED_CONTENT_NOTICE, PREF_ALLOW_ENCRYPTED_CONTENT };`, sandbox);
const { isEncryptedMimeMessage, mayQuoteOriginal, ENCRYPTED_CONTENT_NOTICE, PREF_ALLOW_ENCRYPTED_CONTENT } = sandbox.api;

const wrapper = (...parts) => ({ contentType: "message/rfc822", parts });

describe("isEncryptedMimeMessage", () => {
  it("recognises an OpenPGP container", () => {
    const tree = wrapper({ contentType: "multipart/encrypted", parts: [
      { contentType: "application/pgp-encrypted", parts: [] },
      { contentType: "application/octet-stream", parts: [] },
    ] });
    assert.equal(isEncryptedMimeMessage(tree), true);
  });

  it("recognises an S/MIME container, with or without parameters or x- prefix", () => {
    for (const type of ["application/pkcs7-mime", "application/x-pkcs7-mime", "Application/PKCS7-MIME; smime-type=enveloped-data; name=smime.p7m"]) {
      assert.equal(isEncryptedMimeMessage(wrapper({ contentType: type, parts: [] })), true, type);
    }
  });

  it("reads the content-type header when contentType is missing", () => {
    const tree = wrapper({ headers: { "content-type": ["multipart/encrypted; protocol=\"application/pgp-encrypted\""] }, parts: [] });
    assert.equal(isEncryptedMimeMessage(tree), true);
  });

  it("finds an encrypted part nested inside another part", () => {
    const tree = wrapper({ contentType: "multipart/mixed", parts: [
      { contentType: "text/plain", parts: [] },
      { contentType: "message/rfc822", parts: [{ contentType: "application/pkcs7-mime", parts: [] }] },
    ] });
    assert.equal(isEncryptedMimeMessage(tree), true);
  });

  it("leaves ordinary and merely signed messages alone", () => {
    assert.equal(isEncryptedMimeMessage(wrapper({ contentType: "text/plain", parts: [] })), false);
    assert.equal(isEncryptedMimeMessage(wrapper({ contentType: "multipart/alternative", parts: [
      { contentType: "text/plain", parts: [] }, { contentType: "text/html", parts: [] }] })), false);
    assert.equal(isEncryptedMimeMessage(wrapper({ contentType: "multipart/signed", parts: [
      { contentType: "text/plain", parts: [] }, { contentType: "application/pgp-signature", parts: [] }] })), false);
  });

  it("fails closed on a tree that cannot be read or is too large to walk", () => {
    const unreadable = { get contentType() { throw new Error("unreadable"); } };
    assert.equal(isEncryptedMimeMessage(unreadable), true);
    const wide = wrapper(...Array.from({ length: 6000 }, () => ({ contentType: "text/plain", parts: [] })));
    assert.equal(isEncryptedMimeMessage(wide), true);
  });

  it("copes with a missing message", () => {
    assert.equal(isEncryptedMimeMessage(null), false);
    assert.equal(isEncryptedMimeMessage(undefined), false);
  });
});

describe("mayQuoteOriginal", () => {
  const plain = wrapper({ contentType: "text/plain", parts: [] });
  const encrypted = wrapper({ contentType: "multipart/encrypted", parts: [{ contentType: "application/pgp-encrypted", parts: [] }] });

  it("lets Thunderbird quote a message whose tree was read and holds no encrypted part", () => {
    assert.equal(mayQuoteOriginal(plain, false), true);
  });

  it("refuses without the tree: a message that was not loaded or parsed may be encrypted", () => {
    assert.equal(mayQuoteOriginal(null, false), false);
    assert.equal(mayQuoteOriginal(undefined, false), false);
  });

  it("refuses an encrypted message and a tree that cannot be read", () => {
    assert.equal(mayQuoteOriginal(encrypted, false), false);
    assert.equal(mayQuoteOriginal({ get contentType() { throw new Error("unreadable"); } }, false), false);
  });

  it("allows everything once the user allows encrypted content", () => {
    for (const tree of [plain, encrypted, null, undefined]) assert.equal(mayQuoteOriginal(tree, true), true);
  });
});

describe("notice text", () => {
  it("says in plain words that the content was not sent and how to change that", () => {
    assert.match(ENCRYPTED_CONTENT_NOTICE, /message chiffré : contenu non transmis \(option à activer\)/);
    assert.match(ENCRYPTED_CONTENT_NOTICE, /encrypted message: content not sent/);
  });
});

describe("wiring", () => {
  it("the option is a boolean preference that defaults to off and is read fail-closed", () => {
    assert.equal(PREF_ALLOW_ENCRYPTED_CONTENT, "extensions.commonpost-mcp.allowEncryptedContent");
    const i = apiSource.indexOf("function isEncryptedContentAllowed()");
    assert.ok(i > 0);
    const fn = apiSource.slice(i, i + 300);
    assert.match(fn, /getBoolPref\(PREF_ALLOW_ENCRYPTED_CONTENT, false\) === true/);
    assert.match(fn, /catch \{\s*return false;/);
  });

  it("all message readers pass the option to Thunderbird, none hard-codes true", () => {
    assert.ok(!apiSource.includes("examineEncryptedParts: true"));
    // getMessage, and loadMimeMessage which the reply and forward tools share.
    assert.equal(apiSource.match(/examineEncryptedParts: encryptedAllowed/g).length, 1);
    assert.equal(apiSource.match(/examineEncryptedParts: isEncryptedContentAllowed\(\)/g).length, 1);
  });

  it("getMessage returns the notice before any body extraction", () => {
    const i = apiSource.indexOf("if (!encryptedAllowed && isEncryptedMimeMessage(aMimeMsg)) {");
    assert.ok(i > 0);
    assert.ok(i < apiSource.indexOf("const requestedBodyFormat = bodyFormat"));
    assert.match(apiSource.slice(i, i + 1400), /body: ENCRYPTED_CONTENT_NOTICE[\s\S]*encrypted: true[\s\S]*attachments: \[\]/);
  });

  it("the send and draft modes of reply and forward stop before quoting an encrypted message", () => {
    const guard = /if \(composeMode !== "window"\) \{\s*if \(!isEncryptedContentAllowed\(\) && isEncryptedMimeMessage\(mimeMsg\)\) \{\s*return \{ error: `\$\{ENCRYPTED_CONTENT_NOTICE\}; nothing was \$\{composeMode === "send" \? "sent" : "saved"\}` \};\s*\}/g;
    const hits = [...apiSource.matchAll(guard)];
    assert.equal(hits.length, 2);
    // The guard opens the branch: the reply and the forward build their body only after it
    const [reply, forward] = hits.map((hit) => hit.index + hit[0].length);
    assert.equal(apiSource.match(/await buildReplyBody\(/g).length, 1);
    const replyBody = apiSource.indexOf("await buildReplyBody(", reply);
    assert.ok(replyBody > reply && replyBody < forward, "the reply body is built after the guard, in the reply tool");
    assert.equal(apiSource.match(/= buildForwardBody\(/g).length, 1);
    assert.ok(apiSource.indexOf("= buildForwardBody(") > forward, "the forward body is built after the guard");
  });

  it("the forward body comes from the parsed message, which is not decrypted, never from Thunderbird's quote", () => {
    const i = apiSource.indexOf("function forwardBodyFor(mimeMsg, msgHdr, useHtml)");
    const fn = apiSource.slice(i, apiSource.indexOf("\n            }\n", i));
    assert.ok(i > 0 && fn.includes("extractBodyContent(mimeMsg, true)"));
    assert.ok(!/quoteMessageHtml|nsIMsgQuote/.test(fn));
  });

  it("Thunderbird's own quote, which decrypts, is taken only for a message known not to be encrypted", () => {
    // One call, behind mayQuoteOriginal: a message whose tree was not read gets no quote from nsIMsgQuote
    assert.equal(apiSource.match(/await quoteMessageHtml\(/g).length, 1);
    assert.ok(apiSource.includes("mayQuoteOriginal(mimeMsg, isEncryptedContentAllowed()) ? await quoteMessageHtml(msgURI, msgHdr) : null"));
    assert.equal(apiSource.match(/createInstance\(Ci\.nsIMsgQuote\)/g).length, 1);
  });

  it("an encrypted draft is not rewritten: saveDraft with draftId stops before it reads the body", () => {
    const i = apiSource.indexOf("async function updateDraft(args)");
    assert.ok(i > 0);
    const fn = apiSource.slice(i, apiSource.indexOf("\n            }\n", i));
    const guard = fn.indexOf("if (!isEncryptedContentAllowed() && isEncryptedMimeMessage(mimeMsg)) {\n                  return { error: `${ENCRYPTED_CONTENT_NOTICE}; nothing was changed` };");
    assert.ok(guard > fn.indexOf("await loadMimeMessage(msgHdr)"));
    assert.ok(guard < fn.indexOf("extractBodyContent(mimeMsg, true)"));
    assert.ok(guard < fn.indexOf("saveComposeFieldsAsDraft("));
  });

  it("the option is in the schema and on the options page, unchecked until loaded", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(root, "extension/mcp_server/schema.json"), "utf8"));
    const names = schema[0].functions.map((f) => f.name);
    assert.ok(names.includes("getAllowEncryptedContent") && names.includes("setAllowEncryptedContent"));
    const html = fs.readFileSync(path.join(root, "extension/options.html"), "utf8");
    assert.match(html, /<input type="checkbox" id="allowEncryptedContent">/);
    const js = fs.readFileSync(path.join(root, "extension/options.js"), "utf8");
    assert.match(js, /setAllowEncryptedContent\(allowEncryptedContentCheckbox\.checked\)/);
    assert.match(js, /allowEncryptedContentCheckbox\.checked = allowEncryptedContent === true;/);
  });
});
