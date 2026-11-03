"use strict";

// sendMail with dryRun reports what the call would do, or the error it would
// return, without sending, saving or opening anything.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function marked(startMarker, endMarker) {
  const start = apiSource.indexOf(startMarker);
  const end = apiSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `marker missing: ${startMarker}`);
  return apiSource.slice(start, end);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  marked("// BEGIN DRY RUN COMPOSE", "// END DRY RUN COMPOSE"),
  "this.utf8ByteLength = utf8ByteLength;",
  "this.estimateMessageBytes = estimateMessageBytes;",
  "this.dryRunComposeResult = dryRunComposeResult;",
].join("\n"), sandbox);

const plain = (v) => JSON.parse(JSON.stringify(v));

describe("utf8ByteLength", () => {
  it("counts UTF-8 bytes", () => {
    assert.equal(sandbox.utf8ByteLength(""), 0);
    assert.equal(sandbox.utf8ByteLength(undefined), 0);
    assert.equal(sandbox.utf8ByteLength("abc"), 3);
    assert.equal(sandbox.utf8ByteLength("é"), 2);
    assert.equal(sandbox.utf8ByteLength("€"), 3);
    assert.equal(sandbox.utf8ByteLength("😀"), 4);
    assert.equal(sandbox.utf8ByteLength("\uD800"), 3);
    assert.equal(sandbox.utf8ByteLength("é😀a"), Buffer.byteLength("é😀a"));
  });
});

describe("estimateMessageBytes", () => {
  it("grows with base64 attachments", () => {
    const none = sandbox.estimateMessageBytes("x", 1000, []);
    const one = sandbox.estimateMessageBytes("x", 1000, [3 * 1024 * 1024]);
    assert.ok(one - none > 4 * 1024 * 1024, "a 3 MiB attachment takes more than 4 MiB in base64");
    assert.ok(one - none < 4.4 * 1024 * 1024);
  });
});

describe("dryRunComposeResult", () => {
  it("reports a refusal without an error field", () => {
    const r = plain(sandbox.dryRunComposeResult({ error: "User preference blocks skipReview." }));
    assert.equal(r.error, undefined);
    assert.equal(r.wouldSucceed, false);
    assert.equal(r.refusal, "User preference blocks skipReview.");
    assert.match(r.note, /Nothing was sent/);
  });

  it("reports what would happen, without empty fields or the body size", () => {
    const r = plain(sandbox.dryRunComposeResult({
      action: "open a review window", from: "a@example.com", identityId: "id1", to: "b@example.com", cc: "",
      bcc: "archive@example.com", replyTo: "", subject: "Hi", format: "plain",
      attachments: [{ name: "a.pdf", size: 10 }], bodyBytes: 5,
    }));
    assert.equal(r.wouldSucceed, true);
    assert.equal(r.bcc, "archive@example.com");
    assert.ok(!("cc" in r) && !("replyTo" in r) && !("bodyBytes" in r));
    assert.ok(r.estimatedBytes > 0);
    assert.equal(r.warning, undefined);
  });

  it("warns above Thunderbird's large-message size", () => {
    const r = plain(sandbox.dryRunComposeResult({ to: "b@example.com", attachments: [{ name: "big", size: 30 * 1024 * 1024 }], bodyBytes: 1 }, 20 * 1024 * 1024));
    assert.match(r.warning, /large-message size/);
  });
});

describe("dryRun wiring", () => {
  const compose = marked("function composeMail(", "function decodeHeaderValue(");

  it("returns before anything is opened or sent", () => {
    const dry = compose.indexOf("if (dryRun) {");
    assert.ok(dry > 0);
    assert.ok(dry < compose.indexOf("sendMessageDirectly("));
    assert.ok(dry < compose.indexOf("OpenComposeWindowWithParams("));
    assert.ok(dry < compose.indexOf("addAttachment("));
  });

  it("writes no decoded attachment in a dry run", () => {
    assert.match(compose, /filePathsToAttachDescs\(attachments, \{ dryRun: !!dryRun \}\)/);
    const convert = marked("function filePathsToAttachDescs(", "function attachmentFailureResult(");
    const dry = convert.indexOf("if (dryRun) {");
    assert.ok(dry > 0 && dry < convert.indexOf("file-output-stream"));
  });

  it("gives a direct send the identity's automatic recipients", () => {
    const direct = compose.slice(compose.indexOf("if (skipReview) {"));
    assert.match(direct, /setDirectSendRecipients\(composeFields, msgComposeParams\.identity, to, cc, bcc\)/);
  });
});
