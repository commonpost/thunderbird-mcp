// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The inline image helpers on missing, malformed and duplicate input: what is normalized, correlated, referenced
// by the body, ordered and refused, and how the extra content blocks ride along a tool result.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
function region(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} missing`);
  return source.slice(start, end);
}

const sandbox = { btoa: globalThis.btoa };
vm.createContext(sandbox);
vm.runInContext(`${["STRIP HELPERS", "INLINE IMAGE CONTENT HELPERS", "UNTRUSTED CONTENT HELPERS"].map(region).join("\n")}
Object.assign(this, { normalizeInlineImageMimeType, normalizeInlineImageContentId, correlateInlineImageRecords,
  getInlineImageContentIdReferences, orderInlineImageRecordsForBody, getBase64EncodedSize, getInlineImageSkipReason,
  encodeByteStringToBase64, setExtraMcpContentBlocks, buildToolResultContent, MAX_INLINE_IMAGE_BASE64_BYTES,
  MAX_INLINE_IMAGES_TOTAL_BASE64_BYTES });`, sandbox);
const {
  normalizeInlineImageMimeType, normalizeInlineImageContentId, correlateInlineImageRecords, getInlineImageContentIdReferences,
  orderInlineImageRecordsForBody, getBase64EncodedSize, getInlineImageSkipReason, encodeByteStringToBase64,
  setExtraMcpContentBlocks, buildToolResultContent, MAX_INLINE_IMAGE_BASE64_BYTES, MAX_INLINE_IMAGES_TOTAL_BASE64_BYTES,
} = sandbox;

const plain = value => JSON.parse(JSON.stringify(value));

describe("normalizeInlineImageMimeType", () => {
  it("drops the parameters, the blanks and the case", () => {
    assert.equal(normalizeInlineImageMimeType("  Image/PNG ; name=x.png"), "image/png");
  });

  it("reads a missing or parameter-only type as empty", () => {
    for (const value of [undefined, null, "", 0, ";name=x", "  "]) {
      assert.equal(normalizeInlineImageMimeType(value), "", String(value));
    }
  });
});

describe("normalizeInlineImageContentId", () => {
  it("drops cid:, the angle brackets and the case, whatever their combination", () => {
    assert.equal(normalizeInlineImageContentId("CID: <Logo@Example.Test> "), "logo@example.test");
    assert.equal(normalizeInlineImageContentId("<<logo@x>>"), "logo@x");
    assert.equal(normalizeInlineImageContentId(undefined), "");
    assert.equal(normalizeInlineImageContentId("cid:"), "");
  });

  it("decodes percent escapes, and keeps a malformed escape as written", () => {
    assert.equal(normalizeInlineImageContentId("cid:a%40B.example"), "a@b.example");
    assert.equal(normalizeInlineImageContentId("cid:100%ZZ@x"), "100%zz@x");
    assert.equal(normalizeInlineImageContentId("%E0%A4%A"), "%e0%a4%a");
  });
});

describe("correlateInlineImageRecords", () => {
  it("returns empty lists for input that is not a list", () => {
    for (const value of [undefined, null, "x", {}]) {
      const result = correlateInlineImageRecords(value, value);
      assert.deepEqual(plain(result), { metadataEntries: [], inlineImageEntries: [] });
    }
  });

  it("adds an image Thunderbird does not list as its own metadata entry", () => {
    const known = { contentId: "known@x", partName: "1.2", info: { name: "known.png" } };
    const unknown = { contentId: "other@x", partName: "1.3", name: "other.png" };
    const result = correlateInlineImageRecords([known], [unknown]);
    assert.equal(result.metadataEntries.length, 2);
    assert.strictEqual(result.metadataEntries[0], known);
    assert.strictEqual(result.metadataEntries[1], unknown);
    const entry = result.inlineImageEntries[0];
    assert.strictEqual(entry.metadataRecord, unknown);
    assert.equal(entry.metadataIndex, 1);
    assert.equal(entry.matchedKnownAttachment, false);
  });

  it("ignores an image that repeats the Content-ID or the part name of one already taken", () => {
    const first = { contentId: "<A@x>", partName: "1.2" };
    const sameCid = { contentId: "a@X", partName: "1.9" };
    const samePart = { contentId: "", partName: "1.2" };
    const nothing = { contentId: "", partName: "" };
    const other = { contentId: "b@x", partName: "1.3" };
    const result = correlateInlineImageRecords([], [first, sameCid, samePart, nothing, other]);
    assert.deepEqual(Array.from(result.inlineImageEntries, e => e.inlineImage), [first, nothing, other]);
    assert.equal(result.metadataEntries.length, 3);
  });

  it("matches by Content-ID before the part name, and by part name when the Content-ID is missing", () => {
    const byPart = { contentId: "", partName: "1.2", info: {} };
    const byCid = { contentId: "logo@x", partName: "9", info: {} };
    const matched = correlateInlineImageRecords([byPart, byCid], [{ contentId: "LOGO@x", partName: "1.2" }]);
    assert.strictEqual(matched.inlineImageEntries[0].metadataRecord, byCid);
    assert.equal(matched.inlineImageEntries[0].metadataIndex, 1);
    const fallback = correlateInlineImageRecords([byPart, byCid], [{ contentId: "none@x", partName: "1.2" }]);
    assert.strictEqual(fallback.inlineImageEntries[0].metadataRecord, byPart);
    assert.equal(fallback.inlineImageEntries[0].matchedKnownAttachment, true);
  });

  it("matches nothing for an image with neither a Content-ID nor a part name, and tolerates records without them", () => {
    const result = correlateInlineImageRecords([null, {}, { partName: "1.2" }], [{}]);
    assert.equal(result.inlineImageEntries[0].matchedKnownAttachment, false);
    assert.equal(result.metadataEntries.length, 4);
  });
});

describe("getInlineImageContentIdReferences", () => {
  it("lists each CID the body references once, in order, in every spelling", () => {
    const body = '![a](cid:A@x) <img src="CID: <b@x>"> ![again](cid:a@x) ![c](cid:%63@x) <img src=\'cid:d@x\'>';
    assert.deepEqual(plain(getInlineImageContentIdReferences(body)), ["a@x", "b@x", "c@x", "d@x"]);
  });

  it("skips a reference that names nothing, and reads a missing body as having none", () => {
    assert.deepEqual(plain(getInlineImageContentIdReferences("cid:%20 and cid:<>")), []);
    for (const body of [undefined, null, "", 0]) assert.deepEqual(plain(getInlineImageContentIdReferences(body)), [], String(body));
  });
});

describe("orderInlineImageRecordsForBody", () => {
  it("reads input that is not a list as empty", () => {
    for (const value of [undefined, null, "x", {}]) {
      assert.deepEqual(plain(orderInlineImageRecordsForBody(value, "cid:a@x")), []);
    }
  });

  it("orders by a contentId of the record or of its info, and takes every record of a repeated Content-ID", () => {
    const records = [
      { id: "none" },
      { id: "info-b", info: { contentId: "B@x" } },
      { id: "own-a-1", contentId: "a@x", info: { contentId: "ignored@x" } },
      { id: "own-a-2", contentId: "<a@x>" },
      null,
    ];
    const ordered = orderInlineImageRecordsForBody(records, "cid:a@x then cid:b@x");
    assert.deepEqual(Array.from(ordered, r => r && r.id), ["own-a-1", "own-a-2", "info-b", "none", null]);
    assert.deepEqual(Array.from(orderInlineImageRecordsForBody(records, ""), r => r && r.id), ["none", "info-b", "own-a-1", "own-a-2", null]);
  });
});

describe("getBase64EncodedSize and getInlineImageSkipReason", () => {
  it("is zero for a size that is not positive and finite", () => {
    for (const size of [0, -3, NaN, Infinity, undefined, null]) assert.equal(getBase64EncodedSize(size), 0, String(size));
  });

  it("names a missing type, and an unsupported one", () => {
    assert.equal(getInlineImageSkipReason("", 4, 0), 'Unsupported MIME type "(missing)"');
    assert.equal(getInlineImageSkipReason(undefined, 4, 0), 'Unsupported MIME type "(missing)"');
    assert.equal(getInlineImageSkipReason("image/tiff; x=1", 4, 0), 'Unsupported MIME type "image/tiff"');
  });

  it("refuses an encoded size that is empty or not a number", () => {
    for (const size of [0, -1, NaN, Infinity, undefined]) {
      assert.equal(getInlineImageSkipReason("image/png", size, 0), "Image data is empty", String(size));
    }
  });

  it("states the sizes in the limit messages", () => {
    assert.equal(
      getInlineImageSkipReason("image/png", MAX_INLINE_IMAGE_BASE64_BYTES + 4, 0),
      `Image exceeds per-image base64 limit (${MAX_INLINE_IMAGE_BASE64_BYTES + 4} bytes > ${MAX_INLINE_IMAGE_BASE64_BYTES} bytes)`
    );
    assert.equal(
      getInlineImageSkipReason("image/gif", 8, MAX_INLINE_IMAGES_TOTAL_BASE64_BYTES - 4),
      `Image would exceed total base64 limit (${MAX_INLINE_IMAGES_TOTAL_BASE64_BYTES + 4} bytes > ${MAX_INLINE_IMAGES_TOTAL_BASE64_BYTES} bytes)`
    );
  });
});

describe("encodeByteStringToBase64", () => {
  it("encodes nothing for a missing string", () => {
    assert.equal(encodeByteStringToBase64(undefined), "");
    assert.equal(encodeByteStringToBase64(null), "");
    assert.equal(encodeByteStringToBase64(""), "");
  });
});

describe("extra content blocks of a tool result", () => {
  const block = { type: "image", data: "AAAA", mimeType: "image/png" };

  it("leaves a result that is not an object, and an empty or invalid list of blocks, as it is", () => {
    for (const result of [null, undefined, "text", 42]) assert.strictEqual(setExtraMcpContentBlocks(result, [block]), result);
    const result = { id: 1 };
    for (const blocks of [[], null, undefined, "x", { length: 1 }]) {
      assert.strictEqual(setExtraMcpContentBlocks(result, blocks), result);
      assert.equal(Array.from(buildToolResultContent(result)).length, 1);
    }
  });

  it("keeps the blocks out of the JSON, and attaches them after the text, in order", () => {
    const result = { id: 1 };
    const second = { type: "image", data: "BBBB", mimeType: "image/gif" };
    assert.strictEqual(setExtraMcpContentBlocks(result, [block, second]), result);
    assert.equal(JSON.stringify(result), '{"id":1}');
    assert.deepEqual(Object.keys(result), ["id"]);
    const content = Array.from(buildToolResultContent(result));
    assert.equal(content.length, 3);
    assert.strictEqual(content[1], block);
    assert.strictEqual(content[2], second);
    assert.equal(content[0].text, '{"id":1}');
  });

  it("replaces the blocks when they are set again", () => {
    const result = {};
    setExtraMcpContentBlocks(result, [block]);
    setExtraMcpContentBlocks(result, [{ type: "image", data: "CCCC", mimeType: "image/webp" }]);
    const content = Array.from(buildToolResultContent(result));
    assert.equal(content.length, 2);
    assert.equal(content[1].data, "CCCC");
  });

  it("builds a text block for a missing result too", () => {
    assert.equal(Array.from(buildToolResultContent(null))[0].text, "null");
    assert.equal(Array.from(buildToolResultContent(undefined)).length, 1);
  });
});
