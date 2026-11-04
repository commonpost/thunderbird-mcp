// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The raw MIME parsing helpers: byte strings, header and parameter parsing, transfer decoding, multipart splitting,
// the entity tree and the body and source decoders, on malformed and edge-case input.

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

const EXPORTED = [
  "rawMimeToByteString", "rawMimeBytesFromByteString", "findRawMimeHeaderBodySplit", "parseRawMimeHeaders",
  "splitRawMimeHeaderParameters", "unquoteRawMimeParameter", "decodeRawMimePercentBytes",
  "decodeRawMimeExtendedParameter", "parseRawMimeHeaderValue", "getRawMimeFilename", "normalizeRawMimeContentId",
  "normalizeRawMimeContentIdForMatch", "decodeRawMimeBase64ToBytes", "decodeRawMimeQuotedPrintableToBytes",
  "decodeRawMimeTransferBody", "escapeRawMimeRegExp", "splitRawMimeMultipartBody", "parseRawMimeEntity",
  "decodeRawMimeTextPart", "extractBodyPartFromRawMime", "rawSourceDecoder", "decodeRawSource",
  "parseAttachmentPartsFromRawMime", "RAW_MIME_MAX_PARTS",
];

function load({ atob = globalThis.atob, TextDecoderImpl = TextDecoder } = {}) {
  const sandbox = { Uint8Array, TextDecoder: TextDecoderImpl };
  if (atob) sandbox.atob = atob;
  vm.createContext(sandbox);
  vm.runInContext(`${["STRIP HELPERS", "ENCRYPTED MESSAGE HELPERS", "RAW MIME PARSING HELPERS", "RAW MIME ATTACHMENT HELPERS"]
    .map(region).join("\n")}
Object.assign(this, { ${EXPORTED.join(", ")} });`, sandbox);
  return sandbox;
}

const h = load();
const plain = value => JSON.parse(JSON.stringify(value));
const bytesOf = value => Array.from(value);
const textOf = bytes => Buffer.from(bytes).toString("latin1");

function multipart(boundary, parts, subtype = "mixed", extra = "") {
  return `Content-Type: multipart/${subtype}; boundary="${boundary}"${extra}\r\n\r\n` +
    `${parts.map(p => `--${boundary}\r\n${p}\r\n`).join("")}--${boundary}--\r\n`;
}

describe("rawMimeToByteString and rawMimeBytesFromByteString", () => {
  it("passes a string through and turns bytes into a Latin-1 string, past the 32 KiB chunk size", () => {
    assert.equal(h.rawMimeToByteString("abcé"), "abcé");
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i & 0xff);
    const s = h.rawMimeToByteString(bytes);
    assert.equal(s.length, bytes.length);
    assert.equal(s, Buffer.from(bytes).toString("latin1"));
  });

  it("returns an empty string for any other input", () => {
    for (const value of [null, undefined, 42, {}, [65, 66], new ArrayBuffer(2)]) {
      assert.equal(h.rawMimeToByteString(value), "", String(value));
    }
  });

  it("keeps only the low byte of each character when making bytes", () => {
    assert.deepEqual(bytesOf(h.rawMimeBytesFromByteString("AŁÿ")), [0x41, 0x41, 0xff]);
  });
});

describe("findRawMimeHeaderBodySplit", () => {
  it("splits at the earliest of CRLF CRLF, LF LF and CR CR", () => {
    assert.deepEqual(plain(h.findRawMimeHeaderBodySplit("A: 1\r\n\r\nbody")), { header: "A: 1", body: "body" });
    assert.deepEqual(plain(h.findRawMimeHeaderBodySplit("A: 1\n\nbody\r\n\r\nmore")), { header: "A: 1", body: "body\r\n\r\nmore" });
    assert.deepEqual(plain(h.findRawMimeHeaderBodySplit("A: 1\r\rbody")), { header: "A: 1", body: "body" });
  });

  it("returns null without a blank line", () => {
    assert.equal(h.findRawMimeHeaderBodySplit("A: 1\r\nB: 2\r\n"), null);
    assert.equal(h.findRawMimeHeaderBodySplit(""), null);
  });
});

describe("parseRawMimeHeaders", () => {
  it("unfolds continuation lines, lower-cases names and keeps repeated headers in order", () => {
    const headers = h.parseRawMimeHeaders("Subject: a\r\n b\r\n\tc\r\nReceived: 1\r\nreceived: 2\r\n Content-Type : text/plain\r\nContent-Type : text/html");
    assert.deepEqual(plain(headers.subject), ["a b c"]);
    // A line that starts with a blank continues the header before it
    assert.deepEqual(plain(headers.received), ["1", "2 Content-Type : text/plain"]);
    assert.deepEqual(plain(headers["content-type"]), ["text/html"]);
  });

  it("skips lines without a colon and lines without a name", () => {
    const headers = h.parseRawMimeHeaders("no colon here\r\n: orphan value\r\nX-Empty:\r\nX-Real: yes");
    assert.deepEqual(Object.keys(headers), ["x-empty", "x-real"]);
    assert.deepEqual(plain(headers["x-empty"]), [""]);
  });

  it("returns no header for a missing block", () => {
    assert.deepEqual(Object.keys(h.parseRawMimeHeaders(undefined)), []);
    assert.deepEqual(Object.keys(h.parseRawMimeHeaders(null)), []);
  });

  it("keeps a __proto__ header as plain data without touching Object.prototype", () => {
    const headers = h.parseRawMimeHeaders("__proto__: polluted\r\nX: 1");
    assert.deepEqual(Object.keys(headers), ["__proto__", "x"]);
    assert.deepEqual(plain(Object.getOwnPropertyDescriptor(headers, "__proto__").value), ["polluted"]);
    assert.equal(Object.getPrototypeOf(headers), null);
    assert.equal({}.polluted, undefined);
  });
});

