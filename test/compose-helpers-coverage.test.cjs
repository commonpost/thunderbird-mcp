// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// The less travelled paths of the compose helpers: what a result, an address list, a draft body or a header becomes
// when the input is empty, partial, hostile or just unusual. Complements compose-helpers.test.cjs.
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

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${slice("// BEGIN COMPOSE HELPERS", "// END COMPOSE HELPERS")}
this.api = { withRecipientWarning, dryRunComposeResult, clampHeaderValue, isUnsubscribeHostAllowed, parseListUnsubscribe,
  removeDuplicateMailboxes, computeReplyRecipients, switchIdentityRecipients, buildReplyReferences, serializedTextReferences,
  buildCitePrefix, stripDocumentTags, plainTextToForwardHtml, forwardPlainText, joinFlowedLines, replaceFileURLs,
  frameImageSignature, removeQueryPart, tagEmbeddedObjects, serializerMetaCharset, layoutComposeHtml, layoutComposeText,
  htmlDraftBlocks, trailingSeparatorLength, splitDraftBody, mergeDraftFields, draftPriorityName, draftInfoFields };`, sandbox);
const api = sandbox.api;
const plain = v => JSON.parse(JSON.stringify(v));

describe("withRecipientWarning leaves what is not a result object alone", () => {
  it("returns null, undefined, text and arrays as they came, even next to a recipient without address", () => {
    const list = [{ error: "x" }];
    assert.equal(api.withRecipientWarning(null, "Frank Osei"), null);
    assert.equal(api.withRecipientWarning(undefined, "Frank Osei"), undefined);
    assert.equal(api.withRecipientWarning("sent", "Frank Osei"), "sent");
    assert.equal(api.withRecipientWarning(list, "Frank Osei"), list);
    assert.equal(api.withRecipientWarning({ success: true }, "a@x.test").warning, undefined);
  });
});

describe("dryRunComposeResult with a partial description", () => {
  it("sizes a message without body size and attachment list from its header block and the fixed overhead alone", () => {
    const result = plain(api.dryRunComposeResult({ to: "a@x.test" }));
    // "\na@x.test\n\n\n\n" is 13 bytes, plus 400 bytes of other headers
    assert.equal(result.estimatedBytes, 413);
    assert.deepEqual(Object.keys(result).sort(), ["dryRun", "estimatedBytes", "note", "to", "wouldSucceed"]);
  });

  it("counts an attachment of unknown size for its MIME part headers only", () => {
    const result = plain(api.dryRunComposeResult({ to: "a@x.test", attachments: [{ name: "a.txt" }] }));
    assert.equal(result.estimatedBytes, 413 + 300);
    assert.deepEqual(result.attachments, [{ name: "a.txt" }]);
  });
});

describe("clampHeaderValue", () => {
  it("cuts a header value of more than 2000 characters and says so", () => {
    assert.equal(api.clampHeaderValue("a".repeat(2000)), "a".repeat(2000));
    assert.equal(api.clampHeaderValue("a".repeat(2001)), `${"a".repeat(2000)}... (truncated)`);
  });
});

describe("List-Unsubscribe corner cases", () => {
  it("never takes a host that is one of the local special-use names itself", () => {
    assert.equal(api.isUnsubscribeHostAllowed("home.arpa"), false);
    assert.equal(api.isUnsubscribeHostAllowed("HOME.ARPA"), false);
    assert.equal(api.isUnsubscribeHostAllowed("printer.home.arpa"), false);
    assert.equal(api.isUnsubscribeHostAllowed("lists.example.com"), true);
    assert.deepEqual(plain(api.parseListUnsubscribe("<https://home.arpa/unsub>")), { mailto: [], https: [], oneClick: false, ignored: 1 });
  });

  it("reads a mailto query field without a value, and keeps the fields it knows", () => {
    assert.deepEqual(plain(api.parseListUnsubscribe("<mailto:unsub@list.test?unsubscribe&subject=Bye&body=Please>")).mailto,
      [{ address: "unsub@list.test", subject: "Bye", body: "Please" }]);
    // a field name that is not valid percent-encoding is passed over, the others still count
    assert.deepEqual(plain(api.parseListUnsubscribe("<mailto:unsub@list.test?%E0%A4%A&subject=Bye>")).mailto,
      [{ address: "unsub@list.test", subject: "Bye" }]);
  });

  it("lists an address once, whether it comes from the path or from to=, whatever its case", () => {
    assert.deepEqual(plain(api.parseListUnsubscribe("<mailto:a@list.test?to=A@List.test,b@list.test>")).mailto,
      [{ address: "a@list.test" }, { address: "b@list.test" }]);
  });

  it("stops at five mailto addresses even when one URI holds more", () => {
    const addresses = Array.from({ length: 7 }, (_, i) => `a${i + 1}@list.test`);
    const parsed = plain(api.parseListUnsubscribe(`<mailto:${addresses.join(",")}>`));
    assert.deepEqual(parsed.mailto.map(m => m.address), addresses.slice(0, 5));
  });
});

describe("removeDuplicateMailboxes and computeReplyRecipients with missing parts", () => {
  const mb = (email, name = "") => ({ name, email });
  const emails = list => list.map(m => m.email).join(", ");

  it("takes entries without an address (a group, undisclosed-recipients) for one and the same entry", () => {
    const list = api.removeDuplicateMailboxes([{ name: "Undisclosed" }, mb("a@x.test"), { name: "Other group" }, null]);
    assert.deepEqual(plain(list), [{ name: "Undisclosed" }, mb("a@x.test")]);
  });

  it("is not a reply to self without a From, and without own addresses", () => {
    const noFrom = api.computeReplyRecipients({ to: [mb("me@home.test")], cc: [] }, { ownEmails: ["me@home.test"], senderEmail: "me@home.test" }, false);
    assert.equal(noFrom.replyToSelf, false);
    assert.deepEqual(plain(noFrom.to), []);
    const noOwn = api.computeReplyRecipients({ from: [mb("me@home.test")], to: [mb("bob@x.test")] }, { senderEmail: "me@home.test" }, false);
    assert.equal(noOwn.replyToSelf, false);
    assert.equal(emails(noOwn.to), "me@home.test");
  });

  it("works without a sending identity: nothing is removed from the recipients as the sender", () => {
    const r = api.computeReplyRecipients({ from: [mb("alice@acme.test")], to: [mb("bob@x.test")], cc: [mb("carol@x.test")] }, { ownEmails: [] }, true);
    assert.equal(emails(r.to), "alice@acme.test, bob@x.test");
    assert.equal(emails(r.cc), "carol@x.test");
  });

  it("finds the list in a Reply-To written without a name or without an address", () => {
    const original = { from: [mb("alice@acme.test")], to: [mb("list@lists.test")], listPost: "list@lists.test" };
    const bare = api.computeReplyRecipients({ ...original, replyTo: [{ email: "list@lists.test" }] }, { ownEmails: [], senderEmail: "me@home.test", overrideListReplyTo: true }, false);
    assert.equal(emails(bare.to), "alice@acme.test");
    // an entry without address cannot be the list: the Reply-To stays
    const nameOnly = api.computeReplyRecipients({ ...original, replyTo: [{ name: "Support" }] }, { ownEmails: [], senderEmail: "me@home.test", overrideListReplyTo: true }, false);
    assert.deepEqual(plain(nameOnly.to), [{ name: "Support" }]);
  });
});

describe("switchIdentityRecipients when only one side has a value", () => {
  const parse = header => String(header || "").split(",").map(s => s.trim()).filter(Boolean).map(email => ({ name: "", email }));
  const run = (fields, prev, next) => {
    const out = api.switchIdentityRecipients({ to: [], cc: [], bcc: [], replyTo: [], ...fields }, { replyTo: "", cc: "", bcc: "", ...prev }, { replyTo: "", cc: "", bcc: "", ...next }, parse);
    return Object.fromEntries(Object.entries(out).map(([key, list]) => [key, list.map(m => m.email).join(", ")]));
  };

  it("only adds a Reply-To when the old identity had none, only removes one when the new has none", () => {
    assert.equal(run({}, {}, { replyTo: "desk@me.test" }).replyTo, "desk@me.test");
    assert.equal(run({ replyTo: parse("desk@me.test") }, { replyTo: "desk@me.test" }, {}).replyTo, "");
  });

  it("leaves the Cc alone when the auto Cc is the same, and does not look for an old auto Cc that is not set", () => {
    const same = run({ cc: parse("boss@me.test, c@x.test") }, { cc: "boss@me.test" }, { cc: "boss@me.test" });
    assert.equal(same.cc, "boss@me.test, c@x.test");
    assert.equal(run({ cc: parse("c@x.test") }, {}, { cc: "boss@me.test" }).cc, "c@x.test, boss@me.test");
  });

  it("removes an entry only when name and address are both the same", () => {
    const fields = { cc: [{ name: "Other", email: "boss@me.test" }, { name: "Boss", email: "boss@me.test" }] };
    const prev = { cc: "boss@me.test" };
    // parse() gives name "" so nothing matches: both stay; the old value is not found, which is not an error
    assert.equal(run(fields, prev, { cc: "" }).cc, "boss@me.test, boss@me.test");
  });
});

describe("buildReplyReferences with empty entries", () => {
  it("passes over empty and missing ids of the chain", () => {
    assert.equal(api.buildReplyReferences(["", null, undefined, "<a@x>", "a@x"], "o@x"), "<a@x> <o@x>");
  });
});

describe("serializedTextReferences at the end of the text", () => {
  const decode = runs => runs.map(run => run.replace(/&#39;/g, "'"));

  it("returns an empty string for a missing html", () => {
    assert.equal(api.serializedTextReferences(null, decode), "");
    assert.equal(api.serializedTextReferences(undefined, decode), "");
  });

  it("does not take <style, <script or <head at the very end for the start of an element, so the text before it is decoded", () => {
    for (const tail of ["<style", "<script", "<head", "<a", "<A"]) {
      assert.equal(api.serializedTextReferences(`&#39;${tail}`, decode), `'${tail}`, tail);
    }
  });
});

