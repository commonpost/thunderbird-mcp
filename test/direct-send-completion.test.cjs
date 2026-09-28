"use strict";
// sendMessageDirectly: on TB 128+ createAndSendMessage resolves when SMTP starts, so a send
// must wait for onStopSending; drafts may complete on the promise alone.
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
  const Cc = {
    "@mozilla.org/timer;1": { createInstance: () => ({ initWithCallback() {}, cancel() {} }) },
    "@mozilla.org/messengercompose/send;1": {
      createInstance: () => ({
        createAndSendMessage(...args) {
          const send = { listener: args[12] };
          send.promise = new Promise(resolve => { send.resolve = resolve; });
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
  return { send: sandbox.sendMessageDirectly, sends };
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

  it("completes a draft save on the promise", async () => {
    const { send, sends } = load();
    const result = send(fields(), identity, [], null, 0, DeliverMode.SaveAsDraft, "text/plain");
    sends[0].resolve();
    assert.equal((await result).success, true);
  });
});
