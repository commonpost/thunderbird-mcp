// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// Who may connect while the server listens on all interfaces: the list's parser and the check of each peer
// (api.js, LISTEN ALLOW-FROM block), and the hook in httpd.sys.mjs that closes a refused connection unread.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const api = fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8");
const httpd = fs.readFileSync(path.join(root, "extension/httpd.sys.mjs"), "utf8");

function block(source, begin, end) {
  const a = source.indexOf(begin);
  const b = source.indexOf(end);
  assert.ok(a >= 0 && b > a, `${begin} block missing`);
  return source.slice(a, b);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${block(api, "// BEGIN LISTEN ALLOW-FROM", "// END LISTEN ALLOW-FROM")}
this.parseListenAllowFrom = parseListenAllowFrom; this.listenPeerAllowed = listenPeerAllowed;
this.LEGACY = LISTEN_ALLOW_FROM_LEGACY;`, sandbox);
const { parseListenAllowFrom, listenPeerAllowed, LEGACY } = sandbox;
const plain = (v) => JSON.parse(JSON.stringify(v));

describe("parseListenAllowFrom", () => {
  it("reads addresses and networks separated by commas, semicolons or spaces, in canonical form", () => {
    const r = parseListenAllowFrom(" 192.168.1.20, 172.17.5.9/12;10.0.0.0/8  100.64.0.0/10 ");
    assert.deepEqual(plain(r.errors), []);
    assert.equal(r.text, "192.168.1.20, 172.16.0.0/12, 10.0.0.0/8, 100.64.0.0/10");
  });

  it("drops a duplicate", () => {
    assert.equal(parseListenAllowFrom("10.1.2.3, 10.1.2.3/32").text, "10.1.2.3");
  });

  it("refuses what is not an IPv4 address or network, IPv6, octal-looking octets and networks wider than /8", () => {
    for (const [input, reason] of [
      ["192.168.1", /not an IPv4 address/],
      ["256.1.1.1", /not an IPv4 address/],
      ["010.0.0.1", /not an IPv4 address/],
      ["localhost", /not an IPv4 address/],
      ["::1", /IPv6 is not supported/],
      ["fe80::/10", /IPv6 is not supported/],
      ["0.0.0.0/0", /wider than \/8/],
      ["10.0.0.0/7", /wider than \/8/],
      ["10.0.0.0/33", /between \/8 and \/32/],
      ["10.0.0.0/", /not an IPv4 address/],
    ]) {
      const r = parseListenAllowFrom(input);
      assert.equal(r.entries.length, 0, input);
      assert.equal(r.errors.length, 1, input);
      assert.match(r.errors[0], reason, input);
    }
  });

  it("keeps the valid entries and reports each invalid one", () => {
    const r = parseListenAllowFrom("10.0.0.0/8, nope, ::1");
    assert.equal(r.text, "10.0.0.0/8");
    assert.equal(r.errors.length, 2);
  });

  it("an empty list has no entry and no error", () => {
    for (const input of ["", "  ", ",, ;", null, undefined]) {
      const r = parseListenAllowFrom(input);
      assert.deepEqual([r.entries.length, r.errors.length], [0, 0], String(input));
    }
  });

  it("the legacy list for profiles that had the option on is valid and covers only private and Tailscale ranges", () => {
    const r = parseListenAllowFrom(LEGACY);
    assert.deepEqual(plain(r.errors), []);
    assert.equal(r.text, "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10");
  });
});

describe("listenPeerAllowed", () => {
  const entries = parseListenAllowFrom("172.16.0.0/12, 192.168.1.20").entries;

  it("lets this computer in, always", () => {
    assert.equal(listenPeerAllowed("127.0.0.1", []), true);
    assert.equal(listenPeerAllowed("127.255.0.9", []), true);
  });

  it("lets in the listed addresses and networks, edges included", () => {
    for (const ip of ["172.16.0.0", "172.17.0.2", "172.31.255.255", "192.168.1.20"]) assert.equal(listenPeerAllowed(ip, entries), true, ip);
  });

  it("refuses everything else, and anything that is not a plain IPv4 address", () => {
    for (const ip of ["172.15.255.255", "172.32.0.0", "192.168.1.21", "8.8.8.8", "::1", "::ffff:172.17.0.2", "", "172.17.0.2:5000", undefined]) {
      assert.equal(listenPeerAllowed(ip, entries), false, String(ip));
    }
  });
});

describe("httpd acceptFilter", () => {
  const start = httpd.indexOf("  onSocketAccepted(socket, trans) {");
  const hook = httpd.slice(start, httpd.indexOf("var connectionNumber", start));

  it("runs before any stream is opened, closes a refused connection and returns", () => {
    assert.ok(hook.indexOf("this.acceptFilter") < hook.indexOf("openInputStream"), "the filter runs first");
    assert.match(hook, /allowed = this\.acceptFilter\(trans\) === true;/);
    assert.match(hook, /if \(!allowed\) \{\s*trans\.close\(Cr\.NS_BINDING_ABORTED\);\s*return;\s*\}/);
  });

  it("refuses when the filter throws", () => {
    assert.match(hook, /let allowed = false;\s*try \{\s*allowed = this\.acceptFilter\(trans\) === true;\s*\} catch/);
  });

  it("api.js installs the filter only with a valid, non-empty list, and checks the peer address", () => {
    const startBlock = api.slice(api.indexOf("// All interfaces only with a valid list of who may connect"), api.indexOf("for (let attempt = 0; attempt < MCP_MAX_PORT_ATTEMPTS"));
    assert.match(startBlock, /if \(allow\.entries\.length === 0 \|\| allow\.errors\.length\) \{\s*listenAll = false;/);
    assert.match(startBlock, /server\.acceptFilter = \(trans\) => listenPeerAllowed\(trans\.getScriptablePeerAddr\(\)\.address, entries\);/);
  });
});