describe("splitRawMimeHeaderParameters", () => {
  it("splits at semicolons outside quotes", () => {
    assert.deepEqual(plain(h.splitRawMimeHeaderParameters('attachment; filename="a;b.txt"; size=3')), ["attachment", 'filename="a;b.txt"', "size=3"]);
  });

  it("does not end a quoted string at an escaped quote", () => {
    assert.deepEqual(
      plain(h.splitRawMimeHeaderParameters('attachment; filename="a\\"b;c.txt"; size=3')),
      ["attachment", 'filename="a\\"b;c.txt"', "size=3"]
    );
    assert.deepEqual(plain(h.splitRawMimeHeaderParameters('x; n="a\\\\"; m=1')), ["x", 'n="a\\\\"', "m=1"]);
  });

  it("keeps an unterminated quote to the end of the value", () => {
    assert.deepEqual(plain(h.splitRawMimeHeaderParameters('attachment; filename="open;ended')), ["attachment", 'filename="open;ended']);
  });

  it("returns one empty piece for an empty value", () => {
    assert.deepEqual(plain(h.splitRawMimeHeaderParameters("")), [""]);
  });
});

describe("unquoteRawMimeParameter", () => {
  it("removes the quotes and the escapes of quote, apostrophe and backslash", () => {
    assert.equal(h.unquoteRawMimeParameter('"a\\"b\\\\c\\\'d"'), "a\"b\\c'd");
    assert.equal(h.unquoteRawMimeParameter('  "padded"  '), "padded");
  });

  it("leaves an unquoted or half-quoted value, and reads a missing one as empty", () => {
    assert.equal(h.unquoteRawMimeParameter("plain"), "plain");
    assert.equal(h.unquoteRawMimeParameter('"half'), '"half');
    assert.equal(h.unquoteRawMimeParameter(undefined), "");
    assert.equal(h.unquoteRawMimeParameter(null), "");
  });
});

describe("decodeRawMimePercentBytes", () => {
  it("decodes percent escapes and keeps everything else as a byte", () => {
    assert.deepEqual(bytesOf(h.decodeRawMimePercentBytes("a%41%c3%A9")), [0x61, 0x41, 0xc3, 0xa9]);
  });

  it("keeps an invalid or truncated escape literally", () => {
    assert.equal(textOf(h.decodeRawMimePercentBytes("100%zz")), "100%zz");
    assert.equal(textOf(h.decodeRawMimePercentBytes("a%4")), "a%4");
    assert.equal(textOf(h.decodeRawMimePercentBytes("%")), "%");
  });
});

describe("decodeRawMimeExtendedParameter", () => {
  it("decodes the charset and the percent escapes of an RFC 2231 value", () => {
    assert.equal(h.decodeRawMimeExtendedParameter("UTF-8'fr'r%C3%A9sum%C3%A9.pdf"), "résumé.pdf");
    assert.equal(h.decodeRawMimeExtendedParameter("iso-8859-1''caf%E9"), "café");
    assert.equal(h.decodeRawMimeExtendedParameter("\"utf-8''quoted%20name\""), "quoted name");
  });

  it("reads an empty charset as UTF-8 and an empty value as empty", () => {
    assert.equal(h.decodeRawMimeExtendedParameter("''%C3%A9"), "é");
    assert.equal(h.decodeRawMimeExtendedParameter("  ''%C3%A9"), "é");
    assert.equal(h.decodeRawMimeExtendedParameter("utf-8''"), "");
  });

  it("decodes as UTF-8 when the charset is unknown", () => {
    assert.equal(h.decodeRawMimeExtendedParameter("x-no-such-charset''na%C3%AFve.txt"), "naïve.txt");
  });

  it("returns the value as it came when it has no charset part", () => {
    assert.equal(h.decodeRawMimeExtendedParameter("plain%20value"), "plain%20value");
  });

  it("reads at most maxChars of the encoded value", () => {
    assert.equal(h.decodeRawMimeExtendedParameter("utf-8''abcdef", 3), "abc");
    assert.equal(h.decodeRawMimeExtendedParameter("abcdef", 4), "abcd");
  });

  it("returns the raw value when no decoder works at all", () => {
    class NoDecoder {
      constructor() { throw new Error("no decoder"); }
    }
    const bare = load({ TextDecoderImpl: NoDecoder });
    assert.equal(bare.decodeRawMimeExtendedParameter("utf-8''a%20b"), "utf-8''a%20b");
  });
});

