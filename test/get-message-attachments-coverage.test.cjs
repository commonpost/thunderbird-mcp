// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// getMessage with attachments and inline images, run whole against a fake Thunderbird: the MIME tree Thunderbird
// parsed, the message stream, the message service and the temporary directory are stubs, the code is the real one.
// Covers saving attachments (and recovering one from the raw MIME when the saved copy is empty or the wrong
// size), the CID image blocks, the raw-stream fallback for the body, the raw source mode and the refusals for an
// encrypted or unreadable message.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
function region(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} missing`);
  return source.slice(start, end);
}
const getMessageStart = source.indexOf("function getMessage(messageId, folderPath, saveAttachments");
const getMessageEnd = source.indexOf("// BEGIN MESSAGE HEADERS", getMessageStart);
assert.ok(getMessageStart > 0 && getMessageEnd > getMessageStart, "getMessage missing");

const NS_BASE_STREAM_CLOSED = 0x80470002;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_INLINE_IMAGE_BASE64_BYTES = 1024 * 1024;
const plain = value => JSON.parse(JSON.stringify(value));
const b64 = text => Buffer.from(text, "latin1").toString("base64");

// What the sandbox reads through during one scenario; replaced before each call
const state = { env: null };

function makeStream(text) {
  let pos = 0;
  const stream = {
    closed: false,
    available() { return text.length - pos; },
    read(count) {
      const part = text.slice(pos, pos + count);
      pos += part.length;
      return part;
    },
    close() { stream.closed = true; },
  };
  return stream;
}

// The temporary directory and the files in it, as nsIFile sees them
function makeFileSystem(options) {
  const dirs = new Set(options.preexistingDirs ? ["/tmp", "/tmp/commonpost-mcp", SAVED_DIR] : ["/tmp"]);
  const files = new Map();
  const removed = [];
  class FakeFile {
    constructor(p) { this.p = p; }
    get path() {
      if (this.pathError) throw this.pathError;
      return this.p;
    }
    append(name) { this.p = `${this.p}/${name}`; }
    clone() { return new FakeFile(this.p); }
    create() {
      if (options.dirCreateError) throw options.dirCreateError;
      if (options.failMessageDirCreate && this.p === SAVED_DIR) throw new Error("EACCES");
      if (dirs.has(this.p)) throw new Error("NS_ERROR_FILE_ALREADY_EXISTS");
      dirs.add(this.p);
    }
    createUnique() {
      if (options.createUniqueError) throw options.createUniqueError;
      // As nsIFile.createUnique: a name taken is made unique with a number
      for (let n = 1; files.has(this.p); n++) this.p = this.p.replace(/(-\d+)?(\.[^./]*)?$/, `-${n}$2`);
      files.set(this.p, { size: 0, bytes: null, recovered: false });
    }
    exists() { return dirs.has(this.p) || files.has(this.p); }
    isDirectory() { return dirs.has(this.p); }
    remove() {
      removed.push(this.p);
      files.delete(this.p);
    }
    get fileSize() {
      const file = files.get(this.p);
      const override = options.fileSize?.(this.p, file);
      if (override !== undefined) return override;
      return file ? file.size : 0;
    }
  }
  return { FakeFile, dirs, files, removed };
}

// One scenario's world. `fetches[url]` is what the channel for a url gives: { data, status, noStream, copiedSize }.
function makeEnv(options) {
  const fsState = makeFileSystem(options);
  const env = {
    options,
    fsState,
    logs: [],
    rawOpens: 0,
    streams: [],
    rawStreams: [],
    mimeCallOptions: null,
  };
  const msgHdr = {
    messageId: options.messageId ?? "<msg-1@example.test>",
    folder: {
      getMsgInputStream() {
        env.rawOpens++;
        if (options.rawOpenError) throw options.rawOpenError;
        const stream = makeStream(options.raw ?? "");
        if (options.rawStreamRead) stream.read = options.rawStreamRead;
        if (options.rawCloseError) {
          stream.close = () => {
            stream.closed = true;
            throw options.rawCloseError;
          };
        }
        env.rawStreams.push(stream);
        return stream;
      },
      getUriForMsg() { return "mailbox-message://nobody@Local%20Folders/Inbox#4"; },
    },
    mime2DecodedSubject: "Subject line",
    mime2DecodedAuthor: "Alice <alice@example.test>",
    mime2DecodedRecipients: "Bob <bob@example.test>",
    ccList: "",
    date: Date.UTC(2026, 0, 2, 3, 4, 5) * 1000,
    ...options.hdr,
  };
  env.msgHdr = msgHdr;
  env.found = options.found || { msgHdr };
  env.fetches = options.fetches || {};
  return env;
}

function installStubs(sandbox) {
  const env = () => state.env;
  Object.assign(sandbox, {
    Uint8Array,
    TextDecoder,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    Cr: { NS_BASE_STREAM_CLOSED },
    Ci: {
      nsIFile: { DIRECTORY_TYPE: 1, NORMAL_FILE_TYPE: 0 },
      nsIFileOutputStream: {},
      nsIBinaryOutputStream: {},
    },
    console: { error: (...args) => env().logs.push(args), warn: () => {} },
    Services: {
      io: {
        extractScheme(url) {
          const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
          if (!m) throw new Error("NS_ERROR_MALFORMED_URI");
          return m[1];
        },
      },
      dirsvc: { get: () => new (env().fsState.FakeFile)("/tmp") },
    },
    Cc: {
      "@mozilla.org/network/file-output-stream;1": {
        createInstance: () => ({
          file: null,
          init(file) {
            if (env().options.ostreamInitError) throw env().options.ostreamInitError;
            this.file = file;
          },
          close() {},
        }),
      },
      "@mozilla.org/binaryoutputstream;1": {
        createInstance: () => ({
          target: null,
          setOutputStream(ostream) { this.target = ostream; },
          writeByteArray(bytes, length) {
            const { options, fsState } = env();
            if (options.writeError) throw options.writeError;
            const file = fsState.files.get(this.target.file.path);
            file.bytes = Uint8Array.from(bytes);
            file.size = length;
            file.recovered = true;
          },
          close() {},
        }),
      },
    },
    NetUtil: {
      newChannel({ uri }) {
        if (env().options.newChannelError) throw env().options.newChannelError;
        return { uri };
      },
      asyncFetch(channel, callback) {
        const entry = env().fetches[channel.uri];
        if (!entry) {
          callback(null, 0x80004005);
          return;
        }
        const stream = entry.noStream ? null : makeStream(entry.data ?? "");
        if (stream) {
          stream.entry = entry;
          env().streams.push(stream);
        }
        callback(stream, entry.status || 0);
      },
      asyncCopy(inputStream, ostream, callback) {
        let text = "";
        while (inputStream.available() > 0) text += inputStream.read(inputStream.available());
        const file = env().fsState.files.get(ostream.file.path);
        file.bytes = Uint8Array.from(Buffer.from(text, "latin1"));
        file.size = inputStream.entry.copiedSize ?? text.length;
        if (env().options.pathErrorAfterCopy) ostream.file.pathError = env().options.pathErrorAfterCopy;
        callback(inputStream.entry.copyStatus || 0);
      },
      readInputStreamToString(stream, count) { return stream.read(count); },
    },
    MailServices: {
      messageServiceFromURI() {
        if (env().options.noMessageService) throw new Error("no service");
        return { getUrlForUri: () => ({ spec: env().options.specNoQuery ? "mailbox:///Inbox" : "mailbox:///Inbox?number=4" }) };
      },
    },
    ChromeUtils: {
      importESModule(url) {
        if (env().options.importError) throw env().options.importError;
        if (url.includes("MimeMessage")) {
          return {
            MsgHdrToMimeMessage(msgHdr, verbosity, callback, allowDownload, callOptions) {
              env().mimeCallOptions = callOptions;
              callback(msgHdr, env().options.mime === undefined ? null : env().options.mime);
            },
          };
        }
        return { MailStringUtils: { detectCharset: bytes => env().options.detectCharset?.(bytes) } };
      },
    },
    findMessage: () => env().found,
    isEncryptedContentAllowed: () => env().options.encryptedAllowed !== false,
    extractFormattedBody: (mimeMsg, format, counter) => {
      const body = env().options.body === undefined ? "Body text" : env().options.body;
      if (env().options.hidden) counter.n += env().options.hidden;
      return { body, bodyIsHtml: !!env().options.bodyIsHtml };
    },
    htmlToMarkdown: html => `MD(${html})`,
    stripHtml: html => `TEXT(${html})`,
    getUserTags: () => ["$label1"],
    displaySubject: hdr => hdr.mime2DecodedSubject,
    decodeHeaderValue: value => String(value || ""),
    escapeHiddenCharacters: text => text,
  });
}

const sandbox = {};
installStubs(sandbox);
vm.createContext(sandbox);
vm.runInContext(`"use strict";
${["STRIP HELPERS", "INLINE IMAGE CONTENT HELPERS", "ENCRYPTED MESSAGE HELPERS", "RAW MIME PARSING HELPERS",
  "RAW MIME ATTACHMENT HELPERS", "OUTBOUND ATTACHMENT LIMITS", "OUTBOUND ATTACHMENT CONVERSION",
  "AUTHENTICATION RESULTS"].map(region).join("\n")}
