"use strict";

// The HTTP server cuts off a client that does not finish sending its request in time, and only then: the timer
// is cancelled once the request is read, and when the connection closes.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const httpd = fs.readFileSync(path.resolve(__dirname, "../extension/httpd.sys.mjs"), "utf8");
const api = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

describe("request read timeout", () => {
  it("is 30 s of silence, 5 minutes in all", () => {
    assert.match(httpd, /export const REQUEST_READ_TIMEOUT_MS = 30000;/);
    assert.match(httpd, /export const REQUEST_READ_MAX_MS = 300000;/);
  });

  it("re-arms on progress, only within the overall limit", () => {
    const ready = httpd.slice(httpd.indexOf("  onInputStreamReady(input) {"), httpd.indexOf("  // PRIVATE API"));
    assert.match(ready, /Date\.now\(\) - conn\._readStartedAt < REQUEST_READ_MAX_MS\) \{\n\s*conn\._readTimer\.delay = REQUEST_READ_TIMEOUT_MS;/);
  });

  it("arms a timer for every accepted connection that closes it only while the request is unread", () => {
    const accept = httpd.slice(httpd.indexOf("onSocketAccepted(socket, trans) {"), httpd.indexOf("this._connections[connectionNumber] = conn;"));
    assert.match(accept, /readTimer\.initWithCallback\(/);
    assert.match(accept, /if \(reader\._state != READER_FINISHED && !conn\._closed\)/);
    assert.match(accept, /conn\._readTimer = readTimer;/);
  });

  it("cancels the timer once the request is read and when the connection closes", () => {
    const handle = httpd.slice(httpd.indexOf("  _handleResponse() {"), httpd.indexOf("this._connection.process(this._metadata);"));
    assert.match(handle, /this\._connection\._readTimer\.cancel\(\)/);
    const close = httpd.slice(httpd.indexOf("  close() {"), httpd.indexOf("this._closed = true;"));
    assert.match(close, /this\._readTimer\.cancel\(\)/);
  });
});

describe("listFolders refresh and getMessages headersOnly wiring", () => {
  it("refreshes only with a folderPath, before listing it", () => {
    const fn = api.slice(api.indexOf("async function listFolders("), api.indexOf("if (accountId) {", api.indexOf("async function listFolders(")));
    assert.match(fn, /refresh === true && !folderPath/);
    assert.ok(fn.indexOf("await refreshFolderFromServer(folder)") < fn.indexOf("walkFolder(folder, accountKey, 0)"));
  });

  it("never lets IMAP's FolderLoaded end its refresh", () => {
    const fn = api.slice(api.indexOf("// BEGIN FOLDER REFRESH"), api.indexOf("// END FOLDER REFRESH"));
    assert.match(fn, /!imapFolder && event === "FolderLoaded"/);
    assert.match(fn, /type === "nntp" \|\| type === "rss"/);
    assert.match(fn, /updateFolderWithListener\(null,/);
  });

  it("reads headers without the summary-sized raw read", () => {
    const fn = api.slice(api.indexOf("// BEGIN MESSAGE HEADERS"), api.indexOf("// END MESSAGE HEADERS"));
    assert.match(fn, /readRawHeaderBlock\(msgHdr\)/);
    assert.doesNotMatch(fn, /readRawMimeOuterEntity\(/);
    assert.doesNotMatch(fn, /getMessage\(/);
  });

  it("withholds the database subject unless encrypted content is allowed", () => {
    const fn = api.slice(api.indexOf("function messageHeadersOf("), api.indexOf("// END MESSAGE HEADERS"));
    assert.match(fn, /if \(isEncryptedContentAllowed\(\)\) set\("subject"/);
    assert.match(fn, /headers\.subjectWithheld = /);
  });

  it("opens each folder once and keeps the result under its budget", () => {
    const fn = api.slice(api.indexOf("async function getMessageHeaders("), api.indexOf("function messageHeadersOf("));
    assert.match(fn, /openedFolders\.get\(folderPath\)/);
    assert.match(fn, /findMessageInOpened\(opened, messageId\)/);
    assert.doesNotMatch(fn, /findMessage\(/);
    assert.match(fn, /out\.incomplete = true/);
  });

  it("dispatches headersOnly before the full read", () => {
    assert.match(api, /case "getMessages":\n\s*if \(args\.headersOnly === true\) return await getMessageHeaders\(args\.messages\);/);
  });
});
