// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// After an update, an open Add-ons Manager has drawn this add-on's card while
// no version of it ran (Options tab and button hidden, Mozilla bug 1667143):
// start() redraws that card, and only that card, in every open view.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const apiSource = fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8");
const start = apiSource.indexOf("// BEGIN ADDONS MANAGER REFRESH HELPERS");
const end = apiSource.indexOf("// END ADDONS MANAGER REFRESH HELPERS");
assert.ok(start >= 0 && end > start, "Add-ons Manager refresh helpers block missing");
const warnings = [];
const sandbox = { console: { warn: (...args) => warnings.push(args) } };
vm.createContext(sandbox);
vm.runInContext(`${apiSource.slice(start, end)}
this.openAddonsManagerViews = openAddonsManagerViews;
this.refreshAddonCards = refreshAddonCards;`, sandbox);
const { openAddonsManagerViews, refreshAddonCards } = sandbox;

const ID = "commonpost-mcp@commonpost.github.io";

function card(id) {
  return { addon: id === undefined ? undefined : { id }, updates: 0, update() { this.updates++; } };
}
function view(cards) {
  return { document: { querySelectorAll: selector => (selector === "addon-card" ? cards : []) } };
}

// A stand-in for Services.obs: each open Add-ons Manager answers EM-ping with EM-pong, as aboutaddons.mjs does.
function observerService(openViews, { failOnPing = false } = {}) {
  const observers = new Map();
  return {
    observers,
    addObserver(fn, topic) { observers.set(topic, [...(observers.get(topic) || []), fn]); },
    removeObserver(fn, topic) { observers.set(topic, (observers.get(topic) || []).filter(f => f !== fn)); },
    notifyObservers(subject, topic) {
      if (topic !== "EM-ping") return;
      if (failOnPing) throw new Error("observer service unavailable");
      for (const v of openViews) for (const fn of observers.get("EM-pong") || []) fn(v, "EM-pong", null);
    },
  };
}

describe("openAddonsManagerViews", () => {
  it("returns every open Add-ons Manager and removes its observer", () => {
    const views = [view([]), view([])];
    const obs = observerService(views);
    const found = openAddonsManagerViews(obs);
    assert.equal(found.length, 2);
    assert.equal(found[0], views[0]);
    assert.equal(found[1], views[1]);
    assert.deepEqual(obs.observers.get("EM-pong"), []);
  });

  it("returns nothing when no Add-ons Manager is open", () => {
    assert.equal(openAddonsManagerViews(observerService([])).length, 0);
  });

  it("removes its observer even when the ping fails", () => {
    const obs = observerService([view([])], { failOnPing: true });
    assert.throws(() => openAddonsManagerViews(obs), /observer service unavailable/);
    assert.deepEqual(obs.observers.get("EM-pong"), []);
  });
});

describe("refreshAddonCards", () => {
  it("redraws this add-on's card in every view, and no other card", () => {
    const ours = [card(ID), card(ID)];
    const others = [card("other@example.org"), card(undefined), { addon: { id: ID } }];
    const n = refreshAddonCards([view([others[0], ours[0]]), view([others[1], others[2], ours[1]])], ID);
    assert.equal(n, 2);
    assert.deepEqual(ours.map(c => c.updates), [1, 1]);
    assert.deepEqual(others.slice(0, 2).map(c => c.updates), [0, 0]);
  });

  it("does nothing without a view", () => {
    assert.equal(refreshAddonCards([], ID), 0);
  });

  it("a view that fails is reported and does not stop the others", () => {
    warnings.length = 0;
    const broken = { get document() { throw new Error("dead object"); } };
    const failing = { addon: { id: ID }, update() { throw new Error("render failed"); } };
    const ours = card(ID);
    const n = refreshAddonCards([broken, view([failing]), view([ours])], ID);
    assert.equal(n, 1);
    assert.equal(ours.updates, 1);
    assert.equal(warnings.length, 2);
  });
});

describe("wiring", () => {
  it("start() redraws this add-on's card before starting the server, and a failure does not stop it", () => {
    const i = apiSource.indexOf("start: async function() {");
    assert.ok(i > 0);
    const body = apiSource.slice(i, apiSource.indexOf("runGuardedStart(globalThis", i));
    assert.match(body, /try \{\s*refreshAddonCards\(openAddonsManagerViews\(Services\.obs\), context\.extension\.id\);\s*\} catch/);
  });
});