describe("parseRawMimeHeaderValue and getRawMimeFilename", () => {
  it("lower-cases the value and reads quoted and extended parameters", () => {
    const parsed = h.parseRawMimeHeaderValue("Multipart/Mixed; Boundary=\"b;1\"; NAME*=utf-8''a%20b; bad; =nokey; x=1");
    assert.equal(parsed.value, "multipart/mixed");
    assert.deepEqual(plain(Object.fromEntries(Object.entries(parsed.params))), { boundary: "b;1", "name*": "a b", x: "1" });
  });

  it("reads a missing value as empty", () => {
    const parsed = h.parseRawMimeHeaderValue(undefined);
    assert.equal(parsed.value, "");
    assert.deepEqual(Object.keys(parsed.params), []);
  });

  it("takes the file name from Content-Disposition (filename*, filename) before Content-Type (name*, name)", () => {
    const parse = (cd, ct) => h.getRawMimeFilename(h.parseRawMimeHeaderValue(cd), h.parseRawMimeHeaderValue(ct));
    assert.equal(parse("attachment; filename*=utf-8''ext.txt; filename=plain.txt", "text/plain; name=ct.txt"), "ext.txt");
    assert.equal(parse("attachment; filename=plain.txt", "text/plain; name=ct.txt"), "plain.txt");
    assert.equal(parse("attachment", "text/plain; name*=utf-8''ctext.txt; name=ct.txt"), "ctext.txt");
    assert.equal(parse("attachment", "text/plain; name=ct.txt"), "ct.txt");
    assert.equal(parse("attachment", "text/plain"), "");
  });
});

describe("content-id normalization", () => {
  it("strips the angle brackets of a header value", () => {
    assert.equal(h.normalizeRawMimeContentId(" <Logo@Example> "), "Logo@Example");
    assert.equal(h.normalizeRawMimeContentId(undefined), "");
  });

  it("also lower-cases and trims for matching", () => {
    assert.equal(h.normalizeRawMimeContentIdForMatch("  < Logo@Example >  "), "logo@example");
    assert.equal(h.normalizeRawMimeContentIdForMatch(null), "");
  });
});

describe("decodeRawMimeBase64ToBytes", () => {
  const data = Buffer.from("Hello, MIME wörld! \u0000ÿ", "latin1");
  const encoded = data.toString("base64");
  const wrapped = encoded.replace(/.{8}/g, "$&\r\n");

  it("decodes a body wrapped over several lines", () => {
    assert.deepEqual(bytesOf(h.decodeRawMimeBase64ToBytes(wrapped)), [...data]);
    assert.deepEqual(bytesOf(h.decodeRawMimeBase64ToBytes(wrapped, true)), [...data]);
  });

  it("returns no bytes for an empty or blank body", () => {
    assert.equal(h.decodeRawMimeBase64ToBytes("").length, 0);
    assert.equal(h.decodeRawMimeBase64ToBytes(undefined).length, 0);
    assert.equal(h.decodeRawMimeBase64ToBytes(" \r\n\t ", true).length, 0);
    assert.equal(h.decodeRawMimeBase64ToBytes("!!!!").length, 0);
  });

  it("drops foreign characters when lenient and refuses them when strict", () => {
    assert.equal(textOf(h.decodeRawMimeBase64ToBytes("TW!Fu")), "Man");
    assert.throws(() => h.decodeRawMimeBase64ToBytes("TW!Fu", true));
  });

  it("refuses a body whose padding is wrong, strict or not", () => {
    assert.throws(() => h.decodeRawMimeBase64ToBytes("TWF=u"));
    assert.throws(() => h.decodeRawMimeBase64ToBytes("T"));
    assert.throws(() => h.decodeRawMimeBase64ToBytes("TQ=", true));
  });

  it("accepts missing padding", () => {
    assert.equal(textOf(h.decodeRawMimeBase64ToBytes("TWE")), "Ma");
    assert.equal(textOf(h.decodeRawMimeBase64ToBytes("TQ")), "M");
  });

  describe("without atob", () => {
    const manual = load({ atob: null });

    it("decodes every padding length like atob does", () => {
      for (const sample of ["", "M", "Ma", "Man", "Many", "Many hands", "\u0000ÿ\u0080"]) {
        const b64 = Buffer.from(sample, "latin1").toString("base64");
        assert.deepEqual(bytesOf(manual.decodeRawMimeBase64ToBytes(b64)), [...Buffer.from(sample, "latin1")], JSON.stringify(sample));
      }
    });

    it("decodes a wrapped body, with or without padding, strict or not", () => {
      assert.deepEqual(bytesOf(manual.decodeRawMimeBase64ToBytes(wrapped)), [...data]);
      assert.deepEqual(bytesOf(manual.decodeRawMimeBase64ToBytes(wrapped, true)), [...data]);
      assert.equal(textOf(manual.decodeRawMimeBase64ToBytes("TWE")), "Ma");
      assert.equal(textOf(manual.decodeRawMimeBase64ToBytes("TQ")), "M");
    });

    it("stops at a quartet that starts with padding or lacks its second character", () => {
      assert.equal(textOf(manual.decodeRawMimeBase64ToBytes("TWFu====")), "Man");
      assert.equal(textOf(manual.decodeRawMimeBase64ToBytes("TWFuT")), "Man");
      assert.equal(textOf(manual.decodeRawMimeBase64ToBytes("TWFuT=")), "Man");
    });

    it("refuses foreign characters when strict and drops them when lenient", () => {
      assert.throws(() => manual.decodeRawMimeBase64ToBytes("TW!Fu", true), /invalid base64 body/);
      assert.equal(textOf(manual.decodeRawMimeBase64ToBytes("TW!Fu")), "Man");
      assert.equal(manual.decodeRawMimeBase64ToBytes("  ", true).length, 0);
    });
  });
});

