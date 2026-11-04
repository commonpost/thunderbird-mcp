// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The raw-stream helpers of the attachment code: the size check of a saved attachment and the read of a
// message's outer header block, in the cases of a closed or failing stream and of oversized headers.

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

const NS_BASE_STREAM_CLOSED = 0x80470002;
const sandbox = {
  Uint8Array,
  TextDecoder,
  atob: globalThis.atob,
  Cr: { NS_BASE_STREAM_CLOSED },
  NetUtil: { readInputStreamToString: (stream, count) => stream.read(count) },
};
vm.createContext(sandbox);
vm.runInContext(`${["STRIP HELPERS", "ENCRYPTED MESSAGE HELPERS", "RAW MIME PARSING HELPERS", "RAW MIME ATTACHMENT HELPERS"].map(region).join("\n")}
Object.assign(this, { attachmentSaveLooksWrong, readRawOuterHeaderBlock, readRawMimeOuterEntity, outerWireSubject,
  isRawMimeEnvelopeEncrypted, RAW_HEADER_BLOCK_TOO_LARGE, RAW_MIME_HEADER_PEEK_BYTES });`, sandbox);
const {
  attachmentSaveLooksWrong, readRawOuterHeaderBlock, readRawMimeOuterEntity, outerWireSubject, isRawMimeEnvelopeEncrypted,
  RAW_HEADER_BLOCK_TOO_LARGE, RAW_MIME_HEADER_PEEK_BYTES,
} = sandbox;

function xpcomError(result) {
  const error = new Error(`xpcom ${result}`);
  error.result = result;
  return error;
}

// A stream of text that reports end of data as NS_BASE_STREAM_CLOSED after `closeAfter` characters were read
function makeStream(text, { chunk = 4096, closeAfter = Infinity, availableError = null } = {}) {
  let pos = 0;
  const stream = {
    closed: false,
    available() {
      if (availableError) throw availableError;
      if (pos >= closeAfter) throw xpcomError(NS_BASE_STREAM_CLOSED);
      return Math.min(text.length, closeAfter) - pos;
    },
    read(count) {
      const part = text.slice(pos, pos + Math.min(count, chunk));
      pos += part.length;
      return part;
    },
    close() { stream.closed = true; },
  };
  return stream;
}

function msgHdrOf(stream, { closeThrows = false } = {}) {
  if (closeThrows) stream.close = () => { throw new Error("close failed"); };
  return { folder: { getMsgInputStream: () => stream } };
}

describe("attachmentSaveLooksWrong", () => {
  it("is wrong for a size that is not a size", () => {
    for (const actual of [null, undefined, "12", -1, {}]) {
      assert.equal(attachmentSaveLooksWrong(100, actual), true, String(actual));
    }
  });

  it("is wrong for an empty file unless nothing was declared to be empty", () => {
    assert.equal(attachmentSaveLooksWrong(100, 0), true);
    assert.equal(attachmentSaveLooksWrong(null, 0), true);
    assert.equal(attachmentSaveLooksWrong(undefined, 0), true);
    assert.equal(attachmentSaveLooksWrong(0, 0), false);
  });

  it("accepts any size when the declared one is unknown or not positive", () => {
    for (const declared of [null, undefined, -5, "100", NaN]) {
      assert.equal(attachmentSaveLooksWrong(declared, 7), false, String(declared));
    }
    assert.equal(attachmentSaveLooksWrong(0, 7), false);
  });

  it("tolerates 8 bytes for a small attachment and 5 percent for a large one, on both sides", () => {
    assert.equal(attachmentSaveLooksWrong(100, 108), false);
    assert.equal(attachmentSaveLooksWrong(100, 109), true);
    assert.equal(attachmentSaveLooksWrong(100, 92), false);
    assert.equal(attachmentSaveLooksWrong(100, 91), true);
    assert.equal(attachmentSaveLooksWrong(1000, 1050), false);
    assert.equal(attachmentSaveLooksWrong(1000, 1051), true);
    assert.equal(attachmentSaveLooksWrong(1000, 950), false);
    assert.equal(attachmentSaveLooksWrong(1000, 949), true);
  });
});

