"use strict";

// I8: for a message with protected/"memory hole" headers, Thunderbird's own
// msgHdr.subject can be rewritten with the decrypted subject once the
// message has been opened and decrypted at least once -- outerWireSubject
// and isRawMimeEnvelopeEncrypted read straight from the raw wire bytes
// instead, so getMessage/searchMessages/glodaBodySearch/getRecentMessages/
// displayMessage never trust that field for an encrypted message.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHelpers() {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  function marked(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0, `${startMarker} missing`);
    assert.ok(end > start, `${endMarker} missing`);
    return source.slice(start, end);
  }
  const snippet = [
    marked("// BEGIN ENCRYPTED MESSAGE HELPERS", "// END ENCRYPTED MESSAGE HELPERS"),
    marked("// BEGIN RAW MIME PARSING HELPERS", "// END RAW MIME ATTACHMENT HELPERS"),
  ].join("\n");

  const sandbox = {
    Cr: { NS_BASE_STREAM_CLOSED: "NS_BASE_STREAM_CLOSED" },
    NetUtil: {
      readInputStreamToString(stream, count) {
        return stream.read(count);
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${snippet}
this.readRawMimeOuterEntity = readRawMimeOuterEntity;
this.outerWireSubject = outerWireSubject;
this.isRawMimeEnvelopeEncrypted = isRawMimeEnvelopeEncrypted;`, sandbox);
  return sandbox;
}

const api = loadHelpers();

// A stream whose available()/read() slice a fixed raw-bytes string, the same
// contract readMessageStreamFully expects.
function makeFakeStream(rawText) {
  let offset = 0;
  return {
    available() {
      return rawText.length - offset;
    },
    read(count) {
      const chunk = rawText.slice(offset, offset + count);
      offset += chunk.length;
      return chunk;
    },
    close() {},
  };
}

function makeFakeMsgHdr(rawText, { streamThrows = false, noFolder = false } = {}) {
  return {
    folder: noFolder ? null : {
      getMsgInputStream() {
        if (streamThrows) throw new Error("cannot open stream");
        return makeFakeStream(rawText);
      },
    },
  };
}

const PLAIN_MESSAGE =
  "Subject: Hello there\r\nFrom: alice@example.com\r\nContent-Type: text/plain\r\n\r\nBonjour.\r\n";

const PROTECTED_ENCRYPTED_MESSAGE =
  "Subject: ...\r\n"
  + "From: alice@example.com\r\n"
  + 'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="B"\r\n'
  + "\r\n"
  + "--B\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--B\r\n"
  + 'Content-Type: application/octet-stream; name="encrypted.asc"\r\n\r\n'
  + "-----BEGIN PGP MESSAGE-----\r\nSUBJECT-SECRET-XYZ-BODY-CIPHERTEXT\r\n-----END PGP MESSAGE-----\r\n"
  + "--B--\r\n";

const SMIME_MESSAGE =
  "Subject: Quarterly figures\r\nFrom: bob@example.com\r\n"
  + 'Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\n'
  + "c2VjcmV0Ym9keQ==\r\n";

describe("outerWireSubject", () => {
  it("reads the Subject header straight from the raw wire bytes", () => {
    const msgHdr = makeFakeMsgHdr(PROTECTED_ENCRYPTED_MESSAGE);
    assert.equal(api.outerWireSubject(msgHdr, "SHOULD-NOT-BE-USED"), "...");
  });

  it("never returns the rewritten msgHdr subject passed as fallback, when the wire header differs", () => {
    const msgHdr = makeFakeMsgHdr(PLAIN_MESSAGE);
    // Simulates msgHdr.subject having been rewritten to something the wire
    // Subject never said -- outerWireSubject must prefer the wire text.
    const rewrittenFallback = "SUBJECT-SECRET-XYZ";
    assert.equal(api.outerWireSubject(msgHdr, rewrittenFallback), "Hello there");
    assert.notEqual(api.outerWireSubject(msgHdr, rewrittenFallback), rewrittenFallback);
  });

  it("falls back when the stream cannot be opened", () => {
    const msgHdr = makeFakeMsgHdr(PLAIN_MESSAGE, { streamThrows: true });
    assert.equal(api.outerWireSubject(msgHdr, "fallback-value"), "fallback-value");
  });

  it("falls back when there is no folder to read from", () => {
    const msgHdr = makeFakeMsgHdr(PLAIN_MESSAGE, { noFolder: true });
    assert.equal(api.outerWireSubject(msgHdr, "fallback-value"), "fallback-value");
  });

  it("falls back when the raw bytes have no header/body split (truncated read)", () => {
    const msgHdr = makeFakeMsgHdr("Subject: no blank line here, ever");
    assert.equal(api.outerWireSubject(msgHdr, "fallback-value"), "fallback-value");
  });

  it("falls back when there is no Subject header at all", () => {
    const msgHdr = makeFakeMsgHdr("From: alice@example.com\r\n\r\nBody.\r\n");
    assert.equal(api.outerWireSubject(msgHdr, "fallback-value"), "fallback-value");
  });
});

describe("isRawMimeEnvelopeEncrypted", () => {
  it("is true for an OpenPGP multipart/encrypted envelope", () => {
    const msgHdr = makeFakeMsgHdr(PROTECTED_ENCRYPTED_MESSAGE);
    assert.equal(api.isRawMimeEnvelopeEncrypted(msgHdr), true);
  });

  it("is true for an S/MIME application/pkcs7-mime envelope", () => {
    const msgHdr = makeFakeMsgHdr(SMIME_MESSAGE);
    assert.equal(api.isRawMimeEnvelopeEncrypted(msgHdr), true);
  });

  it("is false for an ordinary plaintext message", () => {
    const msgHdr = makeFakeMsgHdr(PLAIN_MESSAGE);
    assert.equal(api.isRawMimeEnvelopeEncrypted(msgHdr), false);
  });

  it("fails OPEN (false), not closed, when the stream cannot be read", () => {
    // Documented, deliberate difference from isEncryptedMimeMessage (which
    // fails closed): this is a cheap best-effort filter for a listing or
    // search loop, not the sole gate on decrypted content.
    const msgHdr = makeFakeMsgHdr(PROTECTED_ENCRYPTED_MESSAGE, { streamThrows: true });
    assert.equal(api.isRawMimeEnvelopeEncrypted(msgHdr), false);
  });
});