describe("decodeRawMimeQuotedPrintableToBytes", () => {
  it("decodes hex escapes of either case and joins soft line breaks of every kind", () => {
    assert.equal(textOf(h.decodeRawMimeQuotedPrintableToBytes("caf=C3=a9 a=\r\nb=\nc=\rd")), "cafÃ© abcd");
  });

  it("keeps an invalid or truncated escape literally", () => {
    assert.equal(textOf(h.decodeRawMimeQuotedPrintableToBytes("a=ZZb")), "a=ZZb");
    assert.equal(textOf(h.decodeRawMimeQuotedPrintableToBytes("end=4")), "end=4");
    assert.equal(textOf(h.decodeRawMimeQuotedPrintableToBytes("end=")), "end=");
  });

  it("returns no bytes for a missing body", () => {
    assert.equal(h.decodeRawMimeQuotedPrintableToBytes(undefined).length, 0);
  });
});

describe("decodeRawMimeTransferBody", () => {
  it("picks the decoder by encoding, ignoring case, parameters and blanks", () => {
    assert.equal(textOf(h.decodeRawMimeTransferBody("TWFu", " BASE64 ; x=y")), "Man");
    assert.equal(textOf(h.decodeRawMimeTransferBody("a=3Db", "Quoted-Printable")), "a=b");
    for (const cte of ["7bit", "8bit", "binary", "", ";", undefined]) {
      assert.equal(textOf(h.decodeRawMimeTransferBody("a=3Db", cte)), "a=3Db", String(cte));
    }
    assert.equal(h.decodeRawMimeTransferBody(undefined, "7bit").length, 0);
  });

  it("returns null for an encoding it does not know", () => {
    assert.equal(h.decodeRawMimeTransferBody("x", "x-uuencode"), null);
    assert.equal(h.decodeRawMimeTransferBody("x", "ietf-token"), null);
  });

  it("is lenient about base64 unless strictBase64 is set", () => {
    assert.equal(textOf(h.decodeRawMimeTransferBody("TW!Fu", "base64")), "Man");
    assert.equal(textOf(h.decodeRawMimeTransferBody("TW!Fu", "base64", { strictBase64: false })), "Man");
    assert.throws(() => h.decodeRawMimeTransferBody("TW!Fu", "base64", { strictBase64: true }));
  });
});

describe("splitRawMimeMultipartBody", () => {
  it("escapes the characters of a boundary that mean something in a pattern", () => {
    assert.equal(h.escapeRawMimeRegExp("a.b*c+d?e^f${g}(h)|i[j]k\\l"), "a\\.b\\*c\\+d\\?e\\^f\\$\\{g\\}\\(h\\)\\|i\\[j\\]k\\\\l");
    const body = "--a.b(1)\r\nX\r\n--a.b(1)--\r\n";
    assert.deepEqual(plain(h.splitRawMimeMultipartBody(body, "a.b(1)")), ["X"]);
    assert.deepEqual(plain(h.splitRawMimeMultipartBody("--axb(1)\r\nX\r\n--axb(1)--", "a.b(1)")), []);
  });

  it("returns nothing without a boundary or without a delimiter line", () => {
    assert.deepEqual(plain(h.splitRawMimeMultipartBody("--b\r\nX\r\n--b--", "")), []);
    assert.deepEqual(plain(h.splitRawMimeMultipartBody("no delimiter at all", "b")), []);
  });

  it("starts at a delimiter on the very first line and ignores the preamble and the epilogue", () => {
    assert.deepEqual(plain(h.splitRawMimeMultipartBody("--b\r\nA\r\n--b\r\nB\r\n--b--\r\nepilogue\r\n--b\r\nignored", "b")), ["A", "B"]);
    assert.deepEqual(plain(h.splitRawMimeMultipartBody("preamble\r\n--b\r\nA\r\n--b--", "b")), ["A"]);
  });

  it("accepts trailing blanks on a delimiter line and every kind of line end", () => {
    assert.deepEqual(plain(h.splitRawMimeMultipartBody("--b \t\nA\n--b\rB\r--b--", "b")), ["A", "B"]);
  });

  it("keeps the last open part when the closing delimiter is missing, but not an empty one", () => {
    assert.deepEqual(plain(h.splitRawMimeMultipartBody("--b\r\nA\r\n--b\r\nB", "b")), ["A", "B"]);
    assert.deepEqual(plain(h.splitRawMimeMultipartBody("--b\r\nA\r\n--b\r\n", "b")), ["A"]);
  });

  it("does not take a delimiter line that continues after the boundary", () => {
    assert.deepEqual(plain(h.splitRawMimeMultipartBody("--b\r\nA\r\n--bb\r\nB\r\n--b--", "b")), ["A\r\n--bb\r\nB"]);
  });

  it("stops one part past maxParts so the caller sees there are more", () => {
    const body = "--b\r\nA\r\n--b\r\nB\r\n--b\r\nC\r\n--b\r\nD\r\n--b--";
    assert.deepEqual(plain(h.splitRawMimeMultipartBody(body, "b", 2)), ["A", "B", "C"]);
    assert.deepEqual(plain(h.splitRawMimeMultipartBody(body, "b", 4)), ["A", "B", "C", "D"]);
  });
});

