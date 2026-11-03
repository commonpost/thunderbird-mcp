// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// An attachment that is only a link (X-Mozilla-External-Attachment-URL: a detached
// attachment, a feed enclosure) is never opened: a forward or a rewritten draft
// fails and names it, instead of attaching the file or page the sender chose.

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

const sandbox = {
  Services: {
    io: {
      extractScheme(url) {
        const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
        if (!m) throw new Error("NS_ERROR_MALFORMED_URI");
        return m[1];
      },
    },
  },
};
vm.createContext(sandbox);
vm.runInContext([
  marked("// BEGIN OUTBOUND ATTACHMENT LIMITS", "// END OUTBOUND ATTACHMENT LIMITS"),
  marked("// BEGIN OUTBOUND ATTACHMENT CONVERSION", "// END OUTBOUND ATTACHMENT CONVERSION"),
  "this.isExternalAttachment = isExternalAttachment;",
  "this.storedAttachmentDescs = storedAttachmentDescs;",
].join("\n"), sandbox);

const stored = {
  name: "legit.txt",
  contentType: "text/plain",
  url: "mailbox:///profile/Mail/Local/Inbox?number=4&part=1.2&type=text%2Fplain&filename=legit.txt",
  isExternal: false,
  headers: {},
};

describe("isExternalAttachment", () => {
  it("accepts a part of the stored message", () => {
    assert.equal(sandbox.isExternalAttachment(stored), false);
    assert.equal(sandbox.isExternalAttachment({ ...stored, url: "imap://u@host:993/fetch%3EUID%3E/INBOX%3E7?part=1.2" }), false);
    assert.equal(sandbox.isExternalAttachment({ ...stored, url: "" }), false);
  });

  it("refuses an attachment Thunderbird reports external", () => {
    assert.equal(sandbox.isExternalAttachment({ ...stored, url: "file:///home/u/.ssh/id_ed25519?part=1.2", isExternal: true }), true);
  });

  it("refuses the external header even when isExternal is missing", () => {
    const att = { ...stored, isExternal: undefined, headers: { "x-mozilla-external-attachment-url": ["file:///etc/passwd"] } };
    assert.equal(sandbox.isExternalAttachment(att), true);
  });

  it("refuses any url that cannot name a message part", () => {
    for (const url of ["file:///etc/passwd", "FILE:///C:/Users/u/secret.txt", "https://example.com/x", "http://127.0.0.1:8080/",
                       "data:text/plain,x", "jar:file:///a.zip!/b", "resource://gre/x", "chrome://x/y", "not a url"]) {
      assert.equal(sandbox.isExternalAttachment({ ...stored, isExternal: undefined, url }), true, url);
    }
  });
});

describe("storedAttachmentDescs", () => {
  it("keeps parts of the message and names each external attachment", () => {
    const mimeMsg = { allUserAttachments: [stored, { ...stored, name: "notes.txt", url: "file:///opt/x?part=1.3", isExternal: true }] };
    const { descs, external } = sandbox.storedAttachmentDescs(mimeMsg);
    assert.deepEqual(JSON.parse(JSON.stringify(descs)), [{ url: stored.url, name: "legit.txt", contentType: "text/plain" }]);
    assert.equal(external.length, 1);
    assert.match(external[0], /^"notes\.txt" is only a link/);
  });

  it("returns nothing for a message without attachments", () => {
    const { descs, external } = sandbox.storedAttachmentDescs(null);
    assert.equal(descs.length, 0);
    assert.equal(external.length, 0);
  });
});

describe("isExternalAttachment, whole stored messages", () => {
  it("refuses a url naming a whole stored message", () => {
    for (const url of ["mailbox-message:///profile/Mail/Local/Inbox#4", "imap-message://u@host/INBOX#7", "news-message://h/g#1"]) {
      assert.equal(sandbox.isExternalAttachment({ ...stored, url }), true, url);
    }
  });

  it("accepts news part urls", () => {
    assert.equal(sandbox.isExternalAttachment({ ...stored, url: "news://h:119/abc%40x?part=1.2" }), false);
  });
});

describe("stored attachments are only read through storedAttachmentDescs", () => {
  it("builds no attachment descriptor from att.url anywhere else", () => {
    const helper = marked("function storedAttachmentDescs(", "// END OUTBOUND ATTACHMENT CONVERSION");
    const rest = apiSource.replace(helper, "");
    assert.equal((rest.match(/url:\s*att\.url\b/g) || []).length, 0, "a descriptor is built from att.url outside storedAttachmentDescs");
  });

  it("forwardMessage and the draft rewrite use storedAttachmentDescs", () => {
    const forward = marked("async function forwardMessage(", "function displayMessage(");
    assert.match(forward, /storedAttachmentDescs\(mimeMsg\)/);
    assert.doesNotMatch(forward, /allUserAttachments/);
    const uses = apiSource.match(/= storedAttachmentDescs\(mimeMsg\)/g) || [];
    assert.equal(uses.length, 2);
  });
});
