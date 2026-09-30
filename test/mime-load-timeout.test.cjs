"use strict";
// loadMimeMessage is on the default path of replyToMessage / forwardMessage (the review window), so it is bounded:
// a window or a draft goes on without the parsed message, a direct send fails instead of hanging.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");

function slice(start, end) {
  const i = API.indexOf(start);
  assert.ok(i >= 0, `${start} not found`);
  const j = API.indexOf(end, i);
  assert.ok(j > i, `${end} not found`);
  return API.slice(i, j);
}
const waitAtMostSrc = slice("function waitAtMost(", "function asLocalMailFolder(");
const loadSrc = slice("const MIME_LOAD_TIMEOUT_MS", "/** Creates an nsIFile instance");

function load(mimeParse) {
  const timers = [];
  const sandbox = {
    Cc: {
      "@mozilla.org/timer;1": {
        createInstance: () => {
          const timer = {
            cancelled: false,
            initWithCallback(cb, ms) { timer.ms = ms; timer.fire = () => { if (!timer.cancelled) cb.notify(); }; },
            cancel() { timer.cancelled = true; },
          };
          timers.push(timer);
          return timer;
        },
      },
    },
    Ci: { nsITimer: { TYPE_ONE_SHOT: 0 } },
    ChromeUtils: { importESModule: () => ({ MsgHdrToMimeMessage: mimeParse }) },
    isEncryptedContentAllowed: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${waitAtMostSrc}\n${loadSrc}\nthis.loadMimeMessage = loadMimeMessage; this.limit = MIME_LOAD_TIMEOUT_MS;`, sandbox);
  return { loadMimeMessage: sandbox.loadMimeMessage, limit: sandbox.limit, timers };
}

describe("loadMimeMessage timeout", () => {
  it("is bounded below the bridge's 30 s request timeout", () => {
    const { limit, timers, loadMimeMessage } = load(() => {});
    assert.ok(limit > 0 && limit < 30000, `${limit} ms`);
    loadMimeMessage({});
    assert.equal(timers[0].ms, limit);
  });

  it("returns the parsed message, and stops the timer", async () => {
    const mime = { headers: {} };
    const { loadMimeMessage, timers } = load((hdr, _n, cb) => cb(hdr, mime));
    assert.equal(await loadMimeMessage({}, true), mime);
    assert.equal(timers[0].cancelled, true);
  });

  it("returns null when the message cannot be parsed", async () => {
    assert.equal(await load((hdr, _n, cb) => cb(hdr, null)).loadMimeMessage({}, true), null);
    assert.equal(await load(() => { throw new Error("boom"); }).loadMimeMessage({}, true), null);
  });

  it("goes on without the message on a timeout (review window, draft)", async () => {
    const { loadMimeMessage, timers } = load(() => {});
    const pending = loadMimeMessage({}, false);
    timers[0].fire();
    assert.equal(await pending, null);
  });

  it("fails a direct send on a timeout instead of hanging", async () => {
    const { loadMimeMessage, timers } = load(() => {});
    const pending = loadMimeMessage({}, true);
    timers[0].fire();
    await assert.rejects(pending, /did not return the original message within 20 s; nothing was sent/);
  });

  it("ignores a late answer after the timeout", async () => {
    let answer;
    const { loadMimeMessage, timers } = load((hdr, _n, cb) => { answer = () => cb(hdr, { late: true }); });
    const pending = loadMimeMessage({}, false);
    timers[0].fire();
    assert.equal(await pending, null);
    assert.doesNotThrow(() => answer());
  });

  it("both reply tools pass the direct-send flag, for mode send as well as skipReview", () => {
    // composeMode is "send" for both (resolveComposeMode), so mode: "send" without skipReview also fails on a timeout
    // instead of sending without the original to quote
    assert.equal(API.match(/await loadMimeMessage\(msgHdr, composeMode === "send"\)/g).length, 2);
    assert.ok(!API.includes("loadMimeMessage(msgHdr, !!skipReview)"));
  });
});