describe("cite line without any template", () => {
  it("falls back to a delimiter line even when the original-message string is empty too", () => {
    assert.equal(api.buildCitePrefix(1, { authorWrote: "" }, { author: "A" }), "\n\n\n");
  });
});

describe("a missing text is an empty text", () => {
  it("for the helpers that read a quote or a forwarded message", () => {
    assert.equal(api.stripDocumentTags(null), "");
    assert.equal(api.plainTextToForwardHtml(undefined), "");
    assert.equal(api.forwardPlainText("-- delimiter --", [], undefined), "\n\n-- delimiter --\n\n");
    assert.equal(api.joinFlowedLines(undefined), "");
    assert.equal(api.replaceFileURLs(null, () => "data:x"), "");
    assert.equal(api.removeQueryPart(undefined), "");
    assert.equal(api.tagEmbeddedObjects(undefined, () => false), "");
    assert.equal(api.serializerMetaCharset(null), "");
  });

  it("removeQueryPart leaves a path without query alone and still cuts at /;", () => {
    assert.equal(api.removeQueryPart("/Inbox"), "/Inbox");
    assert.equal(api.removeQueryPart("/Inbox/;section=1.2"), "/Inbox");
  });
});

describe("plainTextToForwardHtml, quotes and signature", () => {
  it("keeps a signature that starts the text, and the space before the line break is its own", () => {
    assert.equal(api.plainTextToForwardHtml("-- \nSig\n"), '<pre class="moz-signature">-- <br>Sig<br></pre>');
  });

  it("opens a quotation at its marker without a space after it, when the text is not flowed", () => {
    assert.equal(api.plainTextToForwardHtml(">q\n"), '<blockquote type="cite"><pre wrap class="moz-quote-pre">q<br></pre></blockquote>');
    assert.equal(api.plainTextToForwardHtml("> a\n"), '<blockquote type="cite"><pre wrap class="moz-quote-pre">a<br></pre></blockquote>');
  });

  it("flowed quotations are plain blockquotes and a trailing space is the soft break", () => {
    assert.equal(api.plainTextToForwardHtml("> q \n> r\n"), '<blockquote type="cite">q r<br></blockquote>');
    // the text ends inside the quotation, which is closed
    assert.equal(api.plainTextToForwardHtml("> a \n"), '<blockquote type="cite">a </blockquote>');
    // and a line without a marker closes it
    assert.equal(api.plainTextToForwardHtml("> a \n\nb"), '<blockquote type="cite">a </blockquote><br>b');
  });

  it("ends the signature before a quotation that comes after it", () => {
    assert.equal(api.plainTextToForwardHtml("x\n-- \nsig\n> quoted\n"),
      'x<br><pre class="moz-signature">-- <br>sig<br></pre><blockquote type="cite"><pre wrap class="moz-quote-pre">quoted<br></pre></blockquote>');
  });
});

