"use strict";
// Reply, forward and new-message draft bodies (cite line, quote, forward header, signature, layout, charset) equal
// what Thunderbird's own compose window saves with the same text typed at its caret; an edited draft equals a fresh
// one with the new text.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, state, mcp, tbLib, closeAll, FOLDER } = require("./helpers.cjs");

const TEXT = "Hello there, Ünïcode ок";

// Body of a raw message: transfer encoding and charset decoded, format=flowed joined (RFC 3676).
function decodeBody(raw) {
  const sep = raw.search(/\r?\n\r?\n/);
  const head = raw.slice(0, sep).replace(/\r?\n[ \t]+/g, " ");
  const body = raw.slice(sep).replace(/^\r?\n\r?\n/, "");
  const header = name => (head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "mi")) || [])[1] || "";
  const contentType = header("Content-Type");
  const cte = header("Content-Transfer-Encoding").toLowerCase();
  let bytes;
  if (cte === "base64") bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  else if (cte === "quoted-printable") bytes = Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
  else bytes = Buffer.from(body, "latin1");
  const charset = (contentType.match(/charset="?([^";\s]+)/i) || [])[1] || "utf-8";
  let text = new TextDecoder(charset).decode(bytes).replace(/\r\n/g, "\n");
  if (/format="?flowed/i.test(contentType)) text = unflow(text, /delsp="?yes/i.test(contentType));
  return { type: contentType.split(";")[0].trim().toLowerCase(), contentType, charset: charset.toLowerCase(), cte, text, size: bytes.length };
}

