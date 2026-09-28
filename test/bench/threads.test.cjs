"use strict";
// T1, T2: threadOf and groupBy "thread" on the conversation fixtures (Inbox + Sent); T4: participant:@domain; T5: searchBody.
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, mcp, tbLib, closeAll, FOLDER } = require("./helpers.cjs");

const CHAIN = ["chain1@alpha.test", "chain2@bench.test", "chain3@alpha.test", "chain4@bench.test", "chain5@alpha.test"];

async function thread(messageId, folderPath, extra = {}) {
  const res = await mcp().call("searchMessages", { query: "", threadOf: { messageId, folderPath }, maxResults: 50, ...extra });
  assert.ok(Array.isArray(res.messages), JSON.stringify(res));
  return Object.fromEntries(res.messages.map(m => [m.id, m.linkedBy || "references"]));
}

// Gloda's company query (GlodaAutoComplete): email identities LIKE '%@domain', then messages involving them.
// Gloda drops deleted messages lazily, so drafts and sent copies other tests removed are left out.
const glodaDomainIds = domains => tbLib(`
  const { Gloda } = ChromeUtils.importESModule("resource:///modules/gloda/GlodaPublic.sys.mjs");
  const { GlodaConstants } = ChromeUtils.importESModule("resource:///modules/gloda/GlodaConstants.sys.mjs");
  const collect = query => new Promise(resolve => query.getCollection({
    onItemsAdded() {}, onItemsModified() {}, onItemsRemoved() {}, onQueryCompleted: c => resolve(c.items),
  }));
  const identities = [];
  for (const domain of args.domains) {
    const q = Gloda.newQuery(GlodaConstants.NOUN_IDENTITY);
    q.kind("email");
    q.valueLike(q.WILDCARD, domain);
    identities.push(...await collect(q));
  }
  const mq = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE);
  mq.involves(...identities);
  return [...new Set((await collect(mq)).filter(m => m.folderMessage).map(m => m.headerMessageID))].sort();
`, { domains });

describe("conversations (T1, T2)", { skip: SKIP }, () => {
  after(() => closeAll());

  it("threadOf returns the whole reference chain across Inbox and Sent from any of its messages", async () => {
    for (const [id, folder] of [[CHAIN[4], FOLDER.inbox], [CHAIN[1], FOLDER.sent], [CHAIN[0], FOLDER.inbox]]) {
      const members = await thread(id, folder);
      assert.deepEqual(Object.keys(members).sort(), CHAIN, id);
      assert.ok(Object.values(members).every(how => how === "references"), id);
    }
  });

  it("filters select messages of the conversation without cutting its links", async () => {
    const members = await thread(CHAIN[4], FOLDER.inbox, { endDate: "2026-03-02T12:00:00Z" });
    assert.deepEqual(Object.keys(members).sort(), CHAIN.slice(0, 3));
  });

  it("the Re: chain without References joins by subject; outreach and notifications stay separate", async () => {
    assert.deepEqual(await thread("noref1@gamma.test", FOLDER.inbox), {
      "noref1@gamma.test": "references", "noref2@bench.test": "subject", "noref3@gamma.test": "subject",
    });
    assert.deepEqual(await thread("outreach-b@bench.test", FOLDER.sent), {
      "outreach-b@bench.test": "references", "outreach-b-reply@epsilon.test": "subject",
    });
    assert.deepEqual(await thread("outreach-a-reply@delta.test", FOLDER.inbox), {
      "outreach-a@bench.test": "references", "outreach-a-reply@delta.test": "references",
    });
    assert.deepEqual(await thread("notify2@service.test", FOLDER.inbox), { "notify2@service.test": "references" });
  });

  it("groupBy thread groups by the same rules", async () => {
    const res = await mcp().call("searchMessages", { query: "", groupBy: "thread", maxResults: 100 });
    const counts = {};
    for (const g of res.groups) (counts[g.subject] ||= []).push(g.count);
    assert.deepEqual(counts["Project kickoff"], [5]);
    assert.deepEqual(counts["Invoice question"], [3]);
    assert.deepEqual(counts["Partnership proposal"], [2, 2]);
    assert.deepEqual(counts["Your weekly report"], [1, 1, 1]);
  });
});

describe("participant:@domain (T4)", { skip: SKIP }, () => {
  after(() => closeAll());

  const ids = async (query, extra = {}) => {
    const res = await mcp().call("searchMessages", { query, maxResults: 100, ...extra });
    return res.messages.map(m => m.id).sort();
  };

  it("returns incoming and sent mail of every listed domain, the same set as Gloda, decoy excluded", async () => {
    const ours = await ids("participant:@zeta.test,@zeta-group.test");
    assert.deepEqual(ours, ["company1@zeta.test", "company2@bench.test"]);
    assert.deepEqual(ours, await glodaDomainIds(["@zeta.test", "@zeta-group.test"]));
    assert.deepEqual(await ids("participant:@zeta.test"), ["company1@zeta.test"]);
    assert.ok((await ids("participant:zeta.test")).includes("decoy@zeta.testing"), "without @ it stays a substring");
    assert.deepEqual(await ids("participant:@zeta.test", { includeTrash: true }), ["company-trash@zeta.test", "company1@zeta.test"]);
  });
});

describe("searchBody (T5)", { skip: SKIP }, () => {
  after(() => closeAll());

  const body = query => mcp().call("searchMessages", { query, searchBody: true, maxResults: 50 });

  it("reports the terms Gloda leaves out; Cyrillic matches the exact word form only", async () => {
    const res = await body("цифры в приложении");
    assert.deepEqual(res.messages.map(m => m.id), ["charset-utf8@rho.test"]);
    assert.equal(res.warning, "Terms under 3 characters are not searched: в");
    assert.equal((await body("цифры")).messages.length, 1);
    assert.equal((await body("цифра")).messages.length, 0);
    assert.equal((await body("project")).warning, undefined);
    assert.match((await body("в на")).error, /at least 3 characters.*в, на/);
    const missing = await mcp().call("searchMessages", { query: "в project", searchBody: true, folderPath: "mailbox://nobody@nowhere.test/Inbox" });
    assert.match(missing.error, /^Folder not found/, JSON.stringify(missing));
  });
});

