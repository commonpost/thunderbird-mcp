// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// Hidden text judged by Thunderbird's layout engine, the api.js side: the units of a body, finding them among the
// units of the rendered message, the background page's answer, the judge built from its verdicts, the messages it is
// used for, and the request to the background page. The rendering itself runs in a real Thunderbird (lab scenarios);
// extension/engine-visibility.js has its own tests (engine-visibility.test.cjs).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const region = name => {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} missing`);
  return source.slice(start, end);
};

// A small DOM: elements and text nodes with parents, as engineUnits and the converters read them
const VOID = new Set(["br", "hr", "img", "input", "meta", "link"]);
function element(tag, attrs = {}) {
  return {
    nodeType: 1, tagName: tag.toUpperCase(), localName: tag, childNodes: [], parentElement: null,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    hasAttribute: name => name in attrs,
    get textContent() { return this.childNodes.map(c => c.textContent).join(""); },
  };
}
const text = (data, parent) => ({ nodeType: 3, data, parentElement: parent, get textContent() { return this.data; } });
function parse(html) {
  const root = element("html");
  const body = element("body");
  body.parentElement = root;
  root.childNodes.push(body);
  const stack = [body];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) top.childNodes.push({ nodeType: 8, textContent: "" });
    else if (m[4] !== undefined) top.childNodes.push(text(m[4], top));
    else if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else {
      const attrs = {};
      for (const a of m[3].matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) attrs[a[1]] = a[2] ?? a[3] ?? "";
      const node = element(m[2].toLowerCase(), attrs);
      node.parentElement = top;
      top.childNodes.push(node);
      if (!VOID.has(m[2].toLowerCase())) stack.push(node);
    }
  }
  return { documentElement: root, body };
}

const sandbox = { DOMParser: class { parseFromString(html) { return parse(html); } } };
vm.createContext(sandbox);
vm.runInContext(`${region("STRIP HELPERS")}
${region("ENCRYPTED MESSAGE HELPERS")}
${region("ENGINE VISIBILITY HELPERS")}
${region("ENGINE RENDER CHANNEL")}
${region("HTML HIDDEN CONTENT HELPERS")}
this.api = { engineUnits, alignEngineUnits, parseEngineRender, engineHiddenContentJudge, engineHidingFor,
  engineMessageKind, engineViewport, isMessagePartUrl, addEngineRenderListener, requestEngineRender,
  engineRenderChannel, htmlToMarkdown, emailHtmlToText, ENGINE_DEFAULT_VIEWPORT, ENGINE_PAUSE_MS };`, sandbox);
const api = sandbox.api;
const keysOf = html => Array.from(api.engineUnits(parse(html).documentElement), u => u.key);

describe("engineUnits", () => {
  it("gives the runs of text with more than white space, images and links, in document order", () => {
    assert.deepEqual(keysOf("<p>one</p> <div>two<b>three</b></div><img alt=\"pic\"><a href=\"x\">four</a>"),
      ["one", "two", "three", "\u0000img\u0000pic", "\u0000a", "four"]);
  });

  it("leaves out the elements whose text is never rendered", () => {
    assert.deepEqual(keysOf("<p>a</p><script>s</script><style>t</style><title>u</title><template>v</template>"
      + "<noembed>w</noembed><noframes>x</noframes><iframe>y</iframe><p>b</p>"), ["a", "b"]);
  });

  it("joins adjacent text nodes, as a document parsed again from its serialisation has them", () => {
    const doc = parse("<p>x</p>");
    const p = doc.body.childNodes[0];
    p.childNodes.push(text("y", p));
    assert.deepEqual(Array.from(api.engineUnits(doc.documentElement), u => u.key), ["xy"]);
    assert.equal(api.engineUnits(doc.documentElement)[0].nodes.length, 2);
  });

  it("ends a run at a comment and gives an image without alt an empty one", () => {
    assert.deepEqual(keysOf("<p>a<!-- c -->b<img></p>"), ["a", "b", "\u0000img\u0000"]);
  });

  it("refuses a document with too many units", () => {
    assert.throws(() => api.engineUnits(parse("<b>x</b>".repeat(200002)).documentElement), /too many units/);
  });
});