${source.slice(getMessageStart, getMessageEnd)}
Object.assign(this, { getMessage, buildToolResultContent });`, sandbox);

// Calls getMessage in a fresh world. Returns { result, env }.
async function run(options = {}) {
  const env = makeEnv(options);
  state.env = env;
  const result = await sandbox.getMessage(
    options.messageId ?? "<msg-1@example.test>",
    options.folderPath || "mailbox://nobody@Local%20Folders/Inbox",
    options.saveAttachments === true,
    options.bodyFormat,
    options.rawSource === true,
    options.includeInlineImages === true,
    options.rawEncoding
  );
  return { result, env };
}

// ---- builders ----------------------------------------------------------------------------------------------

const SAVED_DIR = "/tmp/commonpost-mcp/_msg_1_example_test_";
const part = (headers, body) => `${headers}\r\n\r\n${body}`;
function rawMessage(parts, { top = "multipart/mixed", boundary = "b", extra = "" } = {}) {
  return `Subject: s\r\nContent-Type: ${top}; boundary="${boundary}"${extra}\r\n\r\n` +
    `${parts.map(p => `--${boundary}\r\n${p}\r\n`).join("")}--${boundary}--\r\n`;
}
const textPart = part("Content-Type: text/plain; charset=utf-8", "Body text");
function filePart(name, content, { type = "application/pdf", disposition = "attachment", extra = "" } = {}) {
  return part(
    `Content-Type: ${type}; name="${name}"\r\nContent-Disposition: ${disposition}; filename="${name}"\r\n` +
      `Content-Transfer-Encoding: base64${extra ? `\r\n${extra}` : ""}`,
    b64(content)
  );
}
function attachmentEntry(name, size, extra = {}) {
  return {
    name,
    contentType: "application/pdf",
    size,
    url: `mailbox:///Inbox?number=4&part=1.${encodeURIComponent(name)}`,
    partName: "1.2",
    ...extra,
  };
}
const urlOf = entry => entry.url;
// Arrays made in the sandbox do not compare equal to the test's own, so these copy them
const errorsOf = result => Array.from(result.attachments, a => a.error);
const pathsOf = result => Array.from(result.attachments, a => a.filePath);
function mimeTree(allUserAttachments, parts = []) {
  return { contentType: "message/rfc822", partName: "", parts, allUserAttachments };
}
// Fetch results of attachments whose saved copy is empty (what an mbox with underreported sizes gives)
function emptyCopies(...entries) {
  return Object.fromEntries(entries.map(entry => [urlOf(entry), { data: "" }]));
}
function savedBytes(env, name) {
  const file = env.fsState.files.get(`${SAVED_DIR}/${name}`);
  return file && file.bytes ? Buffer.from(file.bytes).toString("latin1") : null;
}

// ---- saving and recovering attachments ------------------------------------------------------------------------

describe("getMessage saving attachments from the stored message", () => {
  it("saves an attachment whose copied size is right and lists its path", async () => {
    const entry = attachmentEntry("report.pdf", 11);
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      fetches: { [urlOf(entry)]: { data: "hello world" } },
    });
    assert.equal(result.attachments[0].filePath, `${SAVED_DIR}/report.pdf`);
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(savedBytes(env, "report.pdf"), "hello world");
    assert.equal(env.rawOpens, 0, "the raw message is not read when the copy is right");
    assert.equal(env.mimeCallOptions.examineEncryptedParts, true);
  });

  it("reports the attachment without saving when saving was not asked for", async () => {
    const entry = attachmentEntry("report.pdf", 11);
    const { result, env } = await run({ mime: mimeTree([entry]) });
    assert.deepEqual(plain(result.attachments), [{ name: "report.pdf", contentType: "application/pdf", size: 11, isInline: false }]);
    assert.equal(env.fsState.files.size, 0);
  });

  it("refuses an attachment that is only a link, without opening it", async () => {
    const entry = attachmentEntry("linked.pdf", 5, { isExternal: true, url: "file:///etc/passwd" });
    const { result, env } = await run({ saveAttachments: true, mime: mimeTree([entry]) });
    assert.equal(result.attachments[0].external, true);
    assert.match(result.attachments[0].error, /^Not saved: the attachment is only a link/);
    assert.equal(env.fsState.files.size, 0);
  });

  it("names an attachment without a url", async () => {
    const { result } = await run({ saveAttachments: true, mime: mimeTree([attachmentEntry("none.pdf", 5, { url: "" })]) });
    assert.equal(result.attachments[0].error, "Missing attachment URL");
  });

  it("refuses an attachment declared larger than the limit before fetching it", async () => {
    const entry = attachmentEntry("huge.bin", MAX_ATTACHMENT_BYTES + 1);
    const { result, env } = await run({ saveAttachments: true, mime: mimeTree([entry]) });
    assert.equal(result.attachments[0].error, `Attachment too large (${MAX_ATTACHMENT_BYTES + 1} bytes, limit ${MAX_ATTACHMENT_BYTES})`);
    assert.equal(env.fsState.files.size, 0);
  });

  it("keeps a hostile file name inside the message's directory", async () => {
    const dotdot = attachmentEntry("..", 3, { url: "mailbox:///Inbox?number=4&part=1.2" });
    const slashes = attachmentEntry("../../etc/passwd", 3, { url: "mailbox:///Inbox?number=4&part=1.3" });
    const blank = attachmentEntry("  ", 3, { url: "mailbox:///Inbox?number=4&part=1.4" });
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([dotdot, slashes, blank]),
      fetches: {
        [dotdot.url]: { data: "abc" },
        [slashes.url]: { data: "abc" },
        [blank.url]: { data: "abc" },
      },
    });
    assert.deepEqual(pathsOf(result), [
      `${SAVED_DIR}/attachment_0`,
      `${SAVED_DIR}/.._.._etc_passwd`,
      `${SAVED_DIR}/attachment`,
    ]);
    for (const file of env.fsState.files.keys()) assert.ok(file.startsWith(`${SAVED_DIR}/`), file);
  });

  it("names a file that cannot be created", async () => {
    const entry = attachmentEntry("a.pdf", 3);
    const { result } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      createUniqueError: new Error("disk full"),
      fetches: { [entry.url]: { data: "abc" } },
    });
    assert.equal(result.attachments[0].error, "Failed to create file: Error: disk full");
  });

  it("names the failure of a fetch, an empty fetch, a copy and an oversize copy, and removes the file", async () => {
    const failed = attachmentEntry("failed.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.1" });
    const missing = attachmentEntry("missing.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.2" });
    const unwritable = attachmentEntry("unwritable.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.3" });
    const oversize = attachmentEntry("oversize.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.4" });
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([failed, missing, unwritable, oversize]),
      fetches: {
        [failed.url]: { status: 2147500037, data: "abc" },
        [missing.url]: { noStream: true },
        [unwritable.url]: { data: "unwritable", copyStatus: 2152857618 },
        [oversize.url]: { data: "oversize", copiedSize: MAX_ATTACHMENT_BYTES + 1 },
      },
    });
    assert.deepEqual(errorsOf(result), [
      "Fetch failed: 2147500037",
      "Fetch returned no data",
      "Write failed: 2152857618",
      `Attachment too large (${MAX_ATTACHMENT_BYTES + 1} bytes, limit ${MAX_ATTACHMENT_BYTES})`,
    ]);
    assert.deepEqual(pathsOf(result), [undefined, undefined, undefined, undefined]);
    assert.equal(env.fsState.removed.length, 4);
  });

  it("refuses to save anything when the temporary directory cannot be created", async () => {
    const entry = attachmentEntry("a.pdf", 3);
    const { result } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      dirCreateError: new Error("read-only"),
      fetches: { [entry.url]: { data: "abc" } },
    });
    assert.equal(result.attachments[0].error, "Failed to create attachment directory: Error: read-only");
    assert.equal(result.attachments[0].filePath, undefined);
  });

  it("reuses the temporary directory when it already exists", async () => {
    const first = attachmentEntry("one.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.1" });
    const second = attachmentEntry("two.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.2" });
    const { result } = await run({
      saveAttachments: true,
      preexistingDirs: true,
      mime: mimeTree([first, second]),
      fetches: { [first.url]: { data: "abc" }, [second.url]: { data: "xyz" } },
    });
    assert.deepEqual(errorsOf(result), [undefined, undefined]);
    assert.deepEqual(pathsOf(result), [`${SAVED_DIR}/one.pdf`, `${SAVED_DIR}/two.pdf`]);
  });

  it("gives two attachments of the same name two files", async () => {
    const first = attachmentEntry("same.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.1" });
    const second = attachmentEntry("same.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.2" });
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([first, second]),
      fetches: { [first.url]: { data: "abc" }, [second.url]: { data: "xyz" } },
    });
    assert.deepEqual(pathsOf(result), [`${SAVED_DIR}/same.pdf`, `${SAVED_DIR}/same-1.pdf`]);
    assert.equal(savedBytes(env, "same.pdf"), "abc");
    assert.equal(savedBytes(env, "same-1.pdf"), "xyz");
  });
});

