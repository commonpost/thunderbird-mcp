"use strict";

// searchMessages attachmentName / attachmentType: the filter, the MIME structure walk and the per-call limits.

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

const sandbox = { Uint8Array, TextDecoder, atob: globalThis.atob };
vm.createContext(sandbox);
vm.runInContext(`${[
  "ENCRYPTED MESSAGE HELPERS", "RAW MIME PARSING HELPERS", "RAW MIME ATTACHMENT HELPERS", "ATTACHMENT SEARCH HELPERS",
].map(region).join("\n")}
Object.assign(this, { parseAttachmentFilter, attachmentMatchesFilter, rawMimeParameter, listRawMimeAttachments,
  rawMimeDecodedSize, scanAttachmentCandidates, attachmentSearchSummary, attachmentSearchIncomplete,
  ATTACHMENT_SEARCH_LIMITS, ATTACHMENT_SEARCH_MAX_DEPTH });`, sandbox);
const {
  parseAttachmentFilter, attachmentMatchesFilter, rawMimeParameter, listRawMimeAttachments, rawMimeDecodedSize,
  scanAttachmentCandidates, attachmentSearchSummary, attachmentSearchIncomplete, ATTACHMENT_SEARCH_LIMITS,
  ATTACHMENT_SEARCH_MAX_DEPTH,
} = sandbox;

const plain = value => JSON.parse(JSON.stringify(value));

// RFC 2047 decoding stands in for MailServices.mimeConverter (B encoding, UTF-8 only)
const decodeWord = s => s.replace(/=\?utf-8\?b\?([^?]*)\?=/gi, (_, b64) => Buffer.from(b64, "base64").toString("utf8"));

function mixed(boundary, parts, top = `Content-Type: multipart/mixed; boundary="${boundary}"`) {
  return `From: a@example.test\r\nSubject: s\r\nMIME-Version: 1.0\r\n${top}\r\n\r\npreamble\r\n${parts.map(p => `--${boundary}\r\n${p}\r\n`).join("")}--${boundary}--\r\n`;
}
const text = "Content-Type: text/plain; charset=utf-8\r\n\r\nhello";
const b64 = Buffer.from("x".repeat(1000)).toString("base64").replace(/.{76}/g, "$&\r\n");

describe("parseAttachmentFilter", () => {
  it("is null without attachment options", () => {
    assert.equal(parseAttachmentFilter({ query: "x" }), null);
    assert.equal(parseAttachmentFilter({ attachmentName: null }), null);
  });

  it("lower-cases the name and reads type prefixes", () => {
    assert.deepEqual(plain(parseAttachmentFilter({ attachmentName: " Facture " })), { name: "facture", type: null, typePrefix: false });
    for (const t of ["image", "image/", "image/*", "IMAGE/"]) {
      assert.deepEqual(plain(parseAttachmentFilter({ attachmentType: t })), { name: null, type: "image/", typePrefix: true }, t);
    }
    assert.deepEqual(plain(parseAttachmentFilter({ attachmentType: "Application/PDF" })), { name: null, type: "application/pdf", typePrefix: false });
    assert.deepEqual(plain(parseAttachmentFilter({ attachmentType: "application/vnd.ms-excel" })).type, "application/vnd.ms-excel");
  });

  it("rejects empty, long and malformed values", () => {
    assert.match(parseAttachmentFilter({ attachmentName: "  " }).error, /attachmentName must be a non-empty string/);
    assert.match(parseAttachmentFilter({ attachmentType: "" }).error, /attachmentType must be a non-empty string/);
    assert.match(parseAttachmentFilter({ attachmentName: 5 }).error, /non-empty string/);
    assert.match(parseAttachmentFilter({ attachmentName: "a".repeat(257) }).error, /longer than 256/);
    for (const t of ["*/*", "image/png; x=1", "/pdf", "a b", "image//"]) {
      assert.match(parseAttachmentFilter({ attachmentType: t }).error, /MIME type or prefix/, t);
    }
  });
});

