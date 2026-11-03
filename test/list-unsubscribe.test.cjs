"use strict";
// getMessages headersOnly: List-Unsubscribe / List-Unsubscribe-Post parsed for reading (LIST UNSUBSCRIBE region).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const api = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");
const region = api.slice(api.indexOf("// BEGIN LIST UNSUBSCRIBE"), api.indexOf("// END LIST UNSUBSCRIBE"));
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${region}\nthis.parse = parseListUnsubscribe;`, sandbox);
// Results come from another realm: compare through JSON
const parse = (value, post) => JSON.parse(JSON.stringify(sandbox.parse(value, post)));
const ONE_CLICK = "List-Unsubscribe=One-Click";

describe("parseListUnsubscribe", () => {
  it("reads a one-click https URI and a mailto", () => {
    assert.deepEqual(parse("<https://list.example.com/u?t=abc>, <mailto:unsub@example.com?subject=unsubscribe>", ONE_CLICK), {
      mailto: [{ address: "unsub@example.com", subject: "unsubscribe" }],
      https: ["https://list.example.com/u?t=abc"],
      oneClick: true,
    });
  });

  it("is one-click only with the exact Post value and an https URI", () => {
    const value = "<https://list.example.com/u>";
    assert.equal(parse(value, ONE_CLICK).oneClick, true);
    assert.equal(parse(value, `  ${ONE_CLICK} `).oneClick, true);
    assert.equal(parse(value).oneClick, false);
    assert.equal(parse(value, "List-Unsubscribe=one-click").oneClick, false);
    assert.equal(parse(value, `${ONE_CLICK}, ${ONE_CLICK}`).oneClick, false);
    assert.equal(parse(value, `${ONE_CLICK}; x=y`).oneClick, false);
    assert.equal(parse("<mailto:u@example.com>", ONE_CLICK).oneClick, false);
    assert.equal(parse("<http://list.example.com/u>", ONE_CLICK).oneClick, false);
  });

  it("decodes mailto subject and body, '+' kept, controls removed", () => {
    const [entry] = parse("<mailto:leave%2Blist@example.com?Subject=Stop%20please+now%0D%0ABcc:%20x@evil.test&body=line1%0D%0Aline2%00>").mailto;
    assert.deepEqual(entry, { address: "leave+list@example.com", subject: "Stop please+now Bcc: x@evil.test", body: "line1\nline2" });
  });

  it("keeps the first subject, drops a malformed one, keeps the address", () => {
    assert.deepEqual(parse("<mailto:a@example.com?subject=one&subject=two>").mailto, [{ address: "a@example.com", subject: "one" }]);
    assert.deepEqual(parse("<mailto:a@example.com?subject=%E0%A4%A>").mailto, [{ address: "a@example.com" }]);
    assert.deepEqual(parse("<mailto:a@example.com?subject=caf%C3%A9>").mailto, [{ address: "a@example.com", subject: "café" }]);
  });

  it("caps subject and body lengths", () => {
    const [entry] = parse(`<mailto:a@example.com?subject=${"s".repeat(300)}&body=${"b".repeat(1600)}>`).mailto;
    assert.equal(entry.subject.length, 200);
    assert.equal(entry.body.length, 1000);
  });

  it("reads several addresses and to=, ignores cc/bcc", () => {
    assert.deepEqual(parse("<mailto:a@example.com,b@example.com?to=c@example.com&cc=d@example.com&bcc=e@example.com>").mailto.map(e => e.address),
      ["a@example.com", "b@example.com", "c@example.com"]);
    assert.deepEqual(parse("<mailto:?to=only@example.com>").mailto.map(e => e.address), ["only@example.com"]);
  });

  it("drops invalid mailto addresses", () => {
    for (const bad of ["<mailto:>", "<mailto:nobody>", "<mailto:a@localhost>", "<mailto:a%20b@example.com>", "<mailto:%22a%22@example.com>",
      "<mailto:a@exa_mple.com>", "<mailto:a@-example.com>", "<mailto:a@[127.0.0.1]>", "<mailto:a%0D%0Abcc:x@example.com>",
      "<mailto:a@example.com%0D%0ABcc:x@evil.test>", "<mailto:a%E2%80%AE@example.com>", "<mailto:%ZZ@example.com>",
      `<mailto:${"a".repeat(250)}@example.com>`]) {
      assert.deepEqual(parse(bad), { mailto: [], https: [], oneClick: false, ignored: 1 }, bad);
    }
  });

  it("never returns other schemes", () => {
    const result = parse("<javascript:alert(1)>, <data:text/html,<b>x</b>>, <file:///etc/passwd>, <ftp://example.com/u>, <JavaScript://example.com/%0Aalert(1)>, <vbscript:x>, <tel:+15551234>, <https:example.com>, <//example.com/u>");
    assert.deepEqual(result.mailto, []);
    assert.deepEqual(result.https, []);
    assert.equal(result.insecure, undefined);
    assert.ok(result.ignored >= 9, String(result.ignored));
    assert.doesNotMatch(JSON.stringify(result), /javascript|data:|file:|ftp:|vbscript|tel:/i);
  });

  it("lists http apart as insecure", () => {
    assert.deepEqual(parse("<http://list.example.com/u?id=1>"), { mailto: [], https: [], oneClick: false, insecure: ["http://list.example.com/u?id=1"] });
  });

  it("rejects https URIs with user info, odd hosts, ports or characters", () => {
    for (const bad of ["https://good.example.com@evil.test/u", "https://user:pw@evil.test/", "https://localhost/u", "https://[::1]/u",
      "https://exa\u00A0mple.com/u", "https://example.com:0/u", "https://example.com:70000/u", "https://exаmple.com/u",
      "https://example.com/u\"onclick", "https://example.com/{x}", "https://example.com/a\\b", "https://example.com/é",
      "https://-bad.example.com/", "https://example.com‮/u", "https://", "https:///u"]) {
      assert.deepEqual(parse(`<${bad}>`).https, [], bad);
    }
  });

  it("normalizes scheme and host case, keeps path, port and query", () => {
    assert.deepEqual(parse("<HTTPS://List.Example.COM:8443/U/Path?Token=AbC#frag>").https, ["https://list.example.com:8443/U/Path?Token=AbC#frag"]);
    assert.deepEqual(parse("<https://xn--bcher-kva.example/u>").https, ["https://xn--bcher-kva.example/u"]);
    assert.deepEqual(parse("<https://list.example.com>").https, ["https://list.example.com"]);
  });

  it("skips comments, whitespace and folding, removes whitespace inside brackets", () => {
    assert.deepEqual(parse(" (Use this <https://evil.test/c> (nested) one) <https://list.example.com/very/\r\n long> ,\t(c)<mailto:\r\n\tu@example.com>  "), {
      mailto: [{ address: "u@example.com" }], https: ["https://list.example.com/very/long"], oneClick: false,
    });
    assert.deepEqual(parse("(a \\) still comment <https://evil.test/>) <https://ok.example.com/>").https, ["https://ok.example.com/"]);
  });

  it("does not take a URI outside angle brackets", () => {
    assert.deepEqual(parse("https://list.example.com/u, mailto:u@example.com"), { mailto: [], https: [], oneClick: false });
  });

  it("counts an unclosed bracket and keeps what came before", () => {
    assert.deepEqual(parse("<https://list.example.com/u>, <mailto:u@example.com"), { mailto: [], https: ["https://list.example.com/u"], oneClick: false, ignored: 1 });
  });

  it("handles empty and junk values", () => {
    for (const value of ["", "<>", "<<>>", ",,,", "()", "(((", ">>>", undefined, null, "<   >"]) {
      const result = parse(value);
      assert.deepEqual(result.mailto, [], String(value));
      assert.deepEqual(result.https, [], String(value));
      assert.equal(result.oneClick, false);
    }
  });

  it("caps URI counts and lengths, deduplicates", () => {
    const many = Array.from({ length: 30 }, (_, i) => `<https://l${i}.example.com/>`).join(",");
    const result = parse(many, ONE_CLICK);
    assert.equal(result.https.length, 5);
    assert.equal(result.ignored, 5);
    const mails = Array.from({ length: 8 }, (_, i) => `<mailto:u${i}@example.com>`).join(",");
    assert.equal(parse(mails).mailto.length, 5);
    assert.deepEqual(parse("<https://a.example.com/>,<HTTPS://A.example.com/>").https, ["https://a.example.com/"]);
    assert.equal(parse("<mailto:a@example.com>,<mailto:A@example.com>").mailto.length, 1);
    assert.deepEqual(parse(`<https://a.example.com/${"x".repeat(3000)}>`), { mailto: [], https: [], oneClick: false, ignored: 1 });
    const huge = `${"(".repeat(20000)}<https://a.example.com/>`;
    assert.deepEqual(parse(huge).https, []);
  });
});

describe("getMessages headersOnly wiring", () => {
  const fn = api.slice(api.indexOf("function messageHeadersOf("), api.indexOf("// END MESSAGE HEADERS"));
  it("parses the raw List-Unsubscribe values, not the clamped header", () => {
    assert.match(fn, /parseListUnsubscribe\(unsubscribeValues\.map\(decodeBytes\)\.join\(", "\)/);
    assert.match(fn, /\.\.\.\(unsubscribe \? \{ unsubscribe \} : \{\}\)/);
  });
});