describe("getMessage reporting the receiving server's authentication results", () => {
  it("reads the topmost Authentication-Results header only", async () => {
    const mime = mimeTree([]);
    mime.headers = {
      "authentication-results": [
        "mx.provider.example; spf=pass smtp.mailfrom=news@shop.example; dkim=pass header.d=shop.example header.s=k1; dmarc=pass header.from=shop.example",
        "mx.forged.example; dkim=pass header.d=bank.example",
      ],
    };
    const { result } = await run({ mime });
    assert.deepEqual(plain(result.authentication), {
      authservId: "mx.provider.example",
      spf: { result: "pass", domain: "shop.example" },
      dkim: [{ result: "pass", domain: "shop.example", selector: "k1" }],
      dmarc: { result: "pass", domain: "shop.example" },
    });
  });

  it("leaves the field out without the header", async () => {
    const { result } = await run({ mime: mimeTree([]) });
    assert.equal("authentication" in result, false);
  });
});

describe("getMessage recovering an attachment from the raw MIME", () => {
  const content = "PDFDATA-1234";

  it("recovers the attachment by file name when the saved copy is empty", async () => {
    const entry = attachmentEntry("Report.PDF", content.length);
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([textPart, filePart("report.pdf", content)]),
      fetches: emptyCopies(entry),
    });
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(result.attachments[0].filePath, `${SAVED_DIR}/Report.PDF`);
    assert.equal(savedBytes(env, "Report.PDF"), content);
    assert.equal(env.rawOpens, 1);
    assert.equal(env.rawStreams[0].closed, true);
  });

  it("recovers an attachment whose saved copy has the wrong size", async () => {
    const entry = attachmentEntry("report.pdf", content.length);
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([textPart, filePart("report.pdf", content)]),
      fetches: { [entry.url]: { data: "x".repeat(40) } },
    });
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(savedBytes(env, "report.pdf"), content);
  });

  it("saves an attached message as fetched: Thunderbird gives it the size of its body only", async () => {
    const inner = "From: Inner <inner@example.com>\r\nSubject: Inner message\r\n\r\nInner body text.\n";
    const entry = attachmentEntry("inner.eml", "Inner body text.\n".length, { contentType: "message/rfc822" });
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      fetches: { [entry.url]: { data: inner } },
    });
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(result.attachments[0].filePath, `${SAVED_DIR}/inner.eml`);
    assert.equal(savedBytes(env, "inner.eml"), inner);
    assert.equal(env.rawOpens, 0, "the size of an attached message is not compared, so nothing is recovered");
  });

  it("still names an attached message whose saved copy is empty", async () => {
    const entry = attachmentEntry("inner.eml", 17, { contentType: "message/rfc822" });
    const { result } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([textPart]),
      fetches: { [entry.url]: { data: "" } },
    });
    assert.equal(result.attachments[0].filePath, undefined);
    assert.match(result.attachments[0].error, /^attachment body not recoverable from raw MIME/);
  });

  it("reads the raw message once for several attachments", async () => {
    const one = attachmentEntry("one.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.2" });
    const two = attachmentEntry("two.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.3" });
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([one, two]),
      raw: rawMessage([textPart, filePart("one.pdf", "111"), filePart("two.pdf", "222")]),
      fetches: emptyCopies(one, two),
    });
    assert.deepEqual(errorsOf(result), [undefined, undefined]);
    assert.equal(savedBytes(env, "one.pdf"), "111");
    assert.equal(savedBytes(env, "two.pdf"), "222");
    assert.equal(env.rawOpens, 1);
  });

  it("reuses the raw message the body fallback already read", async () => {
    const entry = attachmentEntry("report.pdf", content.length);
    const { result, env } = await run({
      saveAttachments: true,
      body: "",
      mime: mimeTree([entry]),
      raw: rawMessage([textPart, filePart("report.pdf", content)]),
      fetches: emptyCopies(entry),
    });
    assert.equal(result.body, "Body text");
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(savedBytes(env, "report.pdf"), content);
    assert.equal(env.rawOpens, 1);
  });

  it("falls back to the content id when no file name matches", async () => {
    const { result, env } = await run({
      saveAttachments: true,
      includeInlineImages: true,
      mime: mimeTree([], [{
        contentType: "multipart/related",
        partName: "1",
        parts: [{
          contentType: "image/png",
          partName: "1.2",
          size: 4,
          headers: {
            "content-type": ['image/png; name="seen-by-thunderbird.png"'],
            "content-id": ["<want@example.test>"],
          },
        }],
      }]),
      raw: rawMessage([
        part("Content-Type: text/html", "<img src=cid:want@example.test>"),
        part('Content-Type: image/png; name="stored.png"\r\nContent-ID: <want@example.test>\r\nContent-Disposition: inline; filename="stored.png"\r\nContent-Transfer-Encoding: base64', b64("PNG!")),
      ], { top: "multipart/related" }),
      fetches: { "mailbox:///Inbox?number=4&part=1.2": { data: "" } },
    });
    const image = result.attachments.find(a => a.isInline);
    assert.equal(image.error, undefined);
    assert.equal(image.contentId, "want@example.test");
    assert.equal(savedBytes(env, "seen-by-thunderbird.png"), "PNG!");
  });

  it("falls back to the content type when neither the name nor the content id match", async () => {
    const entry = attachmentEntry("renamed by the mail client.pdf", content.length);
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([textPart, filePart("original.pdf", content)]),
      fetches: emptyCopies(entry),
    });
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(savedBytes(env, "renamed_by_the_mail_client.pdf"), content);
  });

  it("says so when no part of the raw message matches", async () => {
    const entry = attachmentEntry("report.pdf", content.length, { contentType: "image/gif" });
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([textPart, filePart("other.pdf", content)]),
      fetches: emptyCopies(entry),
    });
    assert.equal(result.attachments[0].error, "attachment body not recoverable from raw MIME");
    assert.equal(result.attachments[0].filePath, undefined);
    assert.deepEqual(env.fsState.removed, [`${SAVED_DIR}/report.pdf`]);
  });

  it("says so when the matching part has no content", async () => {
    const entry = attachmentEntry("empty.pdf", 5);
    const { result } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([textPart, part('Content-Type: application/pdf; name="empty.pdf"\r\nContent-Disposition: attachment; filename="empty.pdf"\r\nContent-Transfer-Encoding: base64', "")]),
      fetches: emptyCopies(entry),
    });
    assert.equal(result.attachments[0].error, "attachment body not recoverable from raw MIME");
  });

  it("names the failure to read the raw message once, for every attachment that needs it", async () => {
    const one = attachmentEntry("one.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.2" });
    const two = attachmentEntry("two.pdf", 3, { url: "mailbox:///Inbox?number=4&part=1.3" });
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([one, two]),
      rawOpenError: new Error("stream gone"),
      fetches: emptyCopies(one, two),
    });
    assert.deepEqual(errorsOf(result), [
      "attachment body not recoverable from raw MIME: Error: stream gone",
      "attachment body not recoverable from raw MIME: Error: stream gone",
    ]);
    assert.equal(env.rawOpens, 1);
  });

  it("names an empty raw message", async () => {
    const entry = attachmentEntry("one.pdf", 3);
    const { result } = await run({ saveAttachments: true, mime: mimeTree([entry]), raw: "", fetches: emptyCopies(entry) });
    assert.equal(result.attachments[0].error, "attachment body not recoverable from raw MIME: Error: message stream has zero size");
  });

  it("names a raw message with nothing to recover from", async () => {
    const entry = attachmentEntry("one.pdf", 3);
    const { result } = await run({ saveAttachments: true, mime: mimeTree([entry]), raw: "Subject: single part\r\n\r\ntext", fetches: emptyCopies(entry) });
    assert.equal(result.attachments[0].error, "attachment body not recoverable from raw MIME");
  });

  it("closes the raw stream, and a stream that fails to close changes nothing", async () => {
    const entry = attachmentEntry("report.pdf", content.length);
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([textPart, filePart("report.pdf", content)]),
      rawCloseError: new Error("close failed"),
      fetches: emptyCopies(entry),
    });
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(savedBytes(env, "report.pdf"), content);
    assert.equal(env.rawStreams[0].closed, true);
  });

  it("names a write that fails", async () => {
    const entry = attachmentEntry("report.pdf", content.length);
    const { result } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([textPart, filePart("report.pdf", content)]),
      fetches: emptyCopies(entry),
      writeError: new Error("no space"),
    });
    assert.equal(result.attachments[0].error, "attachment raw MIME recovery write failed: Error: no space");
  });

  it("names a recovered file whose size cannot be read, is too large, or is not a size", async () => {
    const entry = attachmentEntry("report.pdf", content.length);
    const raw = rawMessage([textPart, filePart("report.pdf", content)]);
    // Only the file written by the recovery reports this size, not the empty copy
    const recovered = sizeOf => run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw,
      fetches: emptyCopies(entry),
      fileSize: (_, file) => (file && file.recovered ? sizeOf() : undefined),
    });
    const unreadable = await recovered(() => { throw new Error("stat failed"); });
    assert.equal(unreadable.result.attachments[0].error, "attachment raw MIME recovery size check failed");
    const large = await recovered(() => MAX_ATTACHMENT_BYTES + 1);
    assert.equal(large.result.attachments[0].error, `Attachment too large (${MAX_ATTACHMENT_BYTES + 1} bytes, limit ${MAX_ATTACHMENT_BYTES})`);
    const negative = await recovered(() => -1);
    assert.equal(negative.result.attachments[0].error, `attachment body recovered from raw MIME but size mismatch (-1 bytes, expected ${content.length})`);
  });

  it("refuses a recovered part whose size is far from the declared one", async () => {
    const entry = attachmentEntry("report.pdf", 1000);
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([textPart, filePart("report.pdf", content)]),
      fetches: emptyCopies(entry),
    });
    assert.equal(result.attachments[0].error, `attachment body recovered from raw MIME but size mismatch (${content.length} bytes, expected 1000)`);
    assert.equal(result.attachments[0].filePath, undefined);
    assert.deepEqual(env.fsState.removed, [`${SAVED_DIR}/report.pdf`]);
  });

  it("recovers an attachment of unknown size, and names a size that is not one without a declared size", async () => {
    const entry = attachmentEntry("report.pdf", undefined);
    const raw = rawMessage([textPart, filePart("report.pdf", content)]);
    const ok = await run({ saveAttachments: true, mime: mimeTree([entry]), raw, fetches: emptyCopies(entry) });
    assert.equal(ok.result.attachments[0].error, undefined);
    assert.equal(ok.result.attachments[0].size, null);
    const bad = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw,
      fetches: emptyCopies(entry),
      fileSize: (_, file) => (file && file.recovered ? -1 : undefined),
    });
    assert.equal(bad.result.attachments[0].error, "attachment body recovered from raw MIME but size mismatch (-1 bytes)");
  });
});