describe("frameImageSignature separators", () => {
  const o = { replyOnTop: 0, sigBottom: true, quoted: true, suppressSigSep: false, paragraphMode: false };
  const framed = extra => api.frameImageSignature("data:image/png;base64,AA", { ...o, ...extra });
  const img = "<br><img src='data:image/png;base64,AA' border=0></div>";

  it("writes the separator under the quote, and in a message without quote or at the bottom", () => {
    assert.equal(framed({}), `<br><div class="moz-signature">-- ${img}`);
    assert.equal(framed({ replyOnTop: 1, sigBottom: true }), `<br><div class="moz-signature">-- ${img}`);
    assert.equal(framed({ replyOnTop: 1, sigBottom: false, quoted: false }), `<br><div class="moz-signature">-- ${img}`);
  });

  it("drops the separator above a quote, and whenever the identity suppresses it", () => {
    assert.equal(framed({ replyOnTop: 1, sigBottom: false, quoted: true }), `<br><div class="moz-signature">${img}`);
    assert.equal(framed({ suppressSigSep: true }), `<br><div class="moz-signature">${img}`);
  });

  it("starts with <br> unless the editor is in paragraph mode", () => {
    assert.ok(framed({}).startsWith("<br><div"));
    assert.ok(framed({ paragraphMode: true }).startsWith("<div"));
  });
});