describe("attachmentMatchesFilter", () => {
  const pdf = { name: "Facture-Été.PDF", contentType: "application/pdf" };
  it("matches name substrings in any case and Unicode form", () => {
    assert.equal(attachmentMatchesFilter(pdf, parseAttachmentFilter({ attachmentName: "été.pdf" })), true);
    assert.equal(attachmentMatchesFilter(pdf, parseAttachmentFilter({ attachmentName: "été" })), true);
    assert.equal(attachmentMatchesFilter(pdf, parseAttachmentFilter({ attachmentName: "devis" })), false);
    assert.equal(attachmentMatchesFilter({ name: "", contentType: "message/rfc822" }, parseAttachmentFilter({ attachmentName: "x" })), false);
  });
  it("matches a type exactly or by prefix, and both filters together", () => {
    assert.equal(attachmentMatchesFilter(pdf, parseAttachmentFilter({ attachmentType: "application/pdf" })), true);
    assert.equal(attachmentMatchesFilter(pdf, parseAttachmentFilter({ attachmentType: "application/pd" })), false);
    assert.equal(attachmentMatchesFilter(pdf, parseAttachmentFilter({ attachmentType: "application" })), true);
    assert.equal(attachmentMatchesFilter(pdf, parseAttachmentFilter({ attachmentType: "image/" })), false);
    assert.equal(attachmentMatchesFilter(pdf, parseAttachmentFilter({ attachmentType: "application/pdf", attachmentName: "devis" })), false);
  });
});

describe("rawMimeParameter", () => {
  it("prefers the RFC 2231 extended value", () => {
    assert.deepEqual(plain(rawMimeParameter("attachment; filename=\"plain.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", "filename")), { extended: "résumé.pdf" });
  });
  it("joins continuations in order, encoded and not", () => {
    const value = "attachment; filename*1*=%C3%A9e.pdf; filename*0*=utf-8'fr'ann%C3%A9; filename*2=\"-v2\"";
    assert.deepEqual(plain(rawMimeParameter(value, "filename")), { extended: "annéée.pdf-v2" });
    assert.deepEqual(plain(rawMimeParameter("attachment; filename*0=\"long-\"; filename*1=\"name.txt\"", "filename")), { extended: "long-name.txt" });
  });
  it("returns the plain value and ignores other parameters", () => {
    assert.deepEqual(plain(rawMimeParameter("attachment; size=12; filename=\"a;b.pdf\"", "filename")), { plain: "a;b.pdf" });
    assert.deepEqual(plain(rawMimeParameter("attachment; filenames=x", "filename")), { plain: "" });
  });
});

describe("rawMimeDecodedSize", () => {
  it("estimates the decoded size without decoding", () => {
    assert.equal(rawMimeDecodedSize(b64, "base64"), 1000);
    assert.equal(rawMimeDecodedSize("TWE=", "base64"), 2);
    assert.equal(rawMimeDecodedSize("caf=C3=A9 =\r\nok", "quoted-printable"), Buffer.from("café ok").length);
    assert.equal(rawMimeDecodedSize("abc", ""), 3);
    assert.equal(rawMimeDecodedSize("abc", "x-uuencode"), null);
  });
});

