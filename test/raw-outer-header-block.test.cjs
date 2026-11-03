// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The outer headers are read from the header block only, whatever the message size.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const api = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const start = api.indexOf("            const RAW_HEADER_BLOCK_TOO_LARGE");
const end = api.indexOf("\n            }\n", start) + "\n            }\n".length;
assert.ok(start > 0 && end > start);

function streamOf(text, chunk = 1000) {
  let pos = 0;
  return {
    available: () => text.length - pos,
    read(n) {
      const part = text.slice(pos, pos + Math.min(n, chunk));
      pos += part.length;
      return part;
    },
  };
}
const sandbox = {
  Cr: { NS_BASE_STREAM_CLOSED: 0x80470002 },
  findRawMimeHeaderBodySplit: (text) => {
    const m = [["\r\n\r\n", 4], ["\n\n", 2], ["\r\r", 2]].map(([sep, len]) => ({ idx: text.indexOf(sep), len }))
      .filter(x => x.idx >= 0).sort((a, b) => a.idx - b.idx)[0];
    return m ? { header: text.slice(0, m.idx), body: text.slice(m.idx + m.len) } : null;
  },
  NetUtil: { readInputStreamToString: (stream, n) => stream.read(n) },
};
vm.createContext(sandbox);
vm.runInContext(`${api.slice(start, end)}\nthis.readRawOuterHeaderBlock = readRawOuterHeaderBlock;\nthis.TOO_LARGE = RAW_HEADER_BLOCK_TOO_LARGE;`, sandbox);

describe("readRawOuterHeaderBlock", () => {
  const headers = 'Subject: x\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"';

  it("returns the header block of a message far larger than the limit", () => {
    const message = `${headers}\r\n\r\n${"A".repeat(200000)}`;
    assert.equal(sandbox.readRawOuterHeaderBlock(streamOf(message), 32 * 1024), headers);
  });

  it("accepts LF line ends", () => {
    assert.equal(sandbox.readRawOuterHeaderBlock(streamOf("A: 1\nB: 2\n\nbody"), 1024), "A: 1\nB: 2");
  });

  it("trusts nothing without the blank line that ends the headers", () => {
    assert.equal(sandbox.readRawOuterHeaderBlock(streamOf("A: 1\r\n"), 1024), null);
  });

  it("reports a header block longer than the limit as too large, not unreadable", () => {
    assert.equal(sandbox.readRawOuterHeaderBlock(streamOf(`X: ${"a".repeat(5000)}\r\n\r\nbody`), 1024), sandbox.TOO_LARGE);
    assert.equal(sandbox.readRawOuterHeaderBlock(streamOf(""), 1024), null);
  });

  it("splits as the MIME parser does, CR-only included", () => {
    assert.equal(sandbox.readRawOuterHeaderBlock(streamOf("A: 1\rB: 2\r\rbody"), 1024), "A: 1\rB: 2");
  });
});

describe("callers", () => {
  it("fail closed when the headers are too long, and never fall back to the database subject when encrypted", () => {
    assert.match(api, /if \(root === RAW_HEADER_BLOCK_TOO_LARGE\) return true;/);
    assert.match(api, /if \(root === RAW_HEADER_BLOCK_TOO_LARGE\) return "";/);
    assert.match(api, /\? outerWireSubject\(msgHdr, ""\)/);
  });
});

describe("readRawMimeOuterEntity", () => {
  it("no longer reads the whole message against the limit", () => {
    const fn = api.slice(api.indexOf("function readRawMimeOuterEntity("), api.indexOf("function readRawOuterHeaderBlock("));
    assert.doesNotMatch(fn, /readMessageStreamFully\(/);
    assert.match(fn, /readRawOuterHeaderBlock\(stream, RAW_MIME_HEADER_PEEK_BYTES\)/);
  });
});