describe("parseRawMimeEntity", () => {
  const nested = multipart("outer", [
    "Content-Type: text/plain\r\n\r\nfirst",
    multipart("inner", ["Content-Type: text/plain\r\n\r\nsecond"], "alternative"),
  ]);

  it("returns null without a blank line between the headers and the body", () => {
    assert.equal(h.parseRawMimeEntity("Content-Type: text/plain"), null);
    assert.equal(h.parseRawMimeEntity(""), null);
    assert.equal(h.parseRawMimeEntity(undefined), null);
  });

  it("names every part by its position", () => {
    const root = h.parseRawMimeEntity(nested);
    assert.equal(root.partName, "1");
    assert.deepEqual(plain(root.parts.map(p => p.partName)), ["1.1", "1.2"]);
    assert.equal(root.parts[1].parts[0].partName, "1.2.1");
    assert.equal(root.parts[1].parts[0].body, "second");
    assert.equal(root.body, "");
  });

  it("reads bytes like the string they stand for", () => {
    const fromBytes = h.parseRawMimeEntity(new Uint8Array(Buffer.from(nested, "latin1")));
    assert.equal(fromBytes.parts[1].parts[0].body, "second");
  });

  it("defaults the content type to text/plain and the disposition to none", () => {
    const root = h.parseRawMimeEntity("Subject: x\r\n\r\nbody");
    assert.equal(root.contentType.value, "text/plain");
    assert.equal(root.contentDisposition.value, "");
    assert.equal(root.body, "body");
    assert.deepEqual(plain(root.parts), []);
  });

  it("gives a multipart without a boundary no parts", () => {
    const root = h.parseRawMimeEntity("Content-Type: multipart/mixed\r\n\r\n--b\r\nX: y\r\n\r\nz\r\n--b--");
    assert.deepEqual(plain(root.parts), []);
    assert.equal(root.partLimitReached, false);
  });

  it("stops at maxDepth and marks the multipart it did not open", () => {
    const rootOnly = h.parseRawMimeEntity(nested, { maxDepth: 0 });
    assert.equal(rootOnly.depthLimitReached, true);
    assert.deepEqual(plain(rootOnly.parts), []);
    const one = h.parseRawMimeEntity(nested, { maxDepth: 1 });
    assert.equal(one.depthLimitReached, false);
    assert.equal(one.parts[0].depthLimitReached, false);
    assert.equal(one.parts[1].depthLimitReached, true);
    assert.deepEqual(plain(one.parts[1].parts), []);
  });

  it("falls back to the default options when maxDepth or maxParts is not usable", () => {
    for (const options of [{ maxDepth: -1 }, { maxDepth: 1.5 }, { maxDepth: "2" }, { maxParts: 0 }, { maxParts: -3 }, { maxParts: 2.5 }]) {
      const root = h.parseRawMimeEntity(nested, options);
      assert.equal(root.parts[1].parts[0].body, "second", JSON.stringify(options));
      assert.equal(root.partLimitReached, false);
    }
  });

  it("marks the multipart whose children did not all fit under maxParts", () => {
    const flat = multipart("b", ["X: 1\r\n\r\na", "X: 2\r\n\r\nb", "X: 3\r\n\r\nc"]);
    const root = h.parseRawMimeEntity(flat, { maxParts: 3 });
    assert.equal(root.partLimitReached, true);
    assert.equal(root.parts.length, 2);
    const roomy = h.parseRawMimeEntity(flat, { maxParts: 4 });
    assert.equal(roomy.partLimitReached, false);
    assert.equal(roomy.parts.length, 3);
  });

  it("marks a multipart that the children before it left no room for", () => {
    // The first child uses the budget up: the second multipart child is never opened
    const raw = multipart("o", [
      multipart("i1", ["X: 1\r\n\r\na", "X: 2\r\n\r\nb"]),
      multipart("i2", ["X: 3\r\n\r\nc"]),
    ]);
    const root = h.parseRawMimeEntity(raw, { maxParts: 5 });
    assert.equal(root.partLimitReached || root.parts.some(p => p.partLimitReached), true);
  });
});