describe("listRawMimeAttachments", () => {
  it("lists attachments with filename, filename*, name and RFC 2047 forms", () => {
    const raw = mixed("b1", [
      text,
      `Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="Facture 42.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}`,
      `Content-Type: application/pdf\r\nContent-Disposition: attachment;\r\n filename*=UTF-8''r%C3%A9sum%C3%A9.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nTWE=`,
      `Content-Type: image/png; name="=?UTF-8?B?${Buffer.from("photo-été.png").toString("base64")}?="\r\nContent-Transfer-Encoding: base64\r\n\r\nTWFu`,
      "Content-Type: text/csv\r\nContent-Disposition: inline; filename=\"data.csv\"\r\n\r\na,b",
      "Content-Type: text/plain\r\nContent-Disposition: inline\r\n\r\nnot an attachment",
    ]);
    const listed = plain(listRawMimeAttachments(raw, decodeWord));
    assert.equal(listed.encrypted, false);
    assert.equal(listed.limited, false);
    assert.deepEqual(listed.attachments, [
      { name: "Facture 42.pdf", contentType: "application/pdf", size: 1000 },
      { name: "résumé.pdf", contentType: "application/pdf", size: 2 },
      { name: "photo-été.png", contentType: "image/png", size: 3 },
      { name: "data.csv", contentType: "text/csv", size: 3 },
    ]);
  });

  it("decodes a raw UTF-8 filename (RFC 6532)", () => {
    const raw = mixed("b", [text, `Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="${Buffer.from("reçu.pdf").toString("latin1")}"\r\n\r\nx`]);
    assert.equal(listRawMimeAttachments(raw, decodeWord).attachments[0].name, "reçu.pdf");
  });

  it("lists an attached message and the attachments inside it", () => {
    const inner = mixed("in", [text, `Content-Type: image/jpeg\r\nContent-Disposition: attachment; filename="inner.jpg"\r\nContent-Transfer-Encoding: base64\r\n\r\nTWFu`]);
    const raw = mixed("out", [text, `Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename="fwd.eml"\r\n\r\n${inner}`]);
    const listed = plain(listRawMimeAttachments(raw, decodeWord));
    assert.deepEqual(listed.attachments.map(a => [a.name, a.contentType, !!a.inAttachedMessage]), [
      ["fwd.eml", "message/rfc822", false],
      ["inner.jpg", "image/jpeg", true],
    ]);
    // A base64-encoded attached message is read too
    const encoded = mixed("out", [text, `Content-Type: message/rfc822\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(inner).toString("base64")}`]);
    assert.deepEqual(plain(listRawMimeAttachments(encoded, decodeWord).attachments.map(a => a.name)), ["", "inner.jpg"]);
  });

  it("flags encrypted parts, at the top and nested in an attached message", () => {
    const pgp = mixed("enc", [
      "Content-Type: application/pgp-encrypted\r\nContent-Description: PGP/MIME version identification\r\n\r\nVersion: 1",
      "Content-Type: application/octet-stream; name=\"encrypted.asc\"\r\nContent-Disposition: inline; filename=\"encrypted.asc\"\r\n\r\n-----BEGIN PGP MESSAGE-----",
    ], 'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc"');
    assert.equal(listRawMimeAttachments(pgp, decodeWord).encrypted, true);
    const wrapped = mixed("out", [text, `Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename="secret.eml"\r\n\r\n${pgp}`]);
    assert.equal(listRawMimeAttachments(wrapped, decodeWord).encrypted, true);
    const smime = "Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\nMIAG";
    assert.equal(listRawMimeAttachments(smime, decodeWord).encrypted, true);
  });

  it("reports a single-part attachment message and a message without attachments", () => {
    const single = "Content-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"only.pdf\"\r\n\r\nx";
    assert.deepEqual(plain(listRawMimeAttachments(single, decodeWord).attachments), [{ name: "only.pdf", contentType: "application/pdf", size: 1 }]);
    assert.deepEqual(plain(listRawMimeAttachments(mixed("b", [text]), decodeWord).attachments), []);
    assert.equal(listRawMimeAttachments("no header split", decodeWord), null);
  });

  it("marks the walk limited past the depth limit", () => {
    let raw = `Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="deep.pdf"\r\n\r\nx`;
    for (let i = 0; i <= ATTACHMENT_SEARCH_MAX_DEPTH + 1; i++) {
      raw = `Content-Type: multipart/mixed; boundary="d${i}"\r\n\r\n--d${i}\r\n${raw}\r\n--d${i}--\r\n`;
    }
    assert.equal(listRawMimeAttachments(raw, decodeWord).limited, true);
  });

  it("marks the walk limited past the part limit", () => {
    const parts = Array.from({ length: 1001 }, (_, i) => `Content-Type: image/png\r\nContent-Disposition: attachment; filename="p${i}.png"\r\n\r\nx`);
    assert.equal(listRawMimeAttachments(mixed("many", parts), decodeWord).limited, true);
  });
});