describe("readRawOuterHeaderBlock", () => {
  it("treats a stream that closes before the blank line as unreadable", () => {
    const text = "A: 1\r\nB: 2\r\n";
    assert.equal(readRawOuterHeaderBlock(makeStream(text, { closeAfter: text.length }), 1024), null);
    assert.equal(readRawOuterHeaderBlock(makeStream(text), 1024), null);
  });

  it("treats a stream that closes after the limit as too large", () => {
    // The read stops at the limit plus the four characters of a blank line; the stream closes just before
    const stream = makeStream(`X: ${"a".repeat(2000)}`, { closeAfter: 1026 });
    assert.equal(readRawOuterHeaderBlock(stream, 1024), RAW_HEADER_BLOCK_TOO_LARGE);
  });

  it("also takes the closed-stream result code thrown bare", () => {
    assert.equal(readRawOuterHeaderBlock({ available() { throw NS_BASE_STREAM_CLOSED; } }, 1024), null);
  });

  it("reads a stream that closes right after the blank line", () => {
    const stream = makeStream("A: 1\r\n\r\nbody", { closeAfter: 9 });
    assert.equal(readRawOuterHeaderBlock(stream, 1024), "A: 1");
  });

  it("stops when a read returns nothing", () => {
    const stream = { available: () => 10, read: () => "" };
    assert.equal(readRawOuterHeaderBlock(stream, 1024), null);
  });

  it("propagates a failure other than a closed stream", () => {
    const failure = xpcomError("NS_ERROR_FAILURE");
    assert.throws(() => readRawOuterHeaderBlock(makeStream("A: 1", { availableError: failure }), 1024), error => error === failure);
  });

  it("accepts a header block of exactly the limit and refuses one byte more", () => {
    const exact = `X: ${"a".repeat(1021)}`;
    assert.equal(exact.length, 1024);
    assert.equal(readRawOuterHeaderBlock(makeStream(`${exact}\r\n\r\nbody`), 1024), exact);
    assert.equal(readRawOuterHeaderBlock(makeStream(`${exact}b\r\n\r\nbody`), 1024), RAW_HEADER_BLOCK_TOO_LARGE);
  });
});

describe("readRawMimeOuterEntity", () => {
  it("returns the outer entity without opening a multipart body", () => {
    const stream = makeStream('Subject: s\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nX: y\r\n\r\nz\r\n--b--\r\n');
    const root = readRawMimeOuterEntity(msgHdrOf(stream));
    assert.equal(root.contentType.value, "multipart/mixed");
    assert.equal(root.depthLimitReached, true);
    assert.equal(root.parts.length, 0);
    assert.equal(stream.closed, true);
  });

  it("reports headers longer than the peek limit as too large, not as unreadable", () => {
    const stream = makeStream(`Subject: ${"s".repeat(RAW_MIME_HEADER_PEEK_BYTES + 10)}\r\n\r\nbody`, { chunk: 16 * 1024 });
    assert.equal(readRawMimeOuterEntity(msgHdrOf(stream)), RAW_HEADER_BLOCK_TOO_LARGE);
    assert.equal(stream.closed, true);
  });

  it("returns null for a message without folder, a stream that cannot be opened or read, or no blank line", () => {
    assert.equal(readRawMimeOuterEntity({ folder: null }), null);
    assert.equal(readRawMimeOuterEntity({ folder: { getMsgInputStream() { throw new Error("no stream"); } } }), null);
    const failing = makeStream("A: 1", { availableError: xpcomError("NS_ERROR_FAILURE") });
    assert.equal(readRawMimeOuterEntity(msgHdrOf(failing)), null);
    assert.equal(failing.closed, true);
    assert.equal(readRawMimeOuterEntity(msgHdrOf(makeStream("A: 1\r\n"))), null);
  });

  it("does not let a stream that fails to close change the result", () => {
    const stream = makeStream("Subject: kept\r\n\r\nbody");
    const root = readRawMimeOuterEntity(msgHdrOf(stream, { closeThrows: true }));
    assert.equal(root.headers.subject[0], "kept");
  });
});

describe("outerWireSubject and isRawMimeEnvelopeEncrypted on oversized or empty headers", () => {
  const tooLarge = () => msgHdrOf(makeStream(`Subject: ${"s".repeat(RAW_MIME_HEADER_PEEK_BYTES + 10)}\r\n\r\nbody`, { chunk: 16 * 1024 }));

  it("gives no subject at all, not the fallback, when the headers are too long to read", () => {
    assert.equal(outerWireSubject(tooLarge(), "database subject"), "");
  });

  it("treats a message whose headers are too long to read as encrypted", () => {
    assert.equal(isRawMimeEnvelopeEncrypted(tooLarge()), true);
  });

  it("uses the fallback for an empty Subject header", () => {
    assert.equal(outerWireSubject(msgHdrOf(makeStream("Subject:\r\nFrom: a@example.test\r\n\r\nbody")), "fallback"), "fallback");
  });

  it("reads an OpenPGP envelope whose Content-Type is folded", () => {
    const raw = 'Subject: s\r\nContent-Type: multipart/encrypted;\r\n protocol="application/pgp-encrypted";\r\n boundary="b"\r\n\r\nbody';
    assert.equal(isRawMimeEnvelopeEncrypted(msgHdrOf(makeStream(raw))), true);
  });
});