describe("tagEmbeddedObjects on tags that end with the text", () => {
  it("leaves a tag without its end as it is, whatever opens inside it", () => {
    assert.equal(api.tagEmbeddedObjects('<a href="x" ', () => false), '<a href="x" ');
    assert.equal(api.tagEmbeddedObjects("<img src=x", () => false), "<img src=x");
    assert.equal(api.tagEmbeddedObjects("<a title='x", () => false), "<a title='x");
    // the tag after one that never ends is still tagged
    assert.equal(api.tagEmbeddedObjects('<a title="x <img src=y>', () => false), '<a title="x <img src=y moz-do-not-send="true">');
  });
});

describe("compose layout, empty parts", () => {
  const prefs = (replyOnTop, sigBottom, paragraphMode, sigAboveQuote = false) => ({ replyOnTop, sigBottom, paragraphMode, sigAboveQuote });
  const text = hunks => plain(hunks);

  it("an HTML forward with nothing after the typed text drops the line break that only ended the line", () => {
    assert.equal(api.layoutComposeHtml("forward", { user: "Hi", forward: "", signature: "" }, prefs(0, true, false)), "Hi");
  });

  it("an HTML quote without a message id has no cite attribute", () => {
    assert.equal(api.layoutComposeHtml("reply", { prefix: "", quote: "Q", user: "Hi" }, prefs(0, true, false)), '<blockquote type="cite">Q</blockquote>Hi');
    assert.equal(api.layoutComposeHtml("reply", { prefix: "", quote: "Q", user: "Hi", citeRef: "mid:a&b" }, prefs(0, true, false)),
      '<blockquote type="cite" cite="mid:a&amp;b">Q</blockquote>Hi');
  });

  it("a plain forward without text of the original keeps only what is typed", () => {
    assert.deepEqual(text(api.layoutComposeText("forward", { user: "Hi" }, prefs(0, true))), [{ text: "Hi" }, { text: "\n" }]);
  });

  it("a plain reply may have a quote without a cite line, or a cite line without a quote", () => {
    assert.deepEqual(text(api.layoutComposeText("reply", { quote: "q", user: "Hi" }, prefs(0, true))),
      [{ text: "> q\n", quotes: true }, { text: "Hi" }, { text: "\n" }]);
    // no quote: the caret stays on top, with no break before the cite line unless the reply goes on top
    assert.deepEqual(text(api.layoutComposeText("reply", { prefix: "P wrote:", user: "Hi" }, prefs(0, true))), [{ text: "Hi" }, { text: "P wrote:\n" }]);
    assert.deepEqual(text(api.layoutComposeText("reply", { prefix: "P wrote:", user: "Hi" }, prefs(1, true))), [{ text: "Hi" }, { text: "\n\n" }, { text: "P wrote:\n" }]);
  });

  it("a plain reply with neither cite line nor quote is the user's text and the signature", () => {
    assert.deepEqual(text(api.layoutComposeText("reply", { user: "Hi", signature: "-- \nS\n" }, prefs(0, true))), [{ text: "Hi" }, { text: "\n-- \nS\n" }]);
  });
});

