"use strict";
// H1/H2: the bench itself - isolated profile, default account, fixtures, Gloda.
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ROOT, state, SKIP, mcp, tb, closeAll, FOLDER } = require("./helpers.cjs");

describe("bench", { skip: SKIP }, () => {
  after(closeAll);

  it("keeps connection.json and the profile under .cache/tb-bench", () => {
    const bench = path.join(ROOT, ".cache/tb-bench");
    assert.ok(state.connectionFile.startsWith(bench));
    assert.ok(state.profileDir.startsWith(bench));
  });

  it("runs chrome scripts through Marionette", async () => {
    const res = await tb("return { version: Services.appinfo.version, name: Services.appinfo.name };");
    assert.equal(res.name, "Thunderbird");
    assert.equal(res.version, state.version.replace(/esr$/, ""));
  });

  it("uses the POP3 account as default, like a real profile", async () => {
    const res = await tb(`
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const a = MailServices.accounts.defaultAccount;
      return { type: a.incomingServer.type, email: a.defaultIdentity.email, drafts: a.defaultIdentity.draftsFolderURI };
    `);
    assert.deepEqual(res, { type: "pop3", email: "me@bench.test", drafts: FOLDER.drafts });
  });

  it("loads the fixtures and indexes them in Gloda (Trash excluded)", () => {
    assert.equal(state.ready.folders[FOLDER.inbox], 23);
    assert.equal(state.ready.folders[FOLDER.sent], 8);
    assert.equal(state.ready.folders[FOLDER.trash], 1);
    assert.equal(state.ready.indexed, state.expectedIndexed);
  });

  it("serves MCP tools through mcp-bridge.cjs", async () => {
    const accounts = await mcp().call("listAccounts");
    assert.ok(accounts.some(a => a.type === "pop3" && a.identities[0].email === "me@bench.test"));
  });
});