describe("getMessage choosing between several raw parts for one attachment", () => {
  const recoverWith = async (entries, parts, extra = {}) => {
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree(entries),
      raw: rawMessage([textPart, ...parts]),
      fetches: emptyCopies(...entries),
      ...extra,
    });
    return { result, env, bytes: name => savedBytes(env, name) };
  };

  // The same candidates in either order of the message: the choice must not depend on it
  const inBothOrders = async (parts, check) => {
    for (const ordered of [parts, [...parts].reverse()]) await check(ordered);
  };

  it("prefers the part of the same type among parts of the same name", async () => {
    const entry = attachmentEntry("dup.bin", 3, { contentType: "application/pdf" });
    await inBothOrders([
      filePart("dup.bin", "PNG", { type: "image/png" }),
      filePart("dup.bin", "PDF", { type: "application/pdf" }),
    ], async parts => {
      const { result, bytes } = await recoverWith([entry], parts);
      assert.equal(result.attachments[0].error, undefined);
      assert.equal(bytes("dup.bin"), "PDF");
    });
  });

  it("prefers the part with the same content id among parts of the same name and type", async () => {
    const entry = attachmentEntry("dup.png", 3, { contentType: "image/png", url: "mailbox:///Inbox?number=4&part=1.2" });
    const image = (cid, content) => part(`Content-Type: image/png; name="dup.png"\r\nContent-ID: <${cid}>\r\nContent-Disposition: attachment; filename="dup.png"\r\nContent-Transfer-Encoding: base64`, b64(content));
    await inBothOrders([image("other@example.test", "OTH"), image("want@example.test", "WNT")], async images => {
      const { result, env } = await run({
        saveAttachments: true,
        includeInlineImages: true,
        mime: mimeTree([entry], [{
          contentType: "multipart/related",
          partName: "1",
          parts: [{
            contentType: "image/png",
            partName: "1.2",
            size: 3,
            headers: { "content-type": ['image/png; name="dup.png"'], "content-id": ["<want@example.test>"] },
          }],
        }]),
        raw: rawMessage([part("Content-Type: text/html", "<img src=cid:want@example.test>"), ...images], { top: "multipart/related" }),
        fetches: { [entry.url]: { data: "" } },
      });
      assert.equal(result.attachments[0].error, undefined);
      assert.equal(result.attachments[0].contentId, "want@example.test");
      assert.equal(savedBytes(env, "dup.png"), "WNT");
    });
  });

  it("prefers the part whose size is closest to the declared size", async () => {
    const entry = attachmentEntry("dup.txt", 10, { contentType: "text/plain" });
    await inBothOrders([
      filePart("dup.txt", "AAA", { type: "text/plain" }),
      filePart("dup.txt", "BBBBBBBBBB", { type: "text/plain" }),
      filePart("dup.txt", "CCCCCCCCCCCCCCCC", { type: "text/plain" }),
    ], async parts => {
      const { result, bytes } = await recoverWith([entry], parts);
      assert.equal(result.attachments[0].error, undefined);
      assert.equal(bytes("dup.txt"), "BBBBBBBBBB");
    });
  });

  it("counts a part without content as empty when comparing sizes", async () => {
    const entry = attachmentEntry("dup.txt", 6, { contentType: "text/plain" });
    await inBothOrders([
      part('Content-Type: text/plain; name="dup.txt"\r\nContent-Disposition: attachment; filename="dup.txt"\r\nContent-Transfer-Encoding: base64', ""),
      filePart("dup.txt", "SIXSIX", { type: "text/plain" }),
    ], async parts => {
      const { result, bytes } = await recoverWith([entry], parts);
      assert.equal(result.attachments[0].error, undefined);
      assert.equal(bytes("dup.txt"), "SIXSIX");
    });
  });

  it("falls through to the disposition when two parts are equally close in size", async () => {
    const entry = attachmentEntry("dup.txt", 3, { contentType: "text/plain" });
    await inBothOrders([
      filePart("dup.txt", "INL", { type: "text/plain", disposition: "inline" }),
      filePart("dup.txt", "ATT", { type: "text/plain", disposition: "attachment" }),
    ], async parts => {
      const { result, bytes } = await recoverWith([entry], parts);
      assert.equal(bytes("dup.txt"), "ATT");
      assert.equal(result.attachments[0].error, undefined);
    });
  });

  it("prefers a part disposed as attachment to an inline one when nothing else tells them apart", async () => {
    const entry = attachmentEntry("dup.txt", undefined, { contentType: "text/plain" });
    await inBothOrders([
      filePart("dup.txt", "INL", { type: "text/plain", disposition: "inline" }),
      filePart("dup.txt", "ATT", { type: "text/plain", disposition: "attachment" }),
    ], async parts => {
      const { result, bytes } = await recoverWith([entry], parts);
      assert.equal(result.attachments[0].error, undefined);
      assert.equal(bytes("dup.txt"), "ATT");
    });
  });

  it("chooses by size among parts of the right type when none has the name", async () => {
    const entry = attachmentEntry("renamed.pdf", 10);
    await inBothOrders([
      filePart("x.pdf", "XXX"),
      filePart("y.pdf", "YYYYYYYYYY"),
      filePart("z.png", "ZZZZZZZZZZ", { type: "image/png" }),
    ], async parts => {
      const { result, bytes } = await recoverWith([entry], parts);
      assert.equal(result.attachments[0].error, undefined);
      assert.equal(bytes("renamed.pdf"), "YYYYYYYYYY");
    });
  });

  it("gives two attachments of the same name two different parts", async () => {
    const big = attachmentEntry("dup.txt", 10, { contentType: "text/plain", url: "mailbox:///Inbox?number=4&part=1.2" });
    const small = attachmentEntry("dup.txt", 3, { contentType: "text/plain", url: "mailbox:///Inbox?number=4&part=1.3" });
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([big, small]),
      raw: rawMessage([
        textPart,
        filePart("dup.txt", "AAA", { type: "text/plain" }),
        filePart("dup.txt", "BBBBBBBBBB", { type: "text/plain" }),
      ]),
      fetches: emptyCopies(big, small),
    });
    assert.deepEqual(errorsOf(result), [undefined, undefined]);
    const written = [...env.fsState.files.values()].map(f => Buffer.from(f.bytes).toString("latin1")).sort();
    assert.deepEqual(written, ["AAA", "BBBBBBBBBB"]);
    assert.notEqual(result.attachments[0].filePath, result.attachments[1].filePath);
  });

  it("gives a second attachment no part once the only one was taken", async () => {
    const one = attachmentEntry("dup.txt", 3, { contentType: "text/plain", url: "mailbox:///Inbox?number=4&part=1.2" });
    const two = attachmentEntry("dup.txt", 3, { contentType: "text/plain", url: "mailbox:///Inbox?number=4&part=1.3" });
    const { result } = await run({
      saveAttachments: true,
      mime: mimeTree([one, two]),
      raw: rawMessage([textPart, filePart("dup.txt", "AAA", { type: "text/plain" })]),
      fetches: emptyCopies(one, two),
    });
    assert.deepEqual(errorsOf(result), [undefined, "attachment body not recoverable from raw MIME"]);
  });

  it("matches a nameless attachment to a nameless part rather than to a named one of the same type", async () => {
    const entry = attachmentEntry("", 3, { contentType: "application/pdf" });
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([
        textPart,
        filePart("named.pdf", "NAM"),
        part("Content-Type: application/pdf\r\nContent-Disposition: attachment\r\nContent-Transfer-Encoding: base64", b64("ANO")),
      ]),
      fetches: emptyCopies(entry),
    });
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(savedBytes(env, "attachment"), "ANO");
  });
});