describe("decodeRawMimeTextPart", () => {
  const entity = (contentType, body, cte = "") => h.parseRawMimeEntity(
    `Content-Type: ${contentType}\r\n${cte ? `Content-Transfer-Encoding: ${cte}\r\n` : ""}\r\n${body}`
  );

  it("returns null for anything but text/plain and text/html", () => {
    assert.equal(h.decodeRawMimeTextPart(entity("application/pdf", "x")), null);
    assert.equal(h.decodeRawMimeTextPart(entity("text/calendar", "x")), null);
  });

  it("returns null for an unknown transfer encoding", () => {
    assert.equal(h.decodeRawMimeTextPart(entity("text/plain", "x", "x-uuencode")), null);
  });

  it("reads a part without any Content-Type as UTF-8 text/plain", () => {
    const decoded = h.decodeRawMimeTextPart(h.parseRawMimeEntity("Subject: x\r\n\r\ncaf\u00c3\u00a9"));
    assert.deepEqual(plain(decoded), { text: "caf\u00e9", isHtml: false, charset: "utf-8", charsetFallback: false });
  });

  it("reads the charset quoted, single-quoted or bare, and says whether the part is HTML", () => {
    for (const label of ['"iso-8859-1"', "'iso-8859-1'", "iso-8859-1"]) {
      const decoded = h.decodeRawMimeTextPart(entity(`text/html; charset=${label}; format=flowed`, "café"));
      assert.equal(decoded.text, "café", label);
      assert.equal(decoded.isHtml, true);
      assert.equal(decoded.charset, "iso-8859-1");
      assert.equal(decoded.charsetFallback, false);
    }
  });

  it("decodes as UTF-8 and says so when the charset is unknown", () => {
    const decoded = h.decodeRawMimeTextPart(entity("text/plain; charset=x-no-such-charset", "caf=C3=A9", "quoted-printable"));
    assert.equal(decoded.text, "café");
    assert.equal(decoded.charset, "x-no-such-charset");
    assert.equal(decoded.charsetFallback, true);
    assert.equal(decoded.isHtml, false);
  });

  it("throws on a base64 body atob refuses, the strict singlepart behavior", () => {
    assert.throws(() => h.decodeRawMimeTextPart(entity("text/plain", "TW!Fu", "base64")));
  });
});

describe("extractBodyPartFromRawMime diagnostics and selection", () => {
  const text = (body, type = "plain") => `Content-Type: text/${type}; charset=utf-8\r\n\r\n${body}`;

  it("explains a message it could not parse", () => {
    const diagnostic = {};
    assert.equal(h.extractBodyPartFromRawMime("no blank line", "text", diagnostic), null);
    assert.equal(diagnostic.bodyNote, "raw MIME body extraction could not parse message");
    assert.equal(h.extractBodyPartFromRawMime("no blank line", "text"), null);
  });

  it("explains a single part that is not text and a multipart without text", () => {
    const single = {};
    assert.equal(h.extractBodyPartFromRawMime("Content-Type: application/pdf\r\n\r\nx", "text", single), null);
    assert.equal(single.bodyNote, "raw MIME body extraction found no suitable text part");
    const multi = {};
    assert.equal(h.extractBodyPartFromRawMime(multipart("b", ["Content-Type: application/pdf\r\n\r\nx"]), "text", multi), null);
    assert.equal(multi.bodyNote, "multipart body extraction found no suitable text part");
  });

  it("explains a body cut by the depth cap", () => {
    let raw = text("deep");
    for (let i = 0; i < 12; i++) raw = multipart(`d${i}`, [raw]);
    const diagnostic = {};
    assert.equal(h.extractBodyPartFromRawMime(raw, "text", diagnostic), null);
    assert.equal(diagnostic.bodyNote, "multipart body extraction hit depth cap");
  });

  it("explains a body cut by the part cap", () => {
    const empties = "--b\r\n\r\n".repeat(h.RAW_MIME_MAX_PARTS + 5);
    const raw = `Content-Type: multipart/mixed; boundary=b\r\n\r\n${empties}--b--\r\n`;
    const diagnostic = {};
    assert.equal(h.extractBodyPartFromRawMime(raw, "text", diagnostic), null);
    assert.equal(diagnostic.bodyNote, "multipart body extraction hit part cap");
  });

  it("returns the HTML alternative for html and markdown, the plain one otherwise, and the other when only one exists", () => {
    const both = multipart("alt", [text("plain body"), text("<p>html body</p>", "html")], "alternative");
    assert.equal(h.extractBodyPartFromRawMime(both, "html").text, "<p>html body</p>");
    assert.equal(h.extractBodyPartFromRawMime(both, "markdown").isHtml, true);
    assert.equal(h.extractBodyPartFromRawMime(both, "text").text, "plain body");
    const htmlFirst = multipart("alt", [text("<p>html body</p>", "html"), text("plain body")], "alternative");
    assert.equal(h.extractBodyPartFromRawMime(htmlFirst, "text").text, "plain body");
    const onlyHtml = multipart("alt", [text("<p>html body</p>", "html")], "alternative");
    assert.equal(h.extractBodyPartFromRawMime(onlyHtml, "text").isHtml, true);
  });

  it("falls back to the first usable alternative, skipping parts that are not text", () => {
    const raw = multipart("alt", [
      "Content-Type: image/png\r\n\r\nPNG",
      text("first plain"),
      text("second plain"),
    ], "alternative");
    const decoded = h.extractBodyPartFromRawMime(raw, "html");
    assert.equal(decoded.text, "first plain");
    assert.equal(decoded.isHtml, false);
    assert.equal(h.extractBodyPartFromRawMime(raw, "text").text, "first plain");
  });

  it("takes the first related part when the start parameter names none, and nothing from an empty related", () => {
    const related = multipart("rel", [
      "Content-Type: text/html; charset=utf-8\r\nContent-ID: <root@x>\r\n\r\n<p>root</p>",
      "Content-Type: image/png\r\nContent-ID: <img@x>\r\n\r\nPNG",
    ], "related", "; start=\"<missing@x>\"");
    assert.equal(h.extractBodyPartFromRawMime(related, "html").text, "<p>root</p>");
    const empty = "Content-Type: multipart/related; boundary=rel\r\n\r\n--rel--\r\n";
    const diagnostic = {};
    assert.equal(h.extractBodyPartFromRawMime(empty, "html", diagnostic), null);
    assert.equal(diagnostic.bodyNote, "multipart body extraction found no suitable text part");
  });

  it("skips an empty text part inside a multipart but returns an empty root body", () => {
    const withEmpty = multipart("m", [text(""), text("real")]);
    assert.equal(h.extractBodyPartFromRawMime(withEmpty, "text").text, "real");
    const root = h.extractBodyPartFromRawMime("Content-Type: text/plain\r\n\r\n", "text");
    assert.equal(root.text, "");
  });

  it("ignores attached text and attached messages", () => {
    const raw = multipart("m", [
      "Content-Type: text/plain\r\nContent-Disposition: attachment; filename=a.txt\r\n\r\nattached",
      "Content-Type: message/rfc822\r\n\r\nSubject: inner\r\n\r\ninner body",
      text("the body"),
    ]);
    assert.equal(h.extractBodyPartFromRawMime(raw, "text").text, "the body");
  });

  it("treats a decoder failure other than an unknown charset as no body", () => {
    class Faulty extends TextDecoder {
      constructor(label, options) {
        if (label === "x-faulty") throw new TypeError("decoder failed");
        super(label, options);
      }
    }
    const faulty = load({ TextDecoderImpl: Faulty });
    assert.throws(() => faulty.decodeRawMimeTextPart(faulty.parseRawMimeEntity("Content-Type: text/plain; charset=x-faulty\r\n\r\nx")), /decoder failed/);
    const diagnostic = {};
    assert.equal(faulty.extractBodyPartFromRawMime("Content-Type: text/plain; charset=x-faulty\r\n\r\nx", "text", diagnostic), null);
    assert.equal(diagnostic.bodyNote, "raw MIME body extraction found no suitable text part");
  });
});