function unflow(text, delsp) {
  const out = [];
  let cur = null;
  for (let line of text.split("\n")) {
    const depth = line.match(/^>*/)[0].length;
    line = line.slice(depth);
    if (line.startsWith(" ")) line = line.slice(1);
    const flowed = line.endsWith(" ") && line !== "-- ";
    if (delsp && flowed) line = line.slice(0, -1);
    if (cur && cur.depth === depth) cur.text += line;
    else {
      if (cur) out.push(cur);
      cur = { depth, text: line };
    }
    if (!flowed) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.map(l => (l.depth ? `${">".repeat(l.depth)} ` : "") + l.text).join("\n");
}

const plainForm = text => text.split("\n").map(l => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");

// Canonical <body>: attributes sorted, whitespace collapsed outside <pre>, none around block tags.
const CANONICAL = String.raw`
function canonical(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");
  const walk = (node, pre) => {
    if (node.nodeType === 3) return esc(pre ? node.data : node.data.replace(/\s+/g, " "));
    if (node.nodeType !== 1) return "";
    const name = node.localName;
    const attrs = [...node.attributes].map(a => a.name.toLowerCase() + '="' + esc(a.value) + '"').sort();
    const open = "<" + name + (attrs.length ? " " + attrs.join(" ") : "") + ">";
    if (["br", "img", "meta", "hr", "input"].includes(name)) return open;
    return open + [...node.childNodes].map(c => walk(c, pre || name === "pre")).join("") + "</" + name + ">";
  };
  const BLOCK = "p|div|blockquote|ul|ol|li|table|tbody|thead|tr|td|th|pre|body|h[1-6]|meta|br";
  let out = walk(doc.body, false);
  out = out.replace(new RegExp("\\s*(</?(?:" + BLOCK + ")\\b[^>]*>)\\s*", "g"), "$1");
  // The editor's padding <br> at the end of a block
  out = out.replace(/([^>]|<\/(?:b|i|a|span|u)>)<br>(<\/(?:p|div|li|td|blockquote)>)/g, "$1$2");
  return out;
}
`;

// Identity settings and prefs for one scenario; returns the previous values.
const applySettings = (identity, prefs) => tbLib(`
  const identity = MailServices.accounts.defaultAccount.defaultIdentity;
  const prev = { identity: Object.fromEntries(Object.keys(args.identity).map(k => [k, identity[k]])), prefs: {} };
  Object.assign(identity, args.identity);
  for (const [name, value] of Object.entries(args.prefs)) {
    prev.prefs[name] = Services.prefs.prefHasUserValue(name) ? Services.prefs.getBoolPref(name) : null;
    Services.prefs.setBoolPref(name, value);
  }
  return prev;
`, { identity, prefs });

const restoreSettings = prev => tbLib(`
  Object.assign(MailServices.accounts.defaultAccount.defaultIdentity, args.prev.identity);
  for (const [name, value] of Object.entries(args.prev.prefs)) {
    if (value === null) Services.prefs.clearUserPref(name);
    else Services.prefs.setBoolPref(name, value);
  }
`, { prev });

// Raw draft the native compose window saves with text typed at its caret (New: a fresh window).
const nativeDraft = (type, folder, id, text) => tbLib(`
  let win;
  if (args.type === "New") {
    const opened = nextComposeWindow();
    const params = Cc["@mozilla.org/messengercompose/composeparams;1"].createInstance(Ci.nsIMsgComposeParams);
    params.type = Ci.nsIMsgCompType.New;
    params.format = Ci.nsIMsgCompFormat.Default;
    params.identity = MailServices.accounts.defaultAccount.defaultIdentity;
    params.composeFields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
    MailServices.compose.OpenComposeWindowWithParams(null, params);
    win = await opened;
  } else {
    win = await openNativeCompose(Ci.nsIMsgCompType[args.type], hdrById(args.folder, args.id));
  }
  if (args.text) win.GetCurrentEditor().insertText(args.text);
  const draft = await saveNativeDraft(win);
  await closeCompose(win);
  const raw = await rawOf(draft);
  draft.folder.deleteMessages([draft], null, true, false, null, false);
  return raw;
`, { type, folder, id, text });

// Native draft kept in Drafts; returns its Message-ID.
const nativeDraftKept = (type, folder, id, text) => tbLib(`
  const win = await openNativeCompose(Ci.nsIMsgCompType[args.type], hdrById(args.folder, args.id));
  if (args.text) win.GetCurrentEditor().insertText(args.text);
  const draft = await saveNativeDraft(win);
  await closeCompose(win);
  await rawOf(draft);
  return draft.messageId;
`, { type, folder, id, text });

const draftRaw = (id, keep) => tbLib(`
  const h = hdrById(args.drafts, args.id);
  if (!h) return null;
  const raw = await rawOf(h);
  if (!args.keep) h.folder.deleteMessages([h], null, true, false, null, false);
  return raw;
`, { drafts: FOLDER.drafts, id, keep });

const canonicalHtml = html => tbLib(`${CANONICAL} return canonical(args.html);`, { html });

async function ourDraft(type, folder, id, text) {
  let saved;
  if (type === "New") saved = await mcp().call("saveDraft", { to: "z@example.test", subject: "[mcp-test] body", body: text });
  else if (type === "ForwardInline") saved = await mcp().call("forwardMessage", { messageId: id, folderPath: folder, mode: "draft", to: "z@example.test", body: text });
  else saved = await mcp().call("replyToMessage", { messageId: id, folderPath: folder, mode: "draft", body: text, replyAll: type === "ReplyAll" });
  assert.equal(saved.success, true, JSON.stringify(saved));
  return draftRaw(saved.messageId);
}

async function bodyForm(raw) {
  const body = decodeBody(raw);
  return { type: body.type, form: body.type === "text/html" ? await canonicalHtml(body.text) : plainForm(body.text) };
}

async function compare({ type, folder, id, identity = {}, prefs = {}, text = TEXT }) {
  const prev = await applySettings(identity, prefs);
  try {
    const native = await bodyForm(await nativeDraft(type, folder, id, text));
    const ours = await bodyForm(await ourDraft(type, folder, id, text));
    assert.equal(ours.type, native.type);
    assert.equal(ours.form, native.form);
  } finally {
    await restoreSettings(prev);
  }
}

const clearDrafts = () => tbLib("clearFolder(args.drafts);", { drafts: FOLDER.drafts });

const TEXT_SIG = { htmlSigText: "Bench\nUser <b>", htmlSigFormat: false, attachSignature: false, sigOnReply: true, sigOnForward: true };
const HTML_SIG = { htmlSigText: "Bench <b>User</b>", htmlSigFormat: true, attachSignature: false, sigOnReply: true, sigOnForward: true };
const NO_SIG = { htmlSigText: "", attachSignature: false };
const TRICKY = ["  two leading spaces", "trailing spaces   ", "> typed quote mark", "From the start", "long ".repeat(40).trim(), "end"].join("\n");
const major = state ? parseInt(state.version, 10) : 0;
const NATIVE_DROPS_PLAIN_FORWARD_SIG = major >= 150 && major < 158;
const LAYOUTS = [[0, true], [1, true], [1, false], [0, false]];
const ORIGINALS = [["html-alt", FOLDER.inbox, "html-alt@eta.test"], ["plain utf-8", FOLDER.inbox, "charset-utf8@rho.test"]];

describe("compose body", { skip: SKIP }, () => {
  before(async () => {
    await clearDrafts();
  });
  after(async () => {
    await clearDrafts();
    closeAll();
  });

  for (const composeHtml of [true, false]) {
    const mode = composeHtml ? "HTML" : "plain";
    it(`${mode} reply: quote and cite line, without a signature`, async t => {
      for (const [name, folder, id] of ORIGINALS) {
        await t.test(name, () => compare({ type: "Reply", folder, id, identity: { composeHtml, ...NO_SIG, replyOnTop: 0 } }));
      }
    });

    it(`${mode} reply: reply_on_top x sig_bottom with a text and an HTML signature`, async t => {
      for (const [replyOnTop, sigBottom] of LAYOUTS) {
        for (const [sigName, sig] of [["text sig", TEXT_SIG], ["html sig", HTML_SIG]]) {
          await t.test(`top=${replyOnTop} bottom=${sigBottom} ${sigName}`, () =>
            compare({ type: "Reply", folder: ORIGINALS[1][1], id: ORIGINALS[1][2], identity: { composeHtml, ...sig, replyOnTop, sigBottom } }));
        }
      }
    });

    it(`${mode} forward: header table and body, signature position`, async t => {
      for (const [name, folder, id] of ORIGINALS) {
        for (const [replyOnTop, sigBottom] of [[0, true], [1, false]]) {
          const skip = !composeHtml && sigBottom && NATIVE_DROPS_PLAIN_FORWARD_SIG && "Thunderbird 150-157 drop this signature (bug 2063939)";
          await t.test(`${name} top=${replyOnTop} bottom=${sigBottom}`, { skip }, () =>
            compare({ type: "ForwardInline", folder, id, identity: { composeHtml, ...TEXT_SIG, replyOnTop, sigBottom } }));
        }
      }
    });

    it(`${mode} draftId: a new body for a native reply draft replaces only the typed text`, async t => {
      const cases = [[0, true, TEXT_SIG], [1, false, TEXT_SIG], [1, true, HTML_SIG]];
      for (const [replyOnTop, sigBottom, sig] of cases) {
        await t.test(`top=${replyOnTop} bottom=${sigBottom} ${sig === HTML_SIG ? "html" : "text"} sig`, async () => {
          const prev = await applySettings({ composeHtml, ...sig, replyOnTop, sigBottom }, {});
          try {
            const [, folder, id] = ORIGINALS[0];
            const draftId = await nativeDraftKept("Reply", folder, id, "First version");
            const saved = await mcp().call("saveDraft", { draftId, folderPath: FOLDER.drafts, body: TEXT });
            assert.equal(saved.success, true, JSON.stringify(saved));
            assert.equal(await draftRaw(draftId, true), null, "old version removed");
            const ours = await bodyForm(await draftRaw(saved.messageId));
            const native = await bodyForm(await nativeDraft("Reply", folder, id, TEXT));
            assert.equal(ours.type, native.type);
            assert.equal(ours.form, native.form);
          } finally {
            await restoreSettings(prev);
          }
        });
      }
    });

    it(`${mode} new message with a signature`, () => compare({ type: "New", identity: { composeHtml, ...TEXT_SIG, replyOnTop: 0, sigBottom: true } }));

    it(`${mode} typed lines: leading and trailing spaces, ">", "From ", a long line`, async t => {
      await t.test("reply", () => compare({ type: "Reply", folder: ORIGINALS[1][1], id: ORIGINALS[1][2], identity: { composeHtml, ...NO_SIG, replyOnTop: 0 }, text: TRICKY }));
      await t.test("new", () => compare({ type: "New", identity: { composeHtml, ...TEXT_SIG, replyOnTop: 0, sigBottom: true }, text: TRICKY }));
    });
  }

  it("Cyrillic HTML draft: UTF-8, no character references, size close to the text", async () => {
    const prev = await applySettings({ composeHtml: true, ...NO_SIG }, {});
    try {
      const text = "Привет, это проверка кодировки черновика. ".repeat(50).trim();
      for (const [body, isHtml] of [[text, undefined], [`<p>${text}</p><p><b>Жирный</b> текст</p>`, true]]) {
        const saved = await mcp().call("saveDraft", { to: "z@example.test", subject: "[mcp-test] charset", body, isHtml });
        assert.equal(saved.success, true, JSON.stringify(saved));
        const draft = decodeBody(await draftRaw(saved.messageId));
        assert.equal(draft.type, "text/html");
        assert.equal(draft.charset, "utf-8");
        assert.ok(!draft.text.includes("&#"), "no character references");
        assert.ok(draft.text.includes(text));
        const textBytes = Buffer.byteLength(text);
        assert.ok(draft.size < textBytes + 1000, `body ${draft.size} bytes for ${textBytes} bytes of text`);
      }
    } finally {
      await restoreSettings(prev);
    }
  });

  it("HTML without paragraph mode: breaks around the quote, the signature and typed text", async t => {
    const prefs = { "mail.compose.default_to_paragraph": false };
    for (const [replyOnTop, sigBottom] of LAYOUTS) {
      for (const [sigName, sig] of [["text sig", TEXT_SIG], ["no sig", NO_SIG]]) {
        await t.test(`reply top=${replyOnTop} bottom=${sigBottom} ${sigName}`, () => compare({
          type: "Reply", folder: ORIGINALS[0][1], id: ORIGINALS[0][2], identity: { composeHtml: true, ...sig, replyOnTop, sigBottom }, prefs,
        }));
      }
    }
    for (const [replyOnTop, sigBottom] of [[0, true], [1, false]]) {
      await t.test(`forward top=${replyOnTop} bottom=${sigBottom}`, () => compare({
        type: "ForwardInline", folder: ORIGINALS[1][1], id: ORIGINALS[1][2], identity: { composeHtml: true, ...TEXT_SIG, replyOnTop, sigBottom }, prefs,
      }));
    }
    for (const [sigName, sig] of [["text sig", TEXT_SIG], ["no sig", NO_SIG]]) {
      await t.test(`new ${sigName}`, () => compare({ type: "New", identity: { composeHtml: true, ...sig, replyOnTop: 0, sigBottom: true }, prefs }));
    }
  });
});