describe("blocks of an HTML draft", () => {
  const body = inner => `<html><body>${inner}</body></html>`;

  it("ignores an end tag that closes nothing", () => {
    const html = body('Hi</div><br><div class="moz-signature">S</div>');
    const p = api.splitDraftBody(html, true);
    assert.equal(p.user, "Hi</div>");
    assert.equal(p.head + p.user + p.tail, html);
  });

  it("takes a forward delimiter above a signature for a forward that ends the body, signature included", () => {
    const html = body('FYI<br><br>-------- Forwarded Message --------<br>Subject: X<br><div class="moz-signature">S</div>');
    const p = api.splitDraftBody(html, true);
    assert.equal(p.user, "FYI");
    assert.ok(p.tail.startsWith("<br><br>-------- Forwarded Message --------"));
    assert.ok(p.tail.endsWith("S</div></body></html>"));
    // as blocks: one forward from the delimiter to the end of the body
    const blocks = plain(api.htmlDraftBlocks(html, html.indexOf("<body>") + 6, html.indexOf("</body>")));
    assert.deepEqual(blocks.map(b => b.kind), ["forward"]);
  });

  it("does not take a delimiter written inside the signature for a forward", () => {
    const html = body('Hi<br><div class="moz-signature">-- <br>-------- Forwarded Message --------</div>');
    const blocks = plain(api.htmlDraftBlocks(html, html.indexOf("<body>") + 6, html.indexOf("</body>")));
    assert.deepEqual(blocks.map(b => b.kind), ["signature"]);
    assert.equal(api.splitDraftBody(html, true).user, "Hi");
  });

  it("keeps the signature above a forward delimiter that comes after it", () => {
    const html = body('Hi<div class="moz-signature">S</div>-------- Original Message --------<br>Text');
    const blocks = plain(api.htmlDraftBlocks(html, html.indexOf("<body>") + 6, html.indexOf("</body>")));
    assert.deepEqual(blocks.map(b => b.kind), ["signature", "forward"]);
  });

  it("finds the user text in a draft that has no body tag", () => {
    assert.deepEqual(plain(api.splitDraftBody("<p>Hi</p>", true)), { head: "", user: "<p>Hi</p>", tail: "", kept: false });
  });

  it("puts the caret after a quote that ends the body, and after the last of several quote blocks", () => {
    const html = body('<div class="moz-cite-prefix">A wrote:<br></div><blockquote type="cite">Q</blockquote>');
    const p = api.splitDraftBody(html, true);
    assert.equal(p.kept, true);
    assert.equal(p.user, "");
    assert.equal(p.head, html.slice(0, html.indexOf("</body>")));
    assert.equal(p.tail, "</body></html>");
  });
});

