"use strict";
// Shared helpers for test/bench/*.test.cjs: bench state, MCP calls through mcp-bridge.cjs, Marionette, chrome-side library.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Marionette } = require("./marionette.cjs");

const ROOT = path.resolve(__dirname, "../..");
const STATE_FILE = process.env.TB_BENCH_STATE || path.join(ROOT, ".cache/tb-bench/state.json");

// Running bench state, or null (tests skip).
function benchState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    process.kill(state.pid, 0);
    return state;
  } catch {
    return null;
  }
}

const state = benchState();
const SKIP = state ? false : "bench not running (scripts/tb-bench.sh start, or npm run test:tb)";

class BridgeClient {
  constructor(connectionFile) {
    this.proc = spawn(process.execPath, [path.join(ROOT, "mcp-bridge.cjs")], {
      env: { ...process.env, COMMONPOST_MCP_CONNECTION_FILE: connectionFile },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", chunk => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p(msg); }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  // Tool result as parsed JSON (text content), with isError kept as a property.
  async call(name, args = {}) {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg.error) throw new Error(`${name}: ${msg.error.message}`);
    const text = msg.result?.content?.[0]?.text ?? "";
    let value;
    try { value = JSON.parse(text); } catch { value = { text }; }
    if (msg.result?.isError && value && typeof value === "object") value.isError = true;
    return value;
  }

  close() {
    try { this.proc.stdin.end(); } catch { /* gone */ }
    try { this.proc.kill(); } catch { /* gone */ }
  }
}

let bridge = null;
let marionette = null;

function mcp() {
  if (!bridge) bridge = new BridgeClient(state.connectionFile);
  return bridge;
}

async function chrome() {
  if (!marionette) marionette = await new Marionette(state.marionettePort).start();
  return marionette;
}

// Privileged JS in Thunderbird's parent process (body of an async function, `args` available).
async function tb(source, args) {
  return (await chrome()).exec(source, args);
}

// Chrome-side helpers for tbLib() sources: folders, headers, raw source, native compose windows.
const CHROME_LIB = String.raw`
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const tick = () => new Promise(r => Services.tm.dispatchToMainThread(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 10000) {
  for (let t = 0; t < ms; t += 50) {
    const value = fn();
    if (value) return value;
    await sleep(50);
  }
  throw new Error("timed out waiting for " + what);
}
const folder = uri => MailServices.folderLookup.getFolderForURL(uri);
const hdrs = uri => [...folder(uri).msgDatabase.enumerateMessages()];
const hdrById = (uri, id) => hdrs(uri).find(h => h.messageId === id) || null;
const uriOf = h => h.folder.getUriForMsg(h);
const hdrOfURI = uri => MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
const draftState = h => ({ origURIs: h.getStringProperty("origURIs"), queuedDisposition: h.getStringProperty("queuedDisposition") });
function clearFolder(uri) {
  const list = hdrs(uri);
  if (list.length) folder(uri).deleteMessages(list, null, true, false, null, false);
}
// Waits while a copy into the folder still holds its lock.
async function rawOf(h) {
  const uri = uriOf(h);
  await waitFor(() => !h.folder.locked, "folder unlock");
  return new Promise((resolve, reject) => {
    let data = "";
    const sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
    MailServices.messageServiceFromURI(uri).streamMessage(uri, {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest() {},
      onDataAvailable(req, stream, off, count) { sis.init(stream); data += sis.read(count); },
      onStopRequest(req, status) { Components.isSuccessCode(status) ? resolve(data) : reject(new Error("stream " + status)); },
    }, null, null, false, "", false);
  });
}
function headersOf(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}
// Next compose window, resolved once Thunderbird has loaded its body.
function nextComposeWindow() {
  return new Promise(resolve => {
    const obs = { observe(win, topic) {
      if (topic !== "domwindowopened") return;
      // compose-window-init does not bubble: capture it on the window
      win.addEventListener("compose-window-init", () => {
        Services.ww.unregisterNotification(obs);
        win.gMsgCompose.RegisterStateListener({
          QueryInterface: ChromeUtils.generateQI(["nsIMsgComposeStateListener"]),
          NotifyComposeFieldsReady() {}, ComposeProcessDone() {}, SaveInFolderDone() {},
          NotifyComposeBodyReady() { tick().then(() => resolve(win)); },
        });
      }, { once: true, capture: true });
    } };
    Services.ww.registerNotification(obs);
  });
}
// Compose window as mailCommands.js ComposeMessage opens it without catch-all identities (and without
// its no-reply prompt), resolved once the body is loaded.
async function openNativeCompose(type, h) {
  const { MailUtils } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
  const opened = nextComposeWindow();
  const [identity] = MailUtils.getIdentityForHeader(h, type);
  MailServices.compose.OpenComposeWindow(null, h, uriOf(h), type, Ci.nsIMsgCompFormat.Default, identity, null, null, null, false);
  return opened;
}
// The user's path: the message shown in the 3-pane window, then its Reply / Forward command (ComposeMessage).
async function composeFromMessagePane(type, h) {
  const { MailUtils } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
  const win = Services.wm.getMostRecentWindow("mail:3pane");
  MailUtils.displayMessageInFolderTab(h);
  await waitFor(() => win.document.getElementById("tabmail").currentAboutMessage?.currentHeaderData?.["message-id"]?.headerValue.includes(h.messageId), "message displayed");
  const opened = nextComposeWindow();
  await win.ComposeMessage(type, Ci.nsIMsgCompFormat.Default, h.folder, [uriOf(h)]);
  return opened;
}
async function saveNativeDraft(win) {
  await win.SaveAsDraft();
  return hdrOfURI(await waitFor(() => win.gMsgCompose.compFields.draftId, "native draft"));
}
async function closeCompose(win) {
  win.gContentChanged = false;
  win.gMsgCompose.bodyModified = false;
  win.close();
  await waitFor(() => win.closed, "compose window close");
}
`;

// tb() with CHROME_LIB in scope.
async function tbLib(source, args) {
  return tb(`${CHROME_LIB}\n${source}`, args);
}

function closeAll() {
  if (bridge) bridge.close();
  if (marionette) marionette.close();
  bridge = null;
  marionette = null;
}

const FOLDER = {
  inbox: "mailbox://benchuser@127.0.0.1/Inbox",
  sent: "mailbox://benchuser@127.0.0.1/Sent",
  drafts: "mailbox://benchuser@127.0.0.1/Drafts",
  trash: "mailbox://benchuser@127.0.0.1/Trash",
};

module.exports = { ROOT, state, SKIP, mcp, tb, tbLib, chrome, closeAll, FOLDER };