describe("rawSourceDecoder", () => {
  it("returns a decoder for a usable label, whatever its case", () => {
    assert.equal(h.rawSourceDecoder("ISO-8859-15").encoding, "iso-8859-15");
    assert.equal(h.rawSourceDecoder("utf-8").encoding, "utf-8");
  });

  it("refuses a missing, unknown, replacement-like or UTF-16 label", () => {
    for (const label of [undefined, null, "", "x-no-such-charset", "ISO-2022-KR", "hz-gb-2312", "replacement", "utf-16le", "utf-16be", "x-user-defined"]) {
      assert.equal(h.rawSourceDecoder(label), null, String(label));
    }
  });
});

describe("decodeRawSource", () => {
  it("returns strict UTF-8 as it is", () => {
    assert.deepEqual(plain(h.decodeRawSource(Buffer.from("Subject: café\r\n\r\n").toString("latin1"))), { text: "Subject: café\r\n\r\n", charset: "utf-8" });
  });

  it("reads a message without a blank line by the charset of its first Content-Type", () => {
    const raw = "Content-Type: text/plain; charset=iso-8859-15\r\n\r\n".slice(0, -2) + "\xa4";
    assert.equal(raw.includes("\r\n\r\n"), false);
    const decoded = h.decodeRawSource(raw);
    assert.equal(decoded.charset, "iso-8859-15");
    assert.ok(decoded.text.endsWith("€"));
  });

  it("uses the declared charset of a part when the headers declare none", () => {
    const raw = "Subject: x\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=iso-8859-15\r\n\r\n\xa4\r\n--b--";
    const decoded = h.decodeRawSource(raw);
    assert.equal(decoded.charset, "iso-8859-15");
    assert.ok(decoded.text.includes("€"));
  });

  it("flags text decoded as UTF-8 although the bytes are not valid UTF-8", () => {
    const decoded = h.decodeRawSource("Content-Type: text/plain; charset=utf-8\r\n\r\ncaf\xe9");
    assert.equal(decoded.charset, "utf-8");
    assert.equal(decoded.lossy, true);
    assert.ok(decoded.text.endsWith("caf�"));
  });

  it("reports declared charsets that differ", () => {
    const raw = "Content-Type: multipart/mixed; charset=iso-8859-15; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=windows-1251\r\n\r\n\xa4\r\n--b--";
    const decoded = h.decodeRawSource(raw);
    assert.equal(decoded.charset, "iso-8859-15");
    assert.deepEqual(plain(decoded.mixedCharsets), ["iso-8859-15", "windows-1251"]);
  });

  it("asks the detector when nothing is declared, and survives a detector that fails or answers nothing", () => {
    const raw = "Subject: x\r\n\r\ncaf\xe9";
    const detected = h.decodeRawSource(raw, () => "windows-1252");
    assert.equal(detected.charset, "windows-1252");
    assert.ok(detected.text.endsWith("café"));
    for (const detect of [() => undefined, () => "x-no-such-charset", () => { throw new Error("detector down"); }]) {
      const fallback = h.decodeRawSource(raw, detect);
      assert.equal(fallback.charset, "iso-8859-1");
      assert.equal(fallback.text, raw);
    }
  });

  it("falls back to Latin-1 and the text itself when there is neither a declaration nor a detector", () => {
    const decoded = h.decodeRawSource("Subject: x\r\n\r\ncaf\xe9");
    assert.deepEqual(plain(decoded), { text: "Subject: x\r\n\r\ncaf\xe9", charset: "iso-8859-1" });
  });

  it("does not list us-ascii as a declared charset but still tries it for the top level", () => {
    const decoded = h.decodeRawSource("Content-Type: text/plain; charset=us-ascii\r\n\r\ncaf\xe9");
    assert.equal(decoded.charset, "windows-1252");
    assert.equal(decoded.mixedCharsets, undefined);
  });
});

