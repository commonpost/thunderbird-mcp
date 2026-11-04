// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// searchMessages attachmentName / attachmentType: the raw header parameters, file names, sizes and attached
// messages the structure walk meets, and the candidate scan on the results an inspector can return.

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
  "STRIP HELPERS", "ENCRYPTED MESSAGE HELPERS", "RAW MIME PARSING HELPERS", "RAW MIME ATTACHMENT HELPERS", "ATTACHMENT SEARCH HELPERS",
].map(region).join("\n")}
Object.assign(this, { parseAttachmentFilter, attachmentMatchesFilter, rawMimeParameter, rawMimePartFilename,
  listRawMimeAttachments, rawMimeDecodedSize, scanAttachmentCandidates, ATTACHMENT_SEARCH_LIMITS,
  ATTACHMENT_SEARCH_MAX_DEPTH, ATTACHMENT_SEARCH_MAX_PARTS, parseRawMimeEntity });`, sandbox);
const {
  parseAttachmentFilter, attachmentMatchesFilter, rawMimeParameter, rawMimePartFilename, listRawMimeAttachments,
  rawMimeDecodedSize, scanAttachmentCandidates, ATTACHMENT_SEARCH_LIMITS, ATTACHMENT_SEARCH_MAX_DEPTH,
  ATTACHMENT_SEARCH_MAX_PARTS, parseRawMimeEntity,
} = sandbox;

const plain = value => JSON.parse(JSON.stringify(value));

function mixed(boundary, parts) {
  return `Subject: s\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.map(p => `--${boundary}\r\n${p}\r\n`).join("")}--${boundary}--\r\n`;
}
const text = "Content-Type: text/plain; charset=utf-8\r\n\r\nhello";
const attached = (header, body = "x") => `Content-Type: application/pdf\r\n${header}\r\n\r\n${body}`;
const names = (raw, decodeWord) => plain(listRawMimeAttachments(raw, decodeWord).attachments.map(a => a.name));

describe("attachmentMatchesFilter on incomplete attachments", () => {
  it("treats a missing content type as empty, so only a type-less filter can match it", () => {
    assert.equal(attachmentMatchesFilter({ name: "a.bin" }, parseAttachmentFilter({ attachmentType: "image/" })), false);
    assert.equal(attachmentMatchesFilter({ name: "a.bin" }, parseAttachmentFilter({ attachmentName: "a." })), true);
    assert.equal(attachmentMatchesFilter({}, parseAttachmentFilter({ attachmentName: "a." })), false);
  });
});

describe("rawMimeParameter", () => {
  it("reads a missing header value as having no parameter", () => {
    assert.deepEqual(plain(rawMimeParameter(undefined, "filename")), { plain: "" });
    assert.deepEqual(plain(rawMimeParameter("", "filename")), { plain: "" });
  });

  it("skips a parameter without a value and a continuation index that is not one to three digits", () => {
    assert.deepEqual(plain(rawMimeParameter("attachment; flag; filename=x.txt", "filename")), { plain: "x.txt" });
    assert.deepEqual(plain(rawMimeParameter("attachment; filename*abc=x; filename*1234=y; filename*0x=z", "filename")), { plain: "" });
  });

  it("reads a first encoded segment without a charset as UTF-8", () => {
    assert.deepEqual(plain(rawMimeParameter("attachment; filename*0*=caf%C3%A9; filename*1=.txt", "filename")), { extended: "café.txt" });
  });

  it("reads an empty charset of a first encoded segment as UTF-8", () => {
    assert.deepEqual(plain(rawMimeParameter("attachment; filename*0*=''caf%C3%A9", "filename")), { extended: "café" });
  });

  it("honors the charset of a first encoded segment, and decodes as UTF-8 when it is unknown", () => {
    assert.deepEqual(plain(rawMimeParameter("attachment; filename*0*=iso-8859-1'fr'caf%E9", "filename")), { extended: "café" });
    assert.deepEqual(plain(rawMimeParameter("attachment; filename*0*=x-no-such-charset'fr'na%C3%AFve", "filename")), { extended: "naïve" });
  });

  it("falls through to the segments when the extended value is empty, then to the plain value", () => {
    assert.deepEqual(plain(rawMimeParameter("attachment; filename*=utf-8''; filename*0=abc", "filename")), { extended: "abc" });
    assert.deepEqual(plain(rawMimeParameter("attachment; filename*=utf-8''; filename=plain.txt", "filename")), { plain: "plain.txt" });
  });

  it("looks only at the parameter asked for", () => {
    assert.deepEqual(plain(rawMimeParameter("application/pdf; name=\"n.pdf\"; filename=\"f.pdf\"", "name")), { plain: "n.pdf" });
  });
});

describe("rawMimePartFilename", () => {
  const entityOf = headers => parseRawMimeEntity(`${headers}\r\n\r\nbody`);

  it("takes the Content-Disposition filename before the Content-Type name", () => {
    assert.equal(rawMimePartFilename(entityOf("Content-Type: text/plain; name=ct.txt\r\nContent-Disposition: attachment; filename=cd.txt")), "cd.txt");
    assert.equal(rawMimePartFilename(entityOf("Content-Type: text/plain; name=ct.txt")), "ct.txt");
    assert.equal(rawMimePartFilename(entityOf("Content-Type: text/plain")), "");
  });

  it("goes on to the Content-Type name when the disposition gives nothing usable", () => {
    assert.equal(rawMimePartFilename(entityOf("Content-Type: application/pdf; name=\"fallback.pdf\"\r\nContent-Disposition: attachment; filename=\" \"")), "fallback.pdf");
    assert.equal(rawMimePartFilename(entityOf("Content-Type: application/pdf; name=\"fallback.pdf\"\r\nContent-Disposition: attachment")), "fallback.pdf");
  });

  it("removes control characters and surrounding blanks", () => {
    assert.equal(rawMimePartFilename(entityOf("Content-Disposition: attachment; filename=\"  a\u0001b\u007fc.txt  \"")), "abc.txt");
    assert.equal(rawMimePartFilename(entityOf("Content-Disposition: attachment; filename=\"\u0001\u0002\"")), "");
  });

  it("decodes an RFC 2047 word only when a decoder is given, keeping the name when it fails or answers nothing", () => {
    const entity = entityOf("Content-Disposition: attachment; filename=\"=?utf-8?b?Y2Fmw6kudHh0?=\"");
    const decode = s => Buffer.from(s.slice("=?utf-8?b?".length, -2), "base64").toString("utf8");
    assert.equal(rawMimePartFilename(entity, decode), "café.txt");
    assert.equal(rawMimePartFilename(entity), "=?utf-8?b?Y2Fmw6kudHh0?=");
    assert.equal(rawMimePartFilename(entity, () => ""), "=?utf-8?b?Y2Fmw6kudHh0?=");
    assert.equal(rawMimePartFilename(entity, () => { throw new Error("no converter"); }), "=?utf-8?b?Y2Fmw6kudHh0?=");
    // A plain name never reaches the decoder
    const never = entityOf("Content-Disposition: attachment; filename=plain.txt");
    assert.equal(rawMimePartFilename(never, () => { throw new Error("must not be called"); }), "plain.txt");
  });

  it("keeps a raw 8-bit name that is not UTF-8 as it was read", () => {
    const entity = parseRawMimeEntity("Content-Disposition: attachment; filename=\"caf\xe9.txt\"\r\n\r\nbody");
    assert.equal(rawMimePartFilename(entity), "caf\xe9.txt");
  });
});

describe("rawMimeDecodedSize", () => {
  it("counts only base64 characters, whatever the line ends and the parameters of the encoding", () => {
    assert.equal(rawMimeDecodedSize("TW\r\nFu\r\nTWE=", "BASE64; x=y"), 5);
    assert.equal(rawMimeDecodedSize("!!!!", "base64"), 0);
  });

  it("subtracts soft line breaks and escapes of a quoted-printable body", () => {
    assert.equal(rawMimeDecodedSize("a=\r\nb=\nc=\rd =3D=C3=A9", "Quoted-Printable"), Buffer.from("abcd =é").length);
    assert.equal(rawMimeDecodedSize("plain", "quoted-printable"), 5);
  });

  it("is the length of an unencoded body, and null for an unknown encoding", () => {
    for (const cte of ["7bit", "8bit", "binary", "", undefined]) assert.equal(rawMimeDecodedSize("abcd", cte), 4, String(cte));
    assert.equal(rawMimeDecodedSize(undefined, "7bit"), 0);
    assert.equal(rawMimeDecodedSize("abcd", "x-uuencode"), null);
  });
});

describe("listRawMimeAttachments", () => {
  it("leaves out the size of a part with an unknown transfer encoding", () => {
    const raw = mixed("b", [text, attached("Content-Disposition: attachment; filename=\"u.pdf\"\r\nContent-Transfer-Encoding: x-uuencode")]);
    assert.deepEqual(plain(listRawMimeAttachments(raw).attachments), [{ name: "u.pdf", contentType: "application/pdf" }]);
  });

  it("lists a name decoded by the caller's decoder and one decoded without it", () => {
    const encoded = "=?utf-8?b?Y2Fmw6kudHh0?=";
    const raw = mixed("b", [text, attached(`Content-Disposition: attachment; filename="${encoded}"`)]);
    assert.deepEqual(names(raw, () => "café.txt"), ["café.txt"]);
    assert.deepEqual(names(raw), [encoded]);
  });

  it("reads a Content-Type without a type as text/plain", () => {
    const raw = mixed("b", [text, "Content-Type: ; charset=utf-8\r\nContent-Disposition: attachment; filename=\"n.txt\"\r\n\r\nabc"]);
    assert.deepEqual(plain(listRawMimeAttachments(raw).attachments), [{ name: "n.txt", contentType: "text/plain", size: 3 }]);
  });

  it("lists a named non-text part without a disposition, and an unnamed one disposed as attachment", () => {
    const raw = mixed("b", [
      text,
      "Content-Type: image/png; name=\"pic.png\"\r\n\r\nx",
      "Content-Type: application/octet-stream\r\nContent-Disposition: attachment\r\n\r\nx",
      "Content-Type: text/plain; name=\"note.txt\"\r\n\r\nnot an attachment",
    ]);
    assert.deepEqual(names(raw), ["pic.png", ""]);
  });

  it("reads the message inside a message at the top, without listing the outer one", () => {
    const inner = mixed("in", [text, attached("Content-Disposition: attachment; filename=\"inner.pdf\"")]);
    const listed = plain(listRawMimeAttachments(`Content-Type: message/rfc822\r\n\r\n${inner}`).attachments);
    assert.deepEqual(listed, [{ name: "inner.pdf", contentType: "application/pdf", size: 1, inAttachedMessage: true }]);
  });

  it("lists an attached message that cannot be read itself, without opening it", () => {
    const raw = mixed("b", [text, "Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename=\"broken.eml\"\r\n\r\nno blank line here"]);
    const result = plain(listRawMimeAttachments(raw));
    assert.deepEqual(result.attachments, [{ name: "broken.eml", contentType: "message/rfc822", size: "no blank line here".length }]);
    assert.equal(result.limited, false);
  });

  it("opens a quoted-printable attached message, and reads one with an unknown transfer encoding as it is", () => {
    const inner = mixed("in", [text, attached("Content-Disposition: attachment; filename=\"qp.pdf\"")]);
    const qp = inner.replace(/=/g, "=3D");
    const raw = mixed("b", [text, `Content-Type: message/rfc822\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp}`]);
    assert.deepEqual(names(raw), ["", "qp.pdf"]);
    const unknown = mixed("b", [text, `Content-Type: message/rfc822\r\nContent-Transfer-Encoding: x-uuencode\r\n\r\n${inner}`]);
    assert.deepEqual(names(unknown), ["", "qp.pdf"]);
    assert.equal(listRawMimeAttachments(unknown).limited, false);
  });

  it("is limited when attached messages nest deeper than the depth limit", () => {
    let raw = "Subject: innermost\r\nContent-Type: text/plain\r\n\r\nx";
    for (let i = 0; i < ATTACHMENT_SEARCH_MAX_DEPTH + 2; i++) raw = `Content-Type: message/rfc822\r\n\r\n${raw}`;
    assert.equal(listRawMimeAttachments(raw).limited, true);
    let shallow = "Subject: innermost\r\nContent-Type: text/plain\r\n\r\nx";
    for (let i = 0; i < 3; i++) shallow = `Content-Type: message/rfc822\r\n\r\n${shallow}`;
    assert.equal(listRawMimeAttachments(shallow).limited, false);
  });

  it("is limited when the part limit is reached just before an attached message", () => {
    // The root, 998 text parts and the message use up all 1000 parts, leaving none for the message's own
    const filler = Array.from({ length: ATTACHMENT_SEARCH_MAX_PARTS - 2 }, () => "X: y\r\n\r\nz");
    const message = "Content-Type: message/rfc822\r\n\r\nSubject: inner\r\nContent-Type: text/plain\r\n\r\nx";
    const full = listRawMimeAttachments(mixed("b", [...filler, message]));
    assert.equal(full.limited, true);
    const roomy = listRawMimeAttachments(mixed("b", [...filler.slice(1), message]));
    assert.equal(roomy.limited, false);
  });

  it("does not open a multipart whose parts were cut off, and flags the walk", () => {
    const deep = (n) => n === 0 ? text : `Content-Type: multipart/mixed; boundary=l${n}\r\n\r\n--l${n}\r\n${deep(n - 1)}\r\n--l${n}--`;
    assert.equal(listRawMimeAttachments(`Subject: s\r\n${deep(ATTACHMENT_SEARCH_MAX_DEPTH + 3)}`).limited, true);
    assert.equal(listRawMimeAttachments(`Subject: s\r\n${deep(3)}`).limited, false);
  });
});

describe("scanAttachmentCandidates on unusual inspector answers", () => {
  const filter = parseAttachmentFilter({ attachmentType: "application/pdf" });
  const limits = { ...ATTACHMENT_SEARCH_LIMITS };

  it("counts an inspector that answers nothing, or throws, as unreadable", async () => {
    const answers = [undefined, null, 0, ""];
    const scan = await scanAttachmentCandidates(answers.map((_, i) => i), filter, i => answers[i], limits, null);
    assert.deepEqual(plain(scan.skipped), { unreadable: 4 });
    assert.equal(scan.checked, 0);
    const thrown = await scanAttachmentCandidates([1], filter, () => { throw new Error("stream closed"); }, limits, null);
    assert.deepEqual(plain(thrown.skipped), { unreadable: 1 });
  });

  it("checks a candidate whose answer lists no attachments, without a match", async () => {
    const scan = await scanAttachmentCandidates([1, 2], filter, i => (i === 1 ? {} : { attachments: undefined, bytes: 4 }), limits, null);
    assert.equal(scan.checked, 2);
    assert.deepEqual(plain(scan.matches), []);
    assert.deepEqual(plain(scan.skipped), {});
  });

  it("ignores a byte count that is not a positive number", async () => {
    const scan = await scanAttachmentCandidates([1, 2, 3], filter, () => ({ attachments: [], bytes: "many" }),
      { ...limits, maxTotalBytes: 1 }, null);
    assert.equal(scan.checked, 3);
    assert.equal(scan.limitReached, false);
  });

  it("lets Thunderbird run after pauseBytes, or after pauseMessages, and resets both counters", async () => {
    let pauses = 0;
    const pause = async () => { pauses++; };
    await scanAttachmentCandidates([1, 2, 3, 4, 5], filter, () => ({ attachments: [], bytes: 100 }),
      { ...limits, pauseBytes: 250, pauseMessages: 1000 }, pause);
    assert.equal(pauses, 1);
    pauses = 0;
    await scanAttachmentCandidates([1, 2, 3, 4, 5], filter, () => ({ attachments: [], bytes: 1 }),
      { ...limits, pauseBytes: 1e9, pauseMessages: 2 }, pause);
    assert.equal(pauses, 2);
    pauses = 0;
    await scanAttachmentCandidates([1, 2, 3], filter, () => ({ attachments: [] }), { ...limits, pauseBytes: 0, pauseMessages: 1000 }, pause);
    assert.equal(pauses, 3);
  });
});