describe("scanAttachmentCandidates", () => {
  const filter = parseAttachmentFilter({ attachmentType: "application/pdf" });
  const limits = { ...ATTACHMENT_SEARCH_LIMITS, pauseMessages: 2 };
  const pdfResult = { attachments: [{ name: "a.pdf", contentType: "application/pdf" }, { name: "b.png", contentType: "image/png" }], bytes: 10 };

  it("keeps the matching attachments and counts every candidate once", async () => {
    const results = [pdfResult, { attachments: [{ name: "c.png", contentType: "image/png" }], bytes: 5 }, { skip: "encrypted", bytes: 3 },
      { skip: "tooLarge" }, { skip: "notOffline" }, null];
    let pauses = 0;
    const scan = await scanAttachmentCandidates(results.map((_, i) => i), filter, i => {
      if (i === 5) throw new Error("gone");
      return results[i];
    }, limits, async () => { pauses++; });
    assert.deepEqual(plain(scan.matches), [{ candidate: 0, attachments: [{ name: "a.pdf", contentType: "application/pdf" }] }]);
    assert.equal(scan.checked, 2);
    assert.deepEqual(plain(scan.skipped), { encrypted: 1, tooLarge: 1, notOffline: 1, unreadable: 1 });
    assert.equal(scan.limitReached, false);
    assert.equal(pauses, 3);
  });

  it("stops at the candidate limit and counts the rest", async () => {
    let calls = 0;
    const scan = await scanAttachmentCandidates(Array.from({ length: 7 }, (_, i) => i), filter, () => { calls++; return pdfResult; },
      { ...limits, maxCandidates: 3 }, null);
    assert.equal(calls, 3);
    assert.equal(scan.checked, 3);
    assert.deepEqual(plain(scan.skipped), { limitReached: 4 });
    assert.equal(scan.limitReached, true);
    assert.equal(scan.checked + Object.values(scan.skipped).reduce((a, b) => a + b, 0), 7);
  });

  it("stops at the total byte budget and at the time limit", async () => {
    const big = { attachments: [], bytes: 60 };
    const byBytes = await scanAttachmentCandidates([1, 2, 3, 4], filter, () => big, { ...limits, maxTotalBytes: 100 }, null);
    assert.equal(byBytes.checked, 2);
    assert.deepEqual(plain(byBytes.skipped), { limitReached: 2 });
    let t = 0;
    const byTime = await scanAttachmentCandidates([1, 2, 3], filter, () => { t += 15; return big; }, { ...limits, maxMs: 20 }, null, () => t);
    assert.equal(byTime.checked, 2);
    assert.deepEqual(plain(byTime.skipped), { limitReached: 1 });
  });

  it("passes the per-message byte limit to inspect", async () => {
    let seen;
    await scanAttachmentCandidates([1], filter, (_, max) => { seen = max; return pdfResult; }, limits, null);
    assert.equal(seen, 16 * 1024 * 1024);
    assert.equal(ATTACHMENT_SEARCH_LIMITS.maxCandidates, 500);
  });
});

describe("attachmentSearchSummary", () => {
  const scan = { checked: 4, skipped: { encrypted: 2, tooLarge: 1, limitReached: 3 }, limitReached: true };
  it("reports the counts and the limit", () => {
    assert.deepEqual(plain(attachmentSearchSummary(scan, { collectionCapped: false, hideEncryptedCounts: false })),
      { checked: 4, skipped: { encrypted: 2, tooLarge: 1, limitReached: 3 }, limitReached: true });
    assert.deepEqual(plain(attachmentSearchSummary({ checked: 1, skipped: {}, limitReached: false }, { collectionCapped: false })), { checked: 1 });
    assert.deepEqual(plain(attachmentSearchSummary({ checked: 1, skipped: {}, limitReached: false }, { collectionCapped: true })), { checked: 1, limitReached: true });
  });
  it("leaves out the counts that could include encrypted messages a query matched", () => {
    assert.deepEqual(plain(attachmentSearchSummary(scan, { collectionCapped: false, hideEncryptedCounts: true })),
      { checked: 4, skipped: { tooLarge: 1 }, limitReached: true });
  });
  it("calls a search incomplete only for skips other than encryption", () => {
    assert.equal(attachmentSearchIncomplete({ skipped: { encrypted: 3 } }, false), false);
    assert.equal(attachmentSearchIncomplete({ skipped: { encrypted: 3 } }, true), true);
    for (const reason of ["tooLarge", "notOffline", "unreadable", "limitReached"]) {
      assert.equal(attachmentSearchIncomplete({ skipped: { [reason]: 1 } }, false), true, reason);
    }
  });
});