describe("getMessage reading the raw message for the body when Thunderbird gave none", () => {
  const withBody = async (options) => run({ body: "", mime: mimeTree([]), ...options });

  it("takes the plain text part and says nothing", async () => {
    const { result } = await withBody({ raw: rawMessage([textPart, filePart("a.pdf", "x")]) });
    assert.equal(result.body, "Body text");
    assert.equal(result.bodyIsHtml, false);
    assert.equal(result.bodyNote, undefined);
  });

  it("converts an HTML part to the format asked for", async () => {
    const html = rawMessage([part("Content-Type: text/html; charset=utf-8", "<p>Hi</p>")]);
    assert.equal((await withBody({ raw: html, bodyFormat: "html" })).result.body, "<p>Hi</p>");
    assert.equal((await withBody({ raw: html, bodyFormat: "html" })).result.bodyIsHtml, true);
    assert.equal((await withBody({ raw: html })).result.body, "MD(<p>Hi</p>)");
    assert.equal((await withBody({ raw: html, bodyFormat: "text" })).result.body, "TEXT(<p>Hi</p>)");
    assert.equal((await withBody({ raw: html, bodyFormat: "text" })).result.bodyIsHtml, false);
  });

  it("logs a charset it did not know and decodes as UTF-8", async () => {
    const raw = rawMessage([part("Content-Type: text/plain; charset=x-no-such-charset", "plain")]);
    const { result, env } = await withBody({ raw });
    assert.equal(result.body, "plain");
    assert.ok(env.logs.some(args => /unknown charset "x-no-such-charset"/.test(args[0])));
  });

  it("explains an empty stream, a message without text and a read that fails", async () => {
    const empty = await withBody({ raw: "" });
    assert.equal(empty.result.bodyNote, "raw MIME body extraction could not read message stream");
    const noText = await withBody({ raw: rawMessage([filePart("a.pdf", "x")]) });
    assert.equal(noText.result.bodyNote, "multipart body extraction found no suitable text part");
    const unreadable = await withBody({ rawOpenError: new Error("gone") });
    assert.equal(unreadable.result.bodyNote, "raw MIME body extraction failed");
    const tooBig = new Error("message too large");
    tooBig.isStreamSizeLimit = true;
    const capped = await withBody({ raw: "x", rawStreamRead() { throw tooBig; } });
    assert.equal(capped.result.bodyNote, "raw MIME body extraction hit 50 MiB size cap");
  });

  it("logs a stream that fails to close without changing the result", async () => {
    const { result, env } = await run({
      body: "",
      mime: mimeTree([]),
      raw: rawMessage([textPart]),
      rawCloseError: new Error("close failed"),
    });
    assert.equal(result.body, "Body text");
    assert.equal(env.rawStreams[0].closed, true);
    assert.ok(env.logs.some(args => /failed to close stream/.test(args[0])));
  });

  it("notes the elements hidden from an HTML body, after any other note", async () => {
    const { result } = await run({ mime: mimeTree([]), hidden: 3 });
    assert.equal(result.bodyNote, "3 element(s) hidden by CSS, the hidden attribute, or <template> were removed from the HTML body");
    const both = await run({ body: "", mime: mimeTree([]), raw: "", hidden: 1 });
    assert.match(both.result.bodyNote, /^raw MIME body extraction could not read message stream; 1 element\(s\) hidden/);
  });
});

// ---- inline images ------------------------------------------------------------------------------------------------

const partUrl = partName => `mailbox:///Inbox?number=4&part=${partName}`;
function glodaImage(partName, { type = "image/png", size, contentId, name, disposition } = {}) {
  return {
    contentType: type,
    partName,
    size,
    headers: {
      "content-type": [name ? `${type}; name="${name}"` : type],
      ...(contentId ? { "content-id": [`<${contentId}>`] } : {}),
      ...(disposition ? { "content-disposition": [disposition] } : {}),
    },
  };
}
const related = (partName, ...children) => ({
  contentType: "multipart/related",
  partName,
  parts: [{ contentType: "text/html", partName: `${partName}.1` }, ...children],
});
const PNG = "\x89PNG\r\n\x1a\n-pixels";
// The attachment entries without the image block status, which depends on a fetch these tests do not set up
const listedOf = result => plain(Array.from(result.attachments, info => {
  const rest = { ...info };
  delete rest.mcpImage;
  return rest;
}));

describe("getMessage listing inline images without the opt-in", () => {
  it("lists the images of a multipart/related root, named from the Content-Type or by part", async () => {
    const mime = {
      contentType: "multipart/related",
      partName: "",
      parts: [
        { contentType: "text/html", partName: "1" },
        glodaImage("2", { name: "logo.png", size: 4096 }),
        glodaImage("3"),
        { contentType: "image/png", partName: "" },
        { contentType: "text/plain", partName: "4" },
        { contentType: "image/png", partName: "5" },
        { partName: "6" },
        { contentType: ";charset=x", partName: "7" },
      ],
      allUserAttachments: [],
    };
    const { result } = await run({ mime });
    assert.deepEqual(plain(result.attachments), [
      { name: "logo.png", contentType: "image/png", size: 4096, partName: "2", isInline: true },
      { name: "inline_3", contentType: "image/png", size: null, partName: "3", isInline: true },
      { name: "inline_5", contentType: "image/png", size: null, partName: "5", isInline: true },
    ]);
  });

  it("does not list an image outside multipart/related, and lists a part found twice once", async () => {
    const mime = {
      contentType: "multipart/mixed",
      partName: "",
      parts: [
        related("1", glodaImage("1.2", { name: "dup.png" }), glodaImage("1.2", { name: "dup.png" }), glodaImage("1.3", { name: "new.png" })),
        glodaImage("2", { name: "loose.png" }),
      ],
      allUserAttachments: [],
    };
    const { result } = await run({ mime });
    assert.deepEqual(Array.from(result.attachments, a => a.name), ["dup.png", "new.png"]);
    assert.equal(result.attachments[1].isInline, true);
  });

  it("leaves the images of a message/rfc822 root alone, and those of an attached message", async () => {
    const wrapped = { contentType: "message/rfc822", partName: "", parts: [related("1", glodaImage("1.2"))], allUserAttachments: [] };
    assert.deepEqual(plain((await run({ mime: wrapped })).result.attachments), []);
    const attachedMessage = {
      contentType: "multipart/related",
      partName: "",
      parts: [{ contentType: "message/rfc822", partName: "1", parts: [glodaImage("1.1")] }, glodaImage("2", { name: "own.png" })],
      allUserAttachments: [],
    };
    assert.deepEqual(Array.from((await run({ mime: attachedMessage })).result.attachments, a => a.name), ["own.png"]);
  });

  it("lists an image with no way to fetch it, without a url to save it from", async () => {
    const mime = { contentType: "multipart/related", partName: "", parts: [glodaImage("2", { name: "logo.png" })], allUserAttachments: [] };
    const { result, env } = await run({ mime, noMessageService: true, saveAttachments: true });
    assert.equal(result.attachments[0].name, "logo.png");
    assert.equal(result.attachments[0].filePath, undefined);
    assert.equal(env.fsState.files.size, 0);
  });

  it("saves an inline image from the url the message service gave", async () => {
    const mime = { contentType: "multipart/related", partName: "", parts: [glodaImage("2", { name: "logo.png", size: PNG.length })], allUserAttachments: [] };
    const { result, env } = await run({ mime, saveAttachments: true, fetches: { [partUrl("2")]: { data: PNG } } });
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(savedBytes(env, "logo.png"), PNG);
  });
});

