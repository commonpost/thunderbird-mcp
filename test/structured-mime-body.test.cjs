"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadExtractFormattedBody() {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const start = source.indexOf("function extractBodyContent(");
  const end = source.indexOf("function formatBodyHtml(", start);
  assert.ok(start >= 0, "extractBodyContent start marker missing");
  assert.ok(end > start, "extractFormattedBody end marker missing");

  const sandbox = {
    htmlToMarkdown: html => `markdown:${html}`,
    // Remove tags until none are left (same loop as the real helpers; a single pass is
    // flagged by code scanning as incomplete multi-character sanitization).
    stripHtml: html => {
      let previous;
      do {
        previous = html;
        html = html.replace(/<[^>]*>/g, "");
      } while (html !== previous);
      return html;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source.slice(start, end)}
this.extractFormattedBody = extractFormattedBody;`,
    sandbox
  );
  return sandbox.extractFormattedBody;
}

const extractFormattedBody = loadExtractFormattedBody();

function assertBody(result, body, bodyIsHtml) {
  assert.equal(result.body, body);
  assert.equal(result.bodyIsHtml, bodyIsHtml);
}

describe("structured MIME body extraction", () => {
  it("selects the requested multipart/alternative representation", () => {
    const message = {
      contentType: "multipart/alternative",
      parts: [
        { contentType: "text/plain; charset=utf-8", body: "Plain version" },
        { contentType: "text/html; charset=utf-8", body: "<p>HTML version</p>" },
      ],
    };

    assertBody(extractFormattedBody(message, "text"), "Plain version", false);
    assertBody(extractFormattedBody(message, "html"), "<p>HTML version</p>", true);
    assertBody(
      extractFormattedBody(message, "markdown"),
      "markdown:<p>HTML version</p>",
      false
    );
  });

  it("preserves message order outside multipart/alternative", () => {
    const message = {
      contentType: "multipart/mixed",
      parts: [
        { contentType: "text/html", body: "<p>First body</p>" },
        { contentType: "text/plain", body: "Later body" },
      ],
    };

    assertBody(extractFormattedBody(message, "text"), "First body", false);
  });

  it("concatenates every HTML part of the chosen alternative branch, skipping an inline attachment (Apple Mail)", () => {
    // alternative[ plain(full text), mixed[ html part 1, inline PDF, html part 2 ] ]
    // Requesting html/markdown must not silently drop html part 2 after the PDF.
    const message = {
      contentType: "multipart/alternative",
      parts: [
        { contentType: "text/plain", body: "Full plain-text version, complete." },
        {
          contentType: "multipart/mixed",
          parts: [
            { contentType: "text/html", body: "<p>Part one.</p>" },
            { contentType: "application/pdf" }, // no .body: an attachment, not inline text
            { contentType: "text/html", body: "<p>Part two.</p>" },
          ],
        },
      ],
    };

    assertBody(
      extractFormattedBody(message, "html"),
      "<p>Part one.</p><p>Part two.</p>",
      true
    );
    assertBody(
      extractFormattedBody(message, "markdown"),
      "markdown:<p>Part one.</p><p>Part two.</p>",
      false
    );
    // Requesting text still gets the complete plain-text alternative, untouched.
    assertBody(extractFormattedBody(message, "text"), "Full plain-text version, complete.", false);
  });

  it("excludes a text/plain attachment (e.g. a .txt file) from the body, in markdown/html", () => {
    // "markdown"/"html" always go through extractBodyContent, the function
    // that checks allUserAttachments -- unlike "text" below, which only
    // reaches it as a fallback (see the next test).
    const message = {
      contentType: "multipart/mixed",
      allUserAttachments: [{ partName: "1.2", name: "notes.txt", contentType: "text/plain" }],
      parts: [
        { contentType: "text/plain", body: "This is the real message body." },
        { partName: "1.2", contentType: "text/plain", body: "Contents of the attached notes.txt file." },
      ],
    };
    const result = extractFormattedBody(message, "markdown");
    assert.equal(result.body, "This is the real message body.");
    assert.doesNotMatch(result.body, /notes\.txt|attached notes/);
  });

  it("known limitation: a real message's coerceBodyToPlaintext (bodyFormat text) is not checked against allUserAttachments", () => {
    // extractPlainTextBody tries aMimeMsg.coerceBodyToPlaintext() first, an
    // XPCOM method this project does not reimplement or filter; it only falls
    // back to extractBodyContent (which IS attachment-aware) when that method
    // is absent or throws. A real Thunderbird MimeMessage always has it, so
    // "text" output (and the plain-text quoting used by reply/forward) is not
    // covered by the allUserAttachments exclusion above -- this is not a
    // regression from main, which never excluded attachments either.
    const message = {
      allUserAttachments: [{ partName: "1.2", name: "notes.txt", contentType: "text/plain" }],
      coerceBodyToPlaintext: () => "This is the real message body.\n\nContents of the attached notes.txt file.",
      contentType: "multipart/mixed",
      parts: [
        { contentType: "text/plain", body: "This is the real message body." },
        { partName: "1.2", contentType: "text/plain", body: "Contents of the attached notes.txt file." },
      ],
    };
    const result = extractFormattedBody(message, "text");
    assert.match(result.body, /Contents of the attached notes\.txt file/);
  });

  it("falls back to the plain-text alternative when none of the branches has HTML", () => {
    const message = {
      contentType: "multipart/alternative",
      parts: [
        { contentType: "text/plain", body: "Only a plain-text version exists." },
      ],
    };

    assertBody(extractFormattedBody(message, "html"), "Only a plain-text version exists.", false);
    assertBody(extractFormattedBody(message, "markdown"), "Only a plain-text version exists.", false);
  });
});
