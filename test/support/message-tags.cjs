// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The tag helpers of api.js (resolveMessageTags, resolveTagKey, getTagList), run against a
// stand-in for Thunderbird's tag service, for the harnesses that slice out updateMessage.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DEFAULT_TAGS = [
  { key: "$label1", tag: "Important" }, { key: "$label2", tag: "Work" }, { key: "$label3", tag: "Personal" },
  { key: "$label4", tag: "To Do" }, { key: "$label5", tag: "Later" },
];

function loadTagHelpers(tags = DEFAULT_TAGS) {
  const source = fs.readFileSync(path.resolve(__dirname, "../../extension/mcp_server/api.js"), "utf8");
  const start = source.indexOf("const VALID_TAG_KEYWORD");
  const end = source.indexOf("function getFilterListForAccount(", start);
  if (start < 0 || end < 0) throw new Error("tag helper markers missing in api.js");
  const sandbox = { MailServices: { tags: { getAllTags: () => tags } } };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)}
this.resolveMessageTags = resolveMessageTags; this.resolveTagKey = resolveTagKey; this.getTagList = getTagList;`, sandbox);
  return { resolveMessageTags: sandbox.resolveMessageTags, resolveTagKey: sandbox.resolveTagKey, getTagList: sandbox.getTagList };
}

module.exports = { loadTagHelpers, DEFAULT_TAGS };