describe("alignEngineUnits", () => {
  it("finds the body's units in a row among the rendered document's", () => {
    assert.equal(api.alignEngineUnits(["b", "c"], ["Subject:", "a", "b", "c", "d"]), 2);
    assert.equal(api.alignEngineUnits(["a"], ["a"]), 0);
  });

  it("answers -1 when they are not there in a row, and for no units or more than there are", () => {
    assert.equal(api.alignEngineUnits(["b", "d"], ["a", "b", "c", "d"]), -1);
    assert.equal(api.alignEngineUnits([], ["a"]), -1);
    assert.equal(api.alignEngineUnits(["a", "b"], ["a"]), -1);
  });

  it("answers -2 when they are there more than once, overlapping runs included", () => {
    assert.equal(api.alignEngineUnits(["x", "y"], ["x", "y", "z", "x", "y"]), -2);
    assert.equal(api.alignEngineUnits(["a", "a"], ["a", "a", "a"]), -2);
  });

  it("restarts within a partial match (failure function)", () => {
    assert.equal(api.alignEngineUnits(["a", "a", "b"], ["a", "a", "a", "b"]), 1);
    assert.equal(api.alignEngineUnits(["a", "b", "a", "c"], ["a", "b", "a", "b", "a", "c"]), 2);
  });
});

describe("parseEngineRender", () => {
  it("keeps the keys and turns the verdicts into a set", () => {
    const parsed = api.parseEngineRender({ ok: true, keys: ["a", "b"], hidden: [1] });
    assert.deepEqual(Array.from(parsed.keys), ["a", "b"]);
    assert.ok(parsed.hidden.has(1) && !parsed.hidden.has(0));
  });

  it("gives the background page's own error, shortened", () => {
    assert.equal(api.parseEngineRender({ ok: false, error: "viewport" }).error, "viewport");
    assert.equal(api.parseEngineRender({ ok: false, error: "x".repeat(300) }).error.length, 100);
    assert.equal(api.parseEngineRender({ ok: false }).error, "render failed");
  });

  it("refuses anything else", () => {
    assert.equal(api.parseEngineRender(undefined).error, "no answer");
    assert.equal(api.parseEngineRender("ok").error, "no answer");
    assert.equal(api.parseEngineRender({ ok: true, keys: "a", hidden: [] }).error, "bad keys");
    assert.equal(api.parseEngineRender({ ok: true, keys: [1], hidden: [] }).error, "bad keys");
    assert.equal(api.parseEngineRender({ ok: true, keys: ["a"], hidden: [1] }).error, "bad verdicts");
    assert.equal(api.parseEngineRender({ ok: true, keys: ["a"], hidden: [0.5] }).error, "bad verdicts");
    assert.equal(api.parseEngineRender({ ok: true, keys: ["a"], hidden: "0" }).error, "bad verdicts");
  });
});

// The rendered message: a header unit, then the body's units, and the indices (in the body) of the hidden ones
function engineFor(html, hiddenInBody) {
  const keys = ["Subject: ", ...keysOf(html)];
  return { keys, hidden: new Set(hiddenInBody.map(i => i + 1)) };
}