describe("parseAttachmentPartsFromRawMime on malformed input", () => {
  const attachment = (extra = "", body = "TWFu") =>
    `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="a.bin"\r\nContent-Transfer-Encoding: base64${extra}\r\n\r\n${body}`;

  it("returns nothing for an unparsable or single-part message", () => {
    assert.deepEqual(plain(h.parseAttachmentPartsFromRawMime("no blank line")), []);
    assert.deepEqual(plain(h.parseAttachmentPartsFromRawMime("Content-Type: application/pdf\r\nContent-Disposition: attachment\r\n\r\nx")), []);
  });

  it("skips a part whose base64 body cannot be decoded and a part with an unknown encoding", () => {
    const raw = multipart("b", [
      attachment("", "A"),
      attachment("", "TWFu").replace("base64", "x-uuencode"),
      attachment("", "TWFu"),
    ]);
    const parts = h.parseAttachmentPartsFromRawMime(raw);
    assert.equal(parts.length, 1);
    assert.equal(textOf(parts[0].bytes), "Man");
  });

  it("reads a Content-Type with no type as text/plain: a named text part is an attachment only when disposed as one", () => {
    const raw = multipart("b", [
      "Content-Type: ;name=note.txt\r\n\r\nplain",
      "Content-Type: ;name=note.txt\r\nContent-Disposition: attachment\r\n\r\nplain",
    ]);
    const parts = h.parseAttachmentPartsFromRawMime(raw);
    assert.deepEqual(plain(parts.map(p => [p.filename, p.contentType, p.disposition])), [["note.txt", "text/plain", "attachment"]]);
  });

  it("lists an image outside multipart/related as inline when asked, if it is disposed inline or has a Content-ID", () => {
    const image = extra => `Content-Type: image/png${extra}\r\nContent-Transfer-Encoding: base64\r\n\r\nTWFu`;
    const raw = multipart("b", [
      image("\r\nContent-Disposition: inline"),
      image("\r\nContent-ID: <c@x>"),
      image("; name=\"named.png\""),
      image(""),
    ]);
    assert.deepEqual(plain(h.parseAttachmentPartsFromRawMime(raw).map(p => p.filename)), ["named.png"]);
    const withInline = h.parseAttachmentPartsFromRawMime(raw, { includeInlineImages: true });
    assert.deepEqual(plain(withInline.map(p => [p.partName, p.contentId, p.isInline])), [
      ["1.1", "", true],
      ["1.2", "c@x", true],
      ["1.3", "", false],
    ]);
  });

  it("keeps an image inside a multipart nested in multipart/related as related", () => {
    const inner = multipart("in", ["Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\nTWFu"]);
    const raw = multipart("rel", [inner], "related");
    assert.deepEqual(plain(h.parseAttachmentPartsFromRawMime(raw, { includeInlineImages: true }).map(p => p.isInline)), [true]);
    assert.deepEqual(plain(h.parseAttachmentPartsFromRawMime(raw).map(p => p.isInline)), []);
  });

  it("marks an image of a nested related part inline only when asked, but never one disposed as attachment", () => {
    const related = multipart("rel", [
      "Content-Type: text/html\r\n\r\n<img src=cid:a@x>",
      "Content-Type: image/png\r\nContent-ID: <a@x>\r\nContent-Transfer-Encoding: base64\r\n\r\nTWFu",
      "Content-Type: image/png\r\nContent-Disposition: attachment; filename=b.png\r\nContent-Transfer-Encoding: base64\r\n\r\nTWFu",
    ], "related");
    const raw = multipart("outer", [related]);
    assert.deepEqual(plain(h.parseAttachmentPartsFromRawMime(raw).map(p => p.filename)), ["b.png"]);
    const withInline = h.parseAttachmentPartsFromRawMime(raw, { includeInlineImages: true });
    assert.deepEqual(plain(withInline.map(p => [p.contentId, p.isInline])), [["a@x", true], ["", false]]);
    assert.equal(withInline[0].partName, "1.1.2");
  });
});
