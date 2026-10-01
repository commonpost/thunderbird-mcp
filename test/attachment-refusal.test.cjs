"use strict";

// A message with an attachment that cannot be attached is not sent, saved or
// opened: the call fails and names the attachment.

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
  marked("// BEGIN OUTBOUND ATTACHMENT LIMITS", "// END OUTBOUND ATTACHMENT LIMITS"),
  marked("// BEGIN OUTBOUND ATTACHMENT CONVERSION", "// END OUTBOUND ATTACHMENT CONVERSION"),
  "this.attachmentFailureResult = attachmentFailureResult;",
].join("\n"), sandbox);

describe("attachmentFailureResult", () => {
  it("returns null when every attachment was attached", () => {
    assert.equal(sandbox.attachmentFailureResult([], "sent"), null);
    assert.equal(sandbox.attachmentFailureResult(undefined, "sent"), null);
  });

  it("returns an error naming each refused attachment and the action that did not happen", () => {
    const result = sandbox.attachmentFailureResult(["/tmp/a.txt (not a regular file)", "b.pdf"], "sent or opened");
    assert.deepEqual(Object.keys(result), ["error"]);
    assert.match(result.error, /nothing was sent or opened/);
    assert.match(result.error, /a\.txt \(not a regular file\), b\.pdf/);
  });
});

describe("wiring in the compose tools", () => {
  // Each call site converts the attachments, then stops before composing.
  const sites = [...apiSource.matchAll(/filePathsToAttachDescs\(attachments\);\n[ \t]*const attachmentFailure = attachmentFailureResult\(failedPaths, "([^"]+)"\);/g)];

  it("sendMail, saveDraft, replyToMessage and forwardMessage all check the result", () => {
    assert.equal(apiSource.match(/filePathsToAttachDescs\(attachments\)/g).length, 4);
    assert.deepEqual(sites.map((m) => m[1]), ["sent or opened", "saved", "sent or opened", "sent or opened"]);
  });

  it("saveDraft with draftId checks it too, before the draft is read or replaced", () => {
    const i = apiSource.indexOf("async function updateDraft(args)");
    assert.ok(i > 0);
    const fn = apiSource.slice(i, apiSource.indexOf("\n            }\n", i));
    const check = fn.search(/filePathsToAttachDescs\(args\.attachments\);\n[ \t]*const attachmentFailure = attachmentFailureResult\(failedPaths, "changed"\);\n[ \t]*if \(attachmentFailure\) return attachmentFailure;/);
    assert.ok(check > 0);
    assert.ok(check < fn.indexOf("extractBodyContent(mimeMsg, true)"));
    assert.ok(check < fn.indexOf("saveComposeFieldsAsDraft("));
    assert.equal(apiSource.match(/filePathsToAttachDescs\(/g).length, 6, "the definition and five call sites");
  });

  it("no call site reports a partial attachment failure as a success", () => {
    assert.ok(!apiSource.includes("failed to attach"));
  });
});