describe("htmlToMarkdown and emailHtmlToText with the engine's verdicts", () => {
  const html = "<p>shown</p><div class=\"x\"><p>gone one</p><p>gone two</p></div><p>kept</p>"
    + "<img alt=\"logo\" width=\"40\" height=\"40\"><a href=\"https://example.com/a\"><img alt=\"\" width=\"40\" height=\"40\"></a>";
  // units: shown, gone one, gone two, kept, img logo, a, img ""
  const engine = engineFor(html, [1, 2, 4, 5, 6]);

  it("removes the units the engine hides, counts their highest hidden element once, and says it decided", () => {
    const counter = { n: 0 };
    const md = api.htmlToMarkdown(html, counter, engine);
    assert.match(md, /shown/);
    assert.match(md, /kept/);
    assert.doesNotMatch(md, /gone|logo|example\.com/);
    // the div with both hidden paragraphs and the image with its alt text; the link holds no text to count
    assert.equal(counter.n, 2);
    assert.equal(counter.judge, "layout");
  });

  it("does the same for the text format", () => {
    const counter = { n: 0 };
    const out = api.emailHtmlToText(html, counter, engine);
    assert.match(out, /shown/);
    assert.doesNotMatch(out, /gone/);
    assert.equal(counter.judge, "layout");
  });

  it("gives nothing for elements whose text is never rendered, even in the body", () => {
    const body = "<p>shown</p><title>Subject line</title><template>t</template><iframe>i</iframe>";
    const counter = { n: 0 };
    const md = api.htmlToMarkdown(body, counter, engineFor(body, []));
    assert.match(md, /shown/);
    assert.doesNotMatch(md, /Subject line|\bt\b|\bi\b/);
    // counted as the inline-style reading counts them: the <template>, and the <title> and <iframe> holding text
    assert.equal(counter.n, 3);
    assert.equal(counter.judge, "layout");
  });

  it("keeps what the engine shows even where the inline styles would hide it", () => {
    const styled = "<p style=\"display:none\">styled</p><p>plain</p>";
    const counter = { n: 0 };
    assert.match(api.htmlToMarkdown(styled, counter, engineFor(styled, [])), /styled/);
    assert.equal(counter.n, 0);
  });

  it("uses the inline styles and the engine's verdicts by text when the body is not found once in a row", () => {
    const styled = "<p style=\"display:none\">styled</p><p>plain</p>";
    const counter = { n: 0 };
    const md = api.htmlToMarkdown(styled, counter, { keys: ["other"], hidden: new Set() });
    assert.doesNotMatch(md, /styled/);
    assert.match(md, /plain/);
    assert.equal(counter.judge, "layout and inline styles: not found in the rendered message");
    // The same text twice in the rendered message, hidden once: a sender cannot shed the engine's verdict this way
    const body = "<p>visible</p><p>secret</p>";
    const twice = { keys: ["visible", "secret", "visible", "secret"], hidden: new Set([1]) };
    const again = { n: 0 };
    const out = api.htmlToMarkdown(body, again, twice);
    assert.doesNotMatch(out, /secret/);
    assert.match(out, /visible/);
    assert.equal(again.judge, "layout and inline styles: ambiguous in the rendered message");
    assert.equal(again.n, 1);
    const none = { n: 0 };
    api.htmlToMarkdown("<p> </p>", none, twice);
    assert.equal(none.judge, "fallback: no text");
  });

  it("finds the body even where white space at the edge of a run differs", () => {
    const body = "<p>first</p><p>last line</p>\n\n";
    const keys = ["Subject: ", "first", "last line\n\n\n\n"];
    const counter = { n: 0 };
    api.htmlToMarkdown(body, counter, { keys, hidden: new Set([1]) });
    assert.equal(counter.judge, "layout");
    assert.equal(counter.n, 1);
  });

  it("says the inline styles decided when no engine was asked", () => {
    const counter = { n: 0 };
    api.htmlToMarkdown("<p>a</p>", counter);
    assert.equal(counter.judge, "inline styles");
    const kept = { n: 0, judge: "fallback: no local copy" };
    api.emailHtmlToText("<p>a</p>", kept);
    assert.equal(kept.judge, "fallback: no local copy");
  });
});

describe("engineMessageKind", () => {
  const html = { contentType: "text/html" };
  it("needs an HTML part", () => {
    assert.equal(api.engineMessageKind({ contentType: "multipart/alternative", parts: [{ contentType: "text/plain" }, html] }), "html");
    assert.equal(api.engineMessageKind({ contentType: "text/plain" }), "no html");
    assert.equal(api.engineMessageKind({ headers: { "content-type": ["text/html; charset=utf-8"] } }), "html");
  });

  it("refuses a message that would be decrypted or verified to be shown, and one it cannot read", () => {
    for (const type of ["multipart/signed", "multipart/encrypted", "application/pkcs7-mime", "application/pgp-signature",
      "application/x-pkcs7-signature"]) {
      assert.equal(api.engineMessageKind({ contentType: "multipart/mixed", parts: [html, { contentType: type }] }), "crypto", type);
    }
    assert.equal(api.engineMessageKind({ get parts() { throw new Error("unreadable"); } }), "crypto");
    const deep = { parts: [] };
    for (let i = 0, p = deep; i < 6000; i++, p = p.parts[0]) p.parts = [{ parts: [] }];
    assert.equal(api.engineMessageKind(deep), "crypto");
  });
});

describe("engineViewport", () => {
  it("takes the pane's size in CSS pixels of its content", () => {
    assert.deepEqual({ ...api.engineViewport(565, 690, 1) }, { width: 565, height: 690 });
    assert.deepEqual({ ...api.engineViewport(1200, 900, 1.5) }, { width: 800, height: 600 });
    assert.deepEqual({ ...api.engineViewport(800, 600, 0) }, { width: 800, height: 600 });
  });

  it("uses the default size for a pane too small, too large or unknown", () => {
    for (const [w, h] of [[0, 0], [150, 800], [800, 150], [20000, 800], [NaN, 600]]) {
      assert.deepEqual({ ...api.engineViewport(w, h, 1) }, { ...api.ENGINE_DEFAULT_VIEWPORT }, `${w}x${h}`);
    }
  });
});