describe("getMessage listing inline images with includeInlineImages", () => {
  it("takes an image of multipart/related, one disposed inline and one with a Content-ID, not the others", async () => {
    const mime = {
      contentType: "message/rfc822",
      partName: "",
      parts: [{
        contentType: "multipart/mixed",
        partName: "1",
        parts: [
          { contentType: "text/plain", partName: "1.1" },
          related("1.2", glodaImage("1.2.2", { disposition: 'inline; filename="logo.png"', contentId: "cid1@example.test", size: 20 })),
          glodaImage("1.3", { type: "image/gif", disposition: 'inline; filename="b.gif"' }),
          glodaImage("1.4", { type: "image/jpeg", name: "c.jpg", contentId: "cid4@example.test" }),
          glodaImage("1.5", { disposition: 'attachment; filename="attached.png"' }),
          glodaImage("1.6", { name: "loose.png" }),
          { contentType: "message/rfc822", partName: "1.7", parts: [glodaImage("1.7.1", { name: "inside.png", contentId: "x@example.test" })] },
        ],
      }],
      allUserAttachments: [],
    };
    const { result } = await run({ mime, includeInlineImages: true });
    assert.deepEqual(listedOf(result), [
      { name: "logo.png", contentType: "image/png", size: 20, partName: "1.2.2", isInline: true, contentId: "cid1@example.test" },
      { name: "b.gif", contentType: "image/gif", size: null, partName: "1.3", isInline: true, contentId: null },
      { name: "c.jpg", contentType: "image/jpeg", size: null, partName: "1.4", isInline: true, contentId: "cid4@example.test" },
    ]);
  });

  it("lists a part that appears twice once", async () => {
    const mime = mimeTree([], [related("1", glodaImage("1.2", { name: "dup.png" }), glodaImage("1.2", { name: "dup.png" }))]);
    const { result } = await run({ mime, includeInlineImages: true });
    assert.equal(result.attachments.length, 1);
  });

  it("completes the entry of an attachment Thunderbird already lists, instead of adding another", async () => {
    const known = { name: "", contentType: "", size: undefined, url: partUrl("1.2"), partName: "1.2", contentId: "<Logo@Example.Test>" };
    const mime = mimeTree([known], [related("1", glodaImage("1.2", { name: "logo.png", contentId: "logo@example.test", size: 99 }))]);
    const { result } = await run({ mime, includeInlineImages: true });
    assert.deepEqual(listedOf(result), [
      { name: "logo.png", contentType: "image/png", size: 99, isInline: true, partName: "1.2", contentId: "logo@example.test" },
    ]);
  });

  it("keeps the name, type and size Thunderbird gave, and fetches from its url when the service has none", async () => {
    const known = { name: "mine.png", contentType: "image/jpeg", size: 12, url: partUrl("fallback"), partName: "1.2" };
    const mime = mimeTree([known], [related("1", glodaImage("1.2", { name: "theirs.png", size: 99 }))]);
    const { result } = await run({
      mime,
      includeInlineImages: true,
      noMessageService: true,
      fetches: { [partUrl("fallback")]: { data: PNG } },
    });
    const info = result.attachments[0];
    assert.equal(result.attachments.length, 1);
    assert.deepEqual([info.name, info.contentType, info.size, info.isInline, info.contentId], ["mine.png", "image/png", 12, true, null]);
    assert.equal(info.mcpImage.status, "included");
  });

  it("recovers the name and content id of an unnamed image from the raw message", async () => {
    const mime = mimeTree([], [related("1.2", glodaImage("1.2.2", { size: 20 }))]);
    mime.parts[0] = { contentType: "multipart/mixed", partName: "1", parts: [{ contentType: "text/plain", partName: "1.1" }, mime.parts[0]] };
    const raw = rawMessage([
      textPart,
      rawMessage([
        part("Content-Type: text/html", "<img src=cid:real@example.test>"),
        part('Content-Type: image/png\r\nContent-ID: <real@example.test>\r\nContent-Disposition: inline; filename="real.png"\r\nContent-Transfer-Encoding: base64', b64(PNG)),
      ], { top: "multipart/related", boundary: "r" }).replace(/^Subject: s\r\n/, ""),
    ]);
    const { result, env } = await run({ mime, raw, includeInlineImages: true });
    assert.equal(env.rawOpens, 1);
    assert.deepEqual([result.attachments[0].name, result.attachments[0].contentId], ["real.png", "real@example.test"]);
  });

  it("leaves the entry as it is when the raw message cannot be read", async () => {
    const mime = mimeTree([], [related("1", glodaImage("1.2", { size: 20 }))]);
    const { result } = await run({ mime, includeInlineImages: true, rawOpenError: new Error("stream gone") });
    assert.deepEqual([result.attachments[0].name, result.attachments[0].contentId], ["inline_1.2", null]);
  });

  it("keeps the name and content id when the raw part has none", async () => {
    const mime = mimeTree([], [related("1", glodaImage("1.2", { size: 20, contentId: "kept@example.test" }))]);
    const raw = rawMessage([
      part("Content-Type: text/html", "<p>x</p>"),
      part("Content-Type: image/png\r\nContent-ID: <kept@example.test>\r\nContent-Transfer-Encoding: base64", b64(PNG)),
    ], { top: "multipart/related" });
    const { result } = await run({ mime, raw, includeInlineImages: true });
    assert.deepEqual([result.attachments[0].name, result.attachments[0].contentId], ["inline_1.2", "kept@example.test"]);
  });
});

describe("getMessage matching inline images with Thunderbird's list and with the raw message", () => {
  it("lists an image apart from an attachment that has no part name, and takes the part of a url-less one", async () => {
    const noPart = { name: "k.png", contentType: "image/png", size: 5, url: partUrl("9") };
    const mime = mimeTree([noPart], [related("1", glodaImage("1.2", { name: "other.png", size: 4 }))]);
    const { result } = await run({ mime, includeInlineImages: true });
    assert.deepEqual(Array.from(result.attachments, a => a.name), ["k.png", "other.png"]);
    const noUrl = { name: "k.png", contentType: "image/png", size: 5, partName: "1.2" };
    const matched = await run({ mime: mimeTree([noUrl], [related("1", glodaImage("1.2", { size: 4 }))]), includeInlineImages: true, noMessageService: true });
    assert.equal(matched.result.attachments.length, 1);
    assert.equal(matched.result.attachments[0].mcpImage.reason, "Inline image has no fetchable message-part URL");
  });

  it("walks parts without a content type", async () => {
    const mime = mimeTree([], [related("1", { partName: "1.2" }, { contentType: ";charset=x", partName: "1.3" }, glodaImage("1.4", { name: "a.png", size: 4 }))]);
    const { result } = await run({ mime, includeInlineImages: true });
    assert.deepEqual(Array.from(result.attachments, a => a.name), ["a.png"]);
  });

  it("names an unnamed image after the raw part it matches by position, without inventing a content id", async () => {
    const mime = mimeTree([], [related("1", glodaImage("1.2", { size: 4 }))]);
    const raw = rawMessage([
      part("Content-Type: text/html", "<p>x</p>"),
      part('Content-Type: image/png\r\nContent-Disposition: inline; filename="real.png"\r\nContent-Transfer-Encoding: base64', b64("PNG!")),
    ], { top: "multipart/related" });
    const { result } = await run({ mime, raw, includeInlineImages: true });
    assert.deepEqual([result.attachments[0].name, result.attachments[0].contentId], ["real.png", null]);
  });

  it("leaves an image alone when no raw image has its Content-ID or part name", async () => {
    const mime = mimeTree([], [related("1", glodaImage("1.2", { size: 4, contentId: "a@example.test" }))]);
    const raw = rawMessage([
      part("Content-Type: text/html", "<p>x</p>"),
      part("Content-Type: text/plain", "filler"),
      part('Content-Type: image/png\r\nContent-ID: <z@example.test>\r\nContent-Disposition: inline; filename="other.png"\r\nContent-Transfer-Encoding: base64', b64("PNG!")),
    ], { top: "multipart/related" });
    const { result } = await run({ mime, raw, includeInlineImages: true });
    assert.deepEqual([result.attachments[0].name, result.attachments[0].contentId], ["inline_1.2", "a@example.test"]);
  });
});