describe("blocks of a plain draft", () => {
  const check = (text, user, known) => {
    const p = api.splitDraftBody(text, false, known);
    assert.equal(p.head + p.user + p.tail, text);
    assert.equal(p.user, user);
    return p;
  };

  it("a quote on the very first line has no cite line above it", () => {
    const p = check("> Hi\n> there\nThanks\n", "Thanks");
    assert.equal(p.head, "> Hi\n> there\n");
  });

  it("a signature written above a quote ends where the cite line starts", () => {
    const p = check("Mine\n-- \nSig\nOn 1/2/26, A wrote:\n> Hi\n", "Mine");
    assert.ok(p.tail.startsWith("\n-- \nSig\nOn 1/2/26, A wrote:"));
  });

  it("a forward delimiter followed by nothing but blank lines is still a forward", () => {
    const p = check("FYI\n\n-------- Forwarded Message --------\n\n\n", "FYI");
    assert.ok(p.tail.includes("-------- Forwarded Message --------"));
  });

  it("only the first signature separator starts the signature", () => {
    const p = check("A\n-- \nS1\n-- \nS2\n", "A");
    assert.ok(p.tail.includes("S1\n-- \nS2"));
  });

  it("looks for the identity signature from the end of the text and passes over a copy that is not at the start of a line", () => {
    check("Thanks\n\nBench\nUser\n\nPS see Bench\nUser", "Thanks", "Bench\nUser");
  });

  it("finds an identity signature that starts the text", () => {
    const p = check("Bench\nUser\n\nOn 1/2/26, A wrote:\n> Hi\n", "", "Bench\nUser");
    assert.ok(p.kept);
  });

  it("does not take the identity signature inside a block for the signature", () => {
    // written in the forwarded text: no signature of the user, the text before the forward is the user's
    const p = check("FYI\n\n-------- Forwarded Message --------\nBench\nUser\n", "FYI", "Bench\nUser");
    assert.ok(p.tail.includes("Bench\nUser"));
  });

  it("does not look for the identity signature inside a quotation, even one at the very start", () => {
    const p = check("> Bench\nrest\n", "rest", "> Bench");
    assert.equal(p.head, "> Bench\n");
  });

  it("an identity signature found after the last block ends with the text", () => {
    const p = check("Hi\n\nOn 1/2/26, A wrote:\n> Hi\n\nBench\nUser\n", "Hi", "Bench\nUser");
    assert.ok(p.tail.endsWith("> Hi\n\nBench\nUser\n"));
  });

  it("only white space is all separator", () => {
    assert.equal(api.trailingSeparatorLength("  \n \t", false), 5);
    assert.equal(api.trailingSeparatorLength("", false), 0);
    assert.equal(api.trailingSeparatorLength("abc", false), 0);
  });
});

describe("mergeDraftFields on a draft without anything", () => {
  it("fills every missing field with an empty value, and passed values win over the draft", () => {
    assert.deepEqual(plain(api.mergeDraftFields({}, {})), {
      to: "", cc: "", bcc: "", subject: "", body: "", keptAttachments: [], references: "", replyTo: "", priority: "",
    });
    const merged = api.mergeDraftFields({ bcc: "b@x.test", subject: "S", body: "B", to: "t@x.test", cc: "c@x.test" }, { to: "old@x.test", bcc: "oldb@x.test", subject: "Old", body: "Old" });
    assert.equal(merged.bcc, "b@x.test");
    assert.equal(merged.to, "t@x.test");
    assert.equal(merged.subject, "S");
    assert.equal(merged.body, "B");
    assert.equal(merged.isHtml, undefined);
  });
});

describe("draftPriorityName and draftInfoFields on odd values", () => {
  it("reads a name without digit, and nothing as None", () => {
    assert.equal(api.draftPriorityName("highest"), "Highest");
    assert.equal(api.draftPriorityName("NORMAL"), "Normal");
    assert.equal(api.draftPriorityName(undefined), "None");
    assert.equal(api.draftPriorityName(""), "None");
  });

  it("a receipt flag that is not a number is the first header type, a missing one means no receipt", () => {
    assert.deepEqual(plain(api.draftInfoFields("internal/draft; receipt=x; deliveryformat=")), {
      attachVCard: false, returnReceipt: true, DSN: false, attachmentReminder: false, receiptHeaderType: -1, deliveryFormat: 0,
    });
    const none = plain(api.draftInfoFields("internal/draft; vcard=1"));
    assert.equal(none.returnReceipt, false);
    assert.equal("receiptHeaderType" in none, false);
    assert.equal("deliveryFormat" in none, false);
  });
});

describe("STRIP HELPERS", () => {
  const strip = {};
  vm.createContext(strip);
  vm.runInContext(`${slice("// BEGIN STRIP HELPERS", "// END STRIP HELPERS")}
this.stripLeading = stripLeading; this.stripTrailing = stripTrailing; this.C0_AND_SPACE = C0_AND_SPACE;`, strip);

  it("a string made only of the characters to drop becomes empty from either end", () => {
    assert.equal(strip.stripLeading("////", "/"), "");
    assert.equal(strip.stripTrailing("////", "/"), "");
    assert.equal(strip.stripLeading("", "/"), "");
  });

  it("drops only the characters it is given, from the start or from the end", () => {
    assert.equal(strip.stripLeading("__a_b__", "_"), "a_b__");
    assert.equal(strip.stripTrailing("__a_b__", "_"), "__a_b");
    assert.equal(strip.stripLeading("\u0001 \tx ", strip.C0_AND_SPACE), "x ");
    assert.equal(strip.stripTrailing("x \t\u0001", strip.C0_AND_SPACE), "x");
  });
});
