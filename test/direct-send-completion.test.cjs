"use strict";
// sendMessageDirectly: on TB 128+ createAndSendMessage resolves when SMTP starts, so a send
// must wait for the SMTP outcome; drafts may complete on the promise or onStopCopy.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");
const region = API.slice(API.indexOf("// BEGIN DIRECT SEND"), API.indexOf("// END DIRECT SEND"));

const DeliverMode = { Now: 0, SaveAsDraft: 4 };

function load() {
  const sends = [];
  const timers = [];
  const Cc = {
    "@mozilla.org/timer;1": {
      createInstance: () => {
        const timer = { cancelled: false, initWithCallback(cb) { timer.fire = () => { if (!timer.cancelled) cb.notify(); }; }, cancel() { timer.cancelled = true; } };
        timers.push(timer);
        return timer;
      },
    },
    "@mozilla.org/messengercompose/send;1": {
      createInstance: () => ({
        createAndSendMessage(...args) {
          const send = { listener: args[12] };
          send.promise = new Promise((resolve, reject) => { send.resolve = resolve; send.reject = reject; });
          sends.push(send);
          return send.promise;
        },
      }),
    },
  };
  const sandbox = {
    Cc,
    Ci: { nsITimer: { TYPE_ONE_SHOT: 0 }, nsIMsgSend: {}, nsIMsgCompDeliverMode: DeliverMode },
    ChromeUtils: { generateQI: () => () => {} },
    Components: { isSuccessCode: status => status === 0 },
    MailServices: { accounts: { accounts: [] } },
    descsToMsgAttachments: () => [],
    accountKeyForIdentity: () => "",
  };
  vm.createContext(sandbox);
  vm.runInContext(`${region}\nthis.sendMessageDirectly = sendMessageDirectly;`, sandbox);
  return { send: sandbox.sendMessageDirectly, sends, timers };
}

const identity = { email: "me@example.test", fullName: "Me" };
const fields = () => ({ body: "hi", addAttachment() {} });
const pending = Symbol("pending");
const settled = (p) => Promise.race([p, new Promise(r => setImmediate(() => r(pending)))]);

describe("sendMessageDirectly completion", () => {
  it("does not report a send as done when SMTP has only started", async () => {
    const { send, sends } = load();
    const result = send(fields(), identity, [], null, 0, DeliverMode.Now, "text/plain");
    sends[0].resolve();
    assert.equal(await settled(result), pending);
    sends[0].listener.onStopSending("id", 0);
    assert.deepEqual({ ...(await result) }, { success: true, message: "Message sent" });
  });

  it("reports an SMTP failure after the promise resolved", async () => {
    const { send, sends } = load();
    const result = send(fields(), identity, [], null, 0, DeliverMode.Now, "text/plain");
    sends[0].resolve();
    await settled(result);
    sends[0].listener.onStopSending("id", 0x80553012);
    assert.match((await result).error, /Send failed/);
  });

  it("ignores the copy to Sent: only the SMTP outcome settles a send", async () => {
    const { send, sends } = load();
    const result = send(fields(), identity, [], null, 0, DeliverMode.Now, "text/plain");
    sends[0].listener.onStopCopy(0);
    assert.equal(await settled(result), pending);
    sends[0].listener.onStopSending("id", 0x80553012);
    assert.match((await result).error, /Send failed/);
  });

  it("reports a send that was not performed", async () => {
    const { send, sends } = load();
    const result = send(fields(), identity, [], null, 0, DeliverMode.Now, "text/plain");
    sends[0].listener.onSendNotPerformed("id", 0x80004005);
    assert.equal((await result).error, "Send was not performed");
  });

  it("reports a rejected promise as an error", async () => {
    const { send, sends } = load();
    const result = send(fields(), identity, [], null, 0, DeliverMode.Now, "text/plain");
    sends[0].reject(new Error("no outgoing server"));
    assert.match((await result).error, /no outgoing server/);
  });

  it("says a timed-out send has an unknown outcome", async () => {
    const { send, sends, timers } = load();
    const result = send(fields(), identity, [], null, 0, DeliverMode.Now, "text/plain");
    sends[0].resolve();
    await settled(result);
    timers[0].fire();
    assert.match((await result).error, /outcome is unknown.*Sent folder and the Outbox before retrying/);
  });

  it("does not time out a send that already finished", async () => {
    const { send, sends, timers } = load();
    const result = send(fields(), identity, [], null, 0, DeliverMode.Now, "text/plain");
    sends[0].listener.onStopSending("id", 0);
    timers[0].fire();
    assert.equal((await result).success, true);
  });

  it("completes a draft save on the promise", async () => {
    const { send, sends } = load();
    const result = send(fields(), identity, [], null, 0, DeliverMode.SaveAsDraft, "text/plain");
    sends[0].resolve();
    assert.equal((await result).success, true);
  });

  it("completes a draft save on onStopCopy", async () => {
    const { send, sends } = load();
    const result = send(fields(), identity, [], null, 0, DeliverMode.SaveAsDraft, "text/plain");
    sends[0].listener.onStopCopy(0);
    assert.deepEqual({ ...(await result) }, { success: true, message: "Saved" });
  });
});