describe("getMessage returning inline images as content blocks", () => {
  const withImages = (...images) => mimeTree([], [related("1", ...images)]);
  const blocksOf = result => Array.from(sandbox.buildToolResultContent(result)).slice(1);

  it("puts the images the body shows first, in the order it shows them, after the text", async () => {
    const mime = withImages(
      glodaImage("1.2", { contentId: "a@example.test", name: "a.png", size: PNG.length }),
      glodaImage("1.3", { contentId: "b@example.test", name: "b.png", size: PNG.length }),
      glodaImage("1.4", { contentId: "c@example.test", name: "c.gif", type: "image/gif", size: PNG.length })
    );
    const { result } = await run({
      mime,
      includeInlineImages: true,
      body: "![b](cid:b@example.test) and ![a](cid:a@example.test)",
      fetches: { [partUrl("1.2")]: { data: "AAAA" }, [partUrl("1.3")]: { data: "BBBB" }, [partUrl("1.4")]: { data: "CCCC" } },
    });
    const blocks = blocksOf(result);
    assert.deepEqual(blocks.map(b => [b.type, b.mimeType, Buffer.from(b.data, "base64").toString()]), [
      ["image", "image/png", "BBBB"],
      ["image", "image/png", "AAAA"],
      ["image", "image/gif", "CCCC"],
    ]);
    assert.deepEqual(plain(result.attachments.map(a => a.mcpImage)), [
      { status: "included", contentBlockIndex: 2, base64Bytes: 8 },
      { status: "included", contentBlockIndex: 1, base64Bytes: 8 },
      { status: "included", contentBlockIndex: 3, base64Bytes: 8 },
    ]);
    assert.deepEqual(plain(result.inlineImageContent), {
      included: 3,
      skipped: 0,
      totalBase64Bytes: 24,
      limits: { perImageBase64Bytes: MAX_INLINE_IMAGE_BASE64_BYTES, totalBase64Bytes: 4 * MAX_INLINE_IMAGE_BASE64_BYTES },
    });
  });

  it("says why an image was left out, and still returns the others", async () => {
    const mime = withImages(
      glodaImage("1.2", { name: "ok.png", size: 4 }),
      glodaImage("1.3", { name: "vector.svg", type: "image/svg+xml", size: 4 }),
      glodaImage("1.4", { name: "big.png", size: 2 * MAX_INLINE_IMAGE_BASE64_BYTES }),
      glodaImage("1.5", { name: "gone.png", size: 4 }),
      glodaImage("1.6", { name: "empty.png", size: 4 }),
      glodaImage("1.7", { name: "nodata.png", size: 4 })
    );
    const { result } = await run({
      mime,
      includeInlineImages: true,
      fetches: {
        [partUrl("1.2")]: { data: "OKOK" },
        [partUrl("1.3")]: { data: "<svg/>" },
        [partUrl("1.4")]: { data: "BIG" },
        [partUrl("1.5")]: { status: 2147500037, data: "x" },
        [partUrl("1.6")]: { data: "" },
        [partUrl("1.7")]: { noStream: true },
      },
    });
    assert.deepEqual(Array.from(result.attachments, a => a.mcpImage.status), ["included", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    assert.deepEqual(Array.from(result.attachments, a => a.mcpImage.reason).slice(1), [
      'Unsupported MIME type "image/svg+xml"',
      `Image exceeds per-image base64 limit (${4 * Math.ceil(2 * MAX_INLINE_IMAGE_BASE64_BYTES / 3)} bytes > ${MAX_INLINE_IMAGE_BASE64_BYTES} bytes)`,
      "Inline image fetch failed: 2147500037",
      "Image data is empty",
      "Inline image fetch returned no data",
    ]);
    assert.equal(result.inlineImageContent.included, 1);
    assert.equal(result.inlineImageContent.skipped, 5);
  });

  it("skips an image without a url to fetch it from", async () => {
    const { result } = await run({ mime: withImages(glodaImage("1.2", { size: 4 })), includeInlineImages: true, noMessageService: true });
    assert.deepEqual(plain(result.attachments[0].mcpImage), { status: "skipped", reason: "Inline image has no fetchable message-part URL" });
    assert.equal(result.inlineImageContent.included, 0);
    assert.equal(blocksOf(result).length, 0);
  });

  it("stops reading an image of unknown size at the per-image limit", async () => {
    const maxRaw = Math.floor(MAX_INLINE_IMAGE_BASE64_BYTES / 4) * 3;
    const { result } = await run({
      mime: withImages(glodaImage("1.2", { name: "exact.png" }), glodaImage("1.3", { name: "over.png" })),
      includeInlineImages: true,
      fetches: { [partUrl("1.2")]: { data: "x".repeat(maxRaw) }, [partUrl("1.3")]: { data: "x".repeat(maxRaw + 1) } },
    });
    assert.equal(result.attachments[0].mcpImage.status, "included");
    assert.equal(result.attachments[0].mcpImage.base64Bytes, MAX_INLINE_IMAGE_BASE64_BYTES);
    assert.deepEqual(plain(result.attachments[1].mcpImage), {
      status: "skipped",
      reason: `Image exceeds per-image base64 limit (${MAX_INLINE_IMAGE_BASE64_BYTES} bytes)`,
    });
  });

  it("stops at the total limit, before and after fetching", async () => {
    const maxRaw = Math.floor(MAX_INLINE_IMAGE_BASE64_BYTES / 4) * 3;
    const image = (n, extra = {}) => glodaImage(`1.${n + 1}`, { name: `i${n}.png`, ...extra });
    const full = n => image(n, { size: maxRaw });
    const fetches = {};
    for (let n = 1; n <= 8; n++) fetches[partUrl(`1.${n + 1}`)] = { data: "x".repeat(n === 4 ? 90000 : n === 5 ? maxRaw : n === 6 ? 10 : maxRaw) };
    // Three full images and a small one use 3.1 of the 4 MiB; the next full one, of unknown size, does not fit
    const { result } = await run({
      mime: withImages(full(1), full(2), full(3), image(4, { size: 90000 }), image(5), image(6, { size: 10 })),
      includeInlineImages: true,
      fetches,
    });
    const statuses = Array.from(result.attachments, a => a.mcpImage.status);
    assert.deepEqual(statuses, ["included", "included", "included", "included", "skipped", "included"]);
    assert.match(result.attachments[4].mcpImage.reason, /^Image would exceed total base64 limit \(\d+ bytes > 4194304 bytes\)$/);
    assert.equal(result.inlineImageContent.included, 5);
    assert.equal(result.inlineImageContent.skipped, 1);
  });

  it("stops at the total limit once it is used up", async () => {
    const maxRaw = Math.floor(MAX_INLINE_IMAGE_BASE64_BYTES / 4) * 3;
    const full = n => glodaImage(`1.${n + 1}`, { name: `i${n}.png`, size: maxRaw });
    const fetches = {};
    for (let n = 1; n <= 5; n++) fetches[partUrl(`1.${n + 1}`)] = { data: "x".repeat(maxRaw) };
    const { result } = await run({
      mime: withImages(full(1), full(2), full(3), full(4), glodaImage("1.6", { name: "late.png", size: 3 })),
      includeInlineImages: true,
      fetches,
    });
    assert.equal(result.inlineImageContent.totalBase64Bytes, 4 * MAX_INLINE_IMAGE_BASE64_BYTES);
    assert.deepEqual(plain(result.attachments[4].mcpImage), { status: "skipped", reason: `Total base64 limit reached (${4 * MAX_INLINE_IMAGE_BASE64_BYTES} bytes)` });
    assert.equal(blocksOf(result).length, 4);
  });

  it("returns no image blocks, and no inlineImageContent, when the option is off", async () => {
    const mime = { contentType: "multipart/related", partName: "", parts: [glodaImage("2", { name: "logo.png", size: 4 })], allUserAttachments: [] };
    const { result } = await run({ mime, fetches: { [partUrl("2")]: { data: "PNG!" } } });
    assert.equal(result.inlineImageContent, undefined);
    assert.equal(Array.from(sandbox.buildToolResultContent(result)).length, 1);
  });
});

// ---- more ways saving fails, and the paths of an unusual message ------------------------------------------------

describe("getMessage when saving an attachment goes wrong in an unusual way", () => {
  const entry = attachmentEntry("a.pdf", 3);

  it("recovers from the raw message when the size of the saved copy cannot be read", async () => {
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      raw: rawMessage([textPart, filePart("a.pdf", "abc")]),
      fetches: { [entry.url]: { data: "abc" } },
      fileSize: (_, file) => {
        if (file && !file.recovered) throw new Error("stat failed");
        return undefined;
      },
    });
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(env.rawOpens, 1);
    assert.equal(result.attachments[0].filePath, `${SAVED_DIR}/a.pdf`);
  });

  it("names a failure after the copy, such as a path that cannot be read", async () => {
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      fetches: { [entry.url]: { data: "abc" } },
      pathErrorAfterCopy: new Error("path gone"),
    });
    assert.equal(result.attachments[0].error, "Write failed: Error: path gone");
    assert.equal(result.attachments[0].filePath, undefined);
    assert.equal(env.fsState.removed.length, 1);
  });

  it("names a failure to open the output file, and removes the file", async () => {
    const { result, env } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      fetches: { [entry.url]: { data: "abc" } },
      ostreamInitError: new Error("cannot open"),
    });
    assert.equal(result.attachments[0].error, "Fetch failed: Error: cannot open");
    assert.equal(env.fsState.removed.length, 1);
  });

  it("saves under a fixed name for a message without id and for names that are nothing but symbols", async () => {
    const odd = attachmentEntry("***", 3, { url: "mailbox:///Inbox?number=4&part=1.2" });
    const { result } = await run({ messageId: "", saveAttachments: true, mime: mimeTree([odd]), fetches: { [odd.url]: { data: "abc" } } });
    assert.equal(result.attachments[0].filePath, "/tmp/commonpost-mcp/message/attachment");
    const underscores = await run({ messageId: "<<<>>>", saveAttachments: true, mime: mimeTree([odd]), fetches: { [odd.url]: { data: "abc" } } });
    assert.equal(underscores.result.attachments[0].filePath, "/tmp/commonpost-mcp/______/attachment");
  });

  it("names a message directory that cannot be created, though the temporary one could", async () => {
    const { result } = await run({ saveAttachments: true, failMessageDirCreate: true, mime: mimeTree([entry]), fetches: { [entry.url]: { data: "abc" } } });
    assert.equal(result.attachments[0].error, "Failed to create attachment directory: Error: EACCES");
  });

  it("recovers an attachment whose content type is missing or has no type", async () => {
    for (const contentType of ["", ";charset=x"]) {
      const odd = attachmentEntry("a.bin", 3, { contentType });
      const { result, env } = await run({
        saveAttachments: true,
        mime: mimeTree([odd]),
        raw: rawMessage([textPart, filePart("a.bin", "abc")]),
        fetches: emptyCopies(odd),
      });
      assert.equal(result.attachments[0].error, undefined, contentType);
      assert.equal(savedBytes(env, "a.bin"), "abc");
    }
  });

  it("names a channel that cannot be created", async () => {
    const { result } = await run({
      saveAttachments: true,
      mime: mimeTree([entry]),
      newChannelError: new Error("bad uri"),
      fetches: { [entry.url]: { data: "abc" } },
    });
    assert.equal(result.attachments[0].error, "Error: bad uri");
  });
});