describe("isMessagePartUrl", () => {
  const mailbox = "mailbox:///profile/Mail/Local%20Folders/Inbox?number=2";
  const imap = "imap://user@imap.example.test:993/fetch%3EUID%3E/INBOX%3E123";
  it("accepts a part of the same message", () => {
    assert.ok(api.isMessagePartUrl(`${mailbox}&part=1.2&type=image/png&filename=logo.png`, mailbox));
    assert.ok(api.isMessagePartUrl(`${imap}?part=1.2&filename=logo.png`, imap));
  });

  it("refuses another message, another folder, no part, or no message url", () => {
    assert.ok(!api.isMessagePartUrl("mailbox:///profile/Mail/Local%20Folders/Inbox?number=23&part=1.2", mailbox));
    assert.ok(!api.isMessagePartUrl("mailbox:///profile/Mail/Local%20Folders/Sent?number=2&part=1.2", mailbox));
    assert.ok(!api.isMessagePartUrl(`${mailbox}&type=image/png`, mailbox));
    assert.ok(!api.isMessagePartUrl(`${mailbox}&part=1.2x`, mailbox));
    assert.ok(!api.isMessagePartUrl(`${imap}0?part=1.2`, imap));
    assert.ok(!api.isMessagePartUrl("cid:logo@example.test", mailbox));
    assert.ok(!api.isMessagePartUrl(`${mailbox}&part=1.2`, ""));
    assert.ok(!api.isMessagePartUrl(null, mailbox));
  });
});

describe("requestEngineRender", () => {
  // Timers that fire only when the test says so
  function clock() {
    const timers = [];
    let now = 1000;
    return {
      now: () => now,
      advance(ms) { now += ms; },
      after: (ms, callback) => {
        const timer = { callback, cancelled: false, cancel() { this.cancelled = true; } };
        timers.push(timer);
        return timer;
      },
      fire() { for (const t of timers) if (!t.cancelled) t.callback(); },
      timers,
    };
  }
  const reset = () => {
    api.engineRenderChannel.listeners.length = 0;
    api.engineRenderChannel.pausedUntil = 0;
  };

  it("says when no background page listens", async () => {
    reset();
    const c = clock();
    assert.equal((await api.requestEngineRender({}, 100, c.after, c.now)).error, "no background page");
  });

  it("asks the newest listener and gives its checked answer", async () => {
    reset();
    const c = clock();
    const jobs = [];
    const removeOld = api.addEngineRenderListener({ async: () => ({ ok: false, error: "old" }) });
    api.addEngineRenderListener({ async: job => { jobs.push(job); return { ok: true, keys: ["a"], hidden: [0] }; } });
    const answer = await api.requestEngineRender({ nonce: "n" }, 100, c.after, c.now);
    assert.deepEqual(Array.from(answer.keys), ["a"]);
    assert.equal(jobs[0].nonce, "n");
    assert.ok(c.timers.every(t => t.cancelled), "the timer is cancelled");
    removeOld();
    removeOld();
    assert.equal(api.engineRenderChannel.listeners.length, 1);
  });

  it("gives up after its own timeout, and pauses the engine", async () => {
    reset();
    const c = clock();
    api.addEngineRenderListener({ async: () => new Promise(() => {}) });
    const pending = api.requestEngineRender({}, 100, c.after, c.now);
    c.fire();
    assert.equal((await pending).error, "timeout");
    assert.equal((await api.requestEngineRender({}, 100, c.after, c.now)).error, "engine paused");
    c.advance(api.ENGINE_PAUSE_MS + 1);
    const again = api.requestEngineRender({}, 100, c.after, c.now);
    c.fire();
    assert.equal((await again).error, "timeout");
  });

  it("pauses the engine when the background page goes away during a render", async () => {
    reset();
    const c = clock();
    const abort = Object.assign(new Error("Actor 'Conduits' destroyed"), { name: "AbortError" });
    api.addEngineRenderListener({ async: () => Promise.reject(abort) });
    assert.equal((await api.requestEngineRender({}, 100, c.after, c.now)).error, "background page gone");
    assert.ok(api.engineRenderChannel.pausedUntil > c.now());
  });

  it("does not pause for a rejected render, a throwing listener or no answer", async () => {
    reset();
    const c = clock();
    api.addEngineRenderListener({ async: () => Promise.reject(new Error("boom")) });
    assert.equal((await api.requestEngineRender({}, 100, c.after, c.now)).error, "render rejected");
    reset();
    api.addEngineRenderListener({ async: () => { throw new Error("sync"); } });
    assert.equal((await api.requestEngineRender({}, 100, c.after, c.now)).error, "render rejected");
    reset();
    api.addEngineRenderListener({ async: () => undefined });
    assert.equal((await api.requestEngineRender({}, 100, c.after, c.now)).error, "no answer");
    assert.equal(api.engineRenderChannel.pausedUntil, 0);
  });
});