describe("getMessage with a message Thunderbird could not give or that is encrypted", () => {
  it("passes on that the message was not found", async () => {
    const { result } = await run({ found: { error: "Message not found" } });
    assert.deepEqual(plain(result), { error: "Message not found" });
  });

  it("says when the message could not be parsed", async () => {
    const { result } = await run({ mime: null });
    assert.deepEqual(plain(result), { error: "Could not parse message" });
  });

  it("says when getMessage itself failed", async () => {
    const { result, env } = await run({ importError: new Error("module gone"), mime: mimeTree([]) });
    assert.deepEqual(plain(result), { error: "Failed to get message" });
    assert.ok(env.logs.some(args => /getMessage failed/.test(args[0])));
    const throwing = await run({ mime: { contentType: "message/rfc822", get allUserAttachments() { throw new Error("tree gone"); } } });
    assert.deepEqual(plain(throwing.result), { error: "Failed to get message" });
  });

  it("returns a notice instead of an encrypted message, with the subject as it came over the wire", async () => {
    const mime = { contentType: "multipart/encrypted", partName: "", parts: [], allUserAttachments: [] };
    const raw = 'Subject: ...\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"\r\n\r\n--b--\r\n';
    const { result, env } = await run({ mime, raw, encryptedAllowed: false, hdr: { mime2DecodedSubject: "DECRYPTED SECRET", date: 0 } });
    assert.equal(result.encrypted, true);
    assert.equal(result.subject, "...");
    assert.match(result.body, /^message chiffré/);
    assert.equal(result.bodyIsHtml, false);
    assert.deepEqual(plain(result.attachments), []);
    assert.equal(result.date, null);
    assert.equal(env.mimeCallOptions.examineEncryptedParts, false);
    assert.equal(JSON.stringify(result).includes("DECRYPTED SECRET"), false);
  });

  it("never falls back to the database subject for an encrypted message whose headers it cannot read", async () => {
    const mime = { contentType: "multipart/encrypted", partName: "", parts: [], allUserAttachments: [] };
    const { result } = await run({
      mime,
      raw: "",
      encryptedAllowed: false,
      hdr: { mime2DecodedSubject: "DECRYPTED SECRET", mime2DecodedAuthor: "", author: "alice@example.test", mime2DecodedRecipients: "", recipients: "bob@example.test" },
    });
    assert.equal(result.subject, "");
    assert.equal(result.author, "alice@example.test");
    assert.equal(result.recipients, "bob@example.test");
  });

  it("returns an encrypted message as any other when encrypted content is allowed", async () => {
    const mime = { contentType: "multipart/encrypted", partName: "", parts: [], allUserAttachments: [] };
    const { result } = await run({ mime, encryptedAllowed: true });
    assert.equal(result.encrypted, undefined);
    assert.equal(result.body, "Body text");
  });

  it("falls back to the plain author and recipients, and to no date", async () => {
    const { result } = await run({
      mime: mimeTree([]),
      hdr: { mime2DecodedAuthor: "", author: "alice@example.test", mime2DecodedRecipients: "", recipients: "bob@example.test", date: 0 },
    });
    assert.deepEqual([result.author, result.recipients, result.date], ["alice@example.test", "bob@example.test", null]);
    assert.deepEqual(plain(result.tags), ["$label1"]);
  });

  it("reads a message tree without attachments or parts", async () => {
    const { result } = await run({ mime: { contentType: "message/rfc822", partName: "" } });
    assert.deepEqual(plain(result.attachments), []);
  });
});

describe("getMessage raw source", () => {
  const rawText = "Subject: Wire subject\r\nContent-Type: text/plain; charset=utf-8\r\n\r\ncafÃ©";

  it("returns the decoded source with its charset and the subject as it came over the wire", async () => {
    const { result, env } = await run({ rawSource: true, raw: rawText });
    assert.deepEqual(plain(result), {
      id: "<msg-1@example.test>",
      subject: "Wire subject",
      rawSource: "Subject: Wire subject\r\nContent-Type: text/plain; charset=utf-8\r\n\r\ncafé",
      rawCharset: "utf-8",
    });
    assert.equal(env.rawStreams[0].closed, true);
  });

  it("falls back to the subject of the database when the wire headers have none", async () => {
    const { result } = await run({ rawSource: true, raw: "From: a@example.test\r\n\r\nbody" });
    assert.equal(result.subject, "Subject line");
    const plainSubject = await run({ rawSource: true, raw: "From: a@example.test\r\n\r\nbody", hdr: { mime2DecodedSubject: "", subject: "raw subject" } });
    assert.equal(plainSubject.result.subject, "raw subject");
  });

  it("returns the exact bytes as base64 when asked", async () => {
    const raw = "Subject: S\r\n\r\néÿ";
    const { result } = await run({ rawSource: true, rawEncoding: "base64", raw });
    assert.deepEqual(plain(result), { id: "<msg-1@example.test>", subject: "S", rawSource: b64(raw), rawEncoding: "base64" });
    const fallback = await run({ rawSource: true, rawEncoding: "base64", raw: "\r\nbody", hdr: { mime2DecodedSubject: "", subject: "raw subject" } });
    assert.equal(fallback.result.subject, "raw subject");
  });

  it("refuses an empty message", async () => {
    const { result } = await run({ rawSource: true, raw: "" });
    assert.deepEqual(plain(result), { error: "Message has zero size - cannot read raw source" });
  });

  it("names a read that fails, and closes the stream", async () => {
    const { result, env } = await run({ rawSource: true, raw: "x", rawStreamRead() { throw new Error("read failed"); }, rawCloseError: new Error("close failed") });
    assert.deepEqual(plain(result), { error: "Failed to read raw source" });
    assert.equal(env.rawStreams[0].closed, true);
    assert.ok(env.logs.some(args => /raw source read failed/.test(args[0])));
    const noStream = await run({ rawSource: true, rawOpenError: new Error("gone") });
    assert.deepEqual(plain(noStream.result), { error: "Failed to read raw source" });
  });

  it("warns that bytes that are not UTF-8 were replaced", async () => {
    const { result } = await run({ rawSource: true, raw: "Content-Type: text/plain; charset=utf-8\r\n\r\ncaf\xe9" });
    assert.equal(result.rawCharset, "utf-8");
    assert.equal(result.warning, 'rawSource is not valid UTF-8: invalid bytes were replaced with U+FFFD. rawEncoding "base64" returns the exact bytes.');
  });

  it("warns that parts declare different charsets", async () => {
    const raw = "Content-Type: multipart/mixed; charset=iso-8859-15; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=windows-1251\r\n\r\n\xa4\r\n--b--";
    const { result } = await run({ rawSource: true, raw });
    assert.equal(result.rawCharset, "iso-8859-15");
    assert.deepEqual(plain(result.rawMixedCharsets), ["iso-8859-15", "windows-1251"]);
    assert.match(result.warning, /^Parts declare different charsets; rawSource is decoded as iso-8859-15, so text in the other charsets may be garbled\. rawEncoding "base64" returns the exact bytes\.$/);
  });

  it("asks Thunderbird's detector for a message that declares nothing", async () => {
    const { result } = await run({ rawSource: true, raw: "Subject: x\r\n\r\ncaf\xe9", detectCharset: () => "windows-1252" });
    assert.equal(result.rawCharset, "windows-1252");
    assert.ok(result.rawSource.endsWith("café"));
    assert.equal(result.warning, undefined);
  });
});

describe("getMessage building the url of an inline image", () => {
  it("adds the part to a url that has no query, with a question mark", async () => {
    const mime = { contentType: "multipart/related", partName: "", parts: [glodaImage("2", { name: "logo.png", size: 4 })], allUserAttachments: [] };
    const { env } = await run({
      mime,
      includeInlineImages: true,
      specNoQuery: true,
      fetches: { "mailbox:///Inbox?part=2": { data: "PNG!" } },
    });
    assert.equal(env.streams.length, 1, "the image was fetched from that url");
  });

  it("returns the message with a note, not an error, when the image blocks cannot be assembled", async () => {
    const mime = mimeTree([], [related("1", glodaImage("1.2", { name: "a.png", size: 4 }), glodaImage("1.3", { name: "b.png", size: 4 }))]);
    vm.runInContext("Object.defineProperty(Object.prototype, 'mcpImage', { set() { throw new Error('cannot set'); }, configurable: true })", sandbox);
    try {
      const { result, env } = await run({ mime, includeInlineImages: true, fetches: { [partUrl("1.2")]: { data: "PNG!" }, [partUrl("1.3")]: { data: "PNG!" } } });
      assert.deepEqual(plain(result.inlineImageContent), {
        included: 0,
        skipped: 2,
        error: "Failed to include inline images",
        limits: { perImageBase64Bytes: MAX_INLINE_IMAGE_BASE64_BYTES, totalBase64Bytes: 4 * MAX_INLINE_IMAGE_BASE64_BYTES },
      });
      assert.ok(env.logs.some(args => /inline image content assembly failed/.test(args[0])));
    } finally {
      vm.runInContext("delete Object.prototype.mcpImage", sandbox);
    }
  });

  it("names an image whose bytes cannot be encoded", async () => {
    const mime = mimeTree([], [related("1", glodaImage("1.2", { name: "a.png", size: 4 }))]);
    const { result, env } = await run({ mime, includeInlineImages: true, fetches: { [partUrl("1.2")]: { data: "Āā" } } });
    assert.deepEqual(plain(result.attachments[0].mcpImage), { status: "skipped", reason: "Inline image fetch failed" });
    assert.ok(env.logs.some(args => /inline image fetch callback failed/.test(args[0])));
  });

  it("lists the images that can be fetched, and names those whose fetch fails or whose channel cannot be made", async () => {
    const mime = mimeTree([], [related("1", glodaImage("1.2", { name: "a.png" }), glodaImage("1.3", { name: "b.png" }))]);
    const { result } = await run({
      mime,
      includeInlineImages: true,
      fetches: { [partUrl("1.2")]: { data: "PNG!" } },
    });
    assert.equal(result.attachments[0].mcpImage.status, "included");
    assert.equal(result.attachments[1].mcpImage.reason, "Inline image fetch failed: 2147500037");
    const broken = await run({ mime: mimeTree([], [related("1", glodaImage("1.2", { name: "a.png" }))]), includeInlineImages: true, newChannelError: new Error("bad uri") });
    assert.equal(broken.result.attachments[0].mcpImage.reason, "Inline image fetch failed");
  });
});
