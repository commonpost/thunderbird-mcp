// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// The signature of an identity as ProcessSignature inserts it: when a message gets one (sig_on_reply, sig_on_fwd), where
// it comes from (a file of text, HTML or an image, or the text of the identity), the charset of the file, and how it is
// framed in an HTML or a plain message. Runs the real functions of api.js against stand-ins for the file services.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function slice(start, end) {
  const i = API.indexOf(start);
  assert.ok(i >= 0, `${start} not found`);
  const j = API.indexOf(end, i);
  assert.ok(j > i, `${end} not found`);
  return API.slice(i, j);
}

function fn(name) {
  const indent = "            ";
  const start = API.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  const end = API.indexOf(close, start);
  assert.ok(end > start, `end of ${name} not found in api.js`);
  return API.slice(start, end + close.length);
}

const code = `${slice("// BEGIN COMPOSE HELPERS", "// END COMPOSE HELPERS")}
${["readFileBytes", "fileMimeType", "fileDataURL", "fileURLToDataURL", "readSignatureFile", "signatureFor"].map(fn).join("\n")}
this.api = { readFileBytes, fileMimeType, fileDataURL, fileURLToDataURL, readSignatureFile, signatureFor };`;

const CompType = {
  New: 0, Reply: 1, ReplyAll: 2, ForwardAsAttachment: 3, ForwardInline: 4, ReplyToSender: 6, ReplyToGroup: 7, ReplyToSenderAndGroup: 8, Draft: 9, ReplyToList: 13,
};
const REPLIES = ["Reply", "ReplyAll", "ReplyToList", "ReplyToGroup", "ReplyToSender", "ReplyToSenderAndGroup"];

// A file is { bytes (a binary string), mime, leafName, path, ... }
const bytesOf = (text, encoding = "utf8") => Buffer.from(text, encoding).toString("latin1");
const file = (bytes, extra = {}) => ({ bytes, mime: "text/plain", leafName: "sig.txt", path: "/home/me/sig.txt", exists: () => true, isDirectory: () => false, ...extra });

function load({ files = {}, detectCharset = () => "windows-1252", extra = {} } = {}) {
  const log = { closed: 0, init: [], warnings: [], plain: [], escaped: [] };
  const sandbox = {
    TextDecoder,
    btoa,
    console: { warn: (...args) => log.warnings.push(args) },
    Ci: {
      nsIFileInputStream: {}, nsIBinaryInputStream: {}, nsIMIMEService: {}, nsINetUtil: { ESCAPE_URL_FILE_BASENAME: 1, ESCAPE_URL_FORCED: 2 }, nsIFileURL: {},
      nsIMsgCompType: CompType,
    },
    Cc: {
      "@mozilla.org/network/file-input-stream;1": {
        createInstance: () => ({ init(f, flags, perm, behavior) { this.file = f; log.init.push([flags, perm, behavior]); } }),
      },
      "@mozilla.org/binaryinputstream;1": {
        createInstance: () => ({
          setInputStream(stream) { this.stream = stream; },
          available() { return this.stream.file.bytes.length; },
          readBytes(count) { if (this.stream.file.failRead) throw new Error("read failed"); return this.stream.file.bytes.slice(0, count); },
          close() { log.closed++; },
        }),
      },
      "@mozilla.org/mime;1": {
        getService: () => ({ getTypeFromFile(f) { if (f.mime === undefined) throw new Error("no type"); return f.mime; } }),
      },
    },
    ChromeUtils: {
      importESModule: () => ({ MailStringUtils: { stringToByteString: s => s, detectCharset: bytes => detectCharset(bytes) } }),
    },
    Services: {
      io: {
        newURI: url => ({ QueryInterface: () => ({ file: files[url] }) }),
        QueryInterface: () => ({ escapeURL: (name, flags) => { log.escaped.push([name, flags]); return encodeURIComponent(name); } }),
      },
    },
    htmlToPlainText: (...args) => { log.plain.push(args); return `TEXT[${args[0]}]`; },
    ...extra,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { ...sandbox.api, log };
}

describe("readFileBytes and fileMimeType", () => {
  it("reads the whole file and closes the stream, also when reading fails", () => {
    const { readFileBytes, log } = load();
    assert.equal(readFileBytes(file("abc\x00\xff")), "abc\x00\xff");
    assert.deepEqual(log.init, [[1, 0, 0]]);
    assert.equal(log.closed, 1);
    assert.throws(() => readFileBytes(file("abc", { failRead: true })), /read failed/);
    assert.equal(log.closed, 2);
  });

  it("gives the type of the file, or nothing when Thunderbird has none", () => {
    const { fileMimeType } = load();
    assert.equal(fileMimeType(file("", { mime: "text/html" })), "text/html");
    assert.equal(fileMimeType(file("", { mime: undefined })), "");
  });
});

describe("fileDataURL", () => {
  it("makes a data URL of the type, the escaped file name, and the bytes in base64", () => {
    const { fileDataURL, log } = load();
    assert.equal(fileDataURL(file("\x00\x01\x02", { mime: "image/png", leafName: "my sig.png" })), "data:image/png;filename=my%20sig.png;base64,AAEC");
    assert.deepEqual(log.escaped, [["my sig.png", 3]]);
  });

  it("leaves the file name out when the file has none", () => {
    const { fileDataURL } = load();
    assert.equal(fileDataURL(file("A", { mime: "image/gif", leafName: "" })), "data:image/gif;base64,QQ==");
  });

  it("fileURLToDataURL reads the file a file: URL names", () => {
    const logo = file("A", { mime: "image/png", leafName: "logo.png" });
    const { fileURLToDataURL } = load({ files: { "file:///home/me/logo.png": logo } });
    assert.equal(fileURLToDataURL("file:///home/me/logo.png"), "data:image/png;filename=logo.png;base64,QQ==");
  });
});

describe("readSignatureFile", () => {
  it("reads UTF-8", () => {
    const { readSignatureFile } = load();
    assert.equal(readSignatureFile(file(bytesOf("Sig é €")), false), "Sig é €");
  });

  it("reads the charset a meta tag declares, and drops that declaration from HTML that goes into an HTML message", () => {
    const { readSignatureFile } = load();
    const html = file(bytesOf("<meta http-equiv=content-type content=text/html;charset=iso-8859-1>café", "latin1"));
    assert.equal(readSignatureFile(html, false), "<meta http-equiv=content-type content=text/html;charset=iso-8859-1>café");
    assert.equal(readSignatureFile(html, true), "<meta http-equiv=content-type content=text/html;>café");
    // the match is on the name, not its case
    assert.equal(readSignatureFile(file(bytesOf("<META CHARSET=ISO-8859-1>é", "latin1")), true), "<META >é");
  });

  it("keeps a quoted declaration, which is not written as charset=NAME (nsMsgCompose::LoadDataFromFile cuts only that)", () => {
    const { readSignatureFile } = load();
    assert.equal(readSignatureFile(file(bytesOf('<meta charset="utf-8">x')), true), '<meta charset="utf-8">x');
  });

  it("passes over a declared charset it does not know and reads the file as UTF-8", () => {
    const { readSignatureFile } = load();
    assert.equal(readSignatureFile(file(bytesOf("<meta charset=x-nonexistent>é")), false), "<meta charset=x-nonexistent>é");
  });

  it("reads UTF-16 by its byte order mark, little or big endian, when the length is even", () => {
    const { readSignatureFile } = load({ detectCharset: () => { throw new Error("not needed"); } });
    assert.equal(readSignatureFile(file(`\xff\xfe${bytesOf("Hi", "utf16le")}`), false), "Hi");
    assert.equal(readSignatureFile(file(`\xfe\xff${bytesOf("Hi", "utf16le").replace(/(.)(.)/gs, "$2$1")}`), false), "Hi");
  });

  it("asks Thunderbird to detect the charset of what is neither UTF-8 nor UTF-16", () => {
    const seen = [];
    const { readSignatureFile } = load({ detectCharset: bytes => { seen.push(bytes); return "windows-1252"; } });
    assert.equal(readSignatureFile(file("caf\xe9"), false), "café");
    // a byte order mark on a file of odd length is not UTF-16
    assert.equal(readSignatureFile(file("\xff\xfeabc"), false), "ÿþabc");
    assert.deepEqual(seen, ["caf\xe9", "\xff\xfeabc"]);
  });

  it("returns the bytes as they are when the detected charset is not usable", () => {
    for (const detected of ["x-nonexistent", ""]) {
      const { readSignatureFile } = load({ detectCharset: () => detected });
      assert.equal(readSignatureFile(file("caf\xe9"), true), "caf\xe9", JSON.stringify(detected));
    }
  });
});

describe("signatureFor", () => {
  const prefs = { replyOnTop: 0, sigBottom: true, paragraphMode: false, wrapLength: 72, suppressSigSep: false, sigAboveQuote: false };
  const textIdentity = (extra = {}) => ({ sigOnReply: true, sigOnForward: true, attachSignature: false, htmlSigText: "Bench\nUser", htmlSigFormat: false, ...extra });

  it("has no signature for no identity", () => {
    assert.equal(load().signatureFor(null, CompType.New, true, false, prefs), "");
  });

  it("frames the text of the identity in an HTML message, escaped, under the separator", () => {
    const { signatureFor } = load();
    assert.equal(signatureFor(textIdentity({ htmlSigText: "A <b> & C" }), CompType.New, true, false, prefs),
      '<br><pre class="moz-signature" cols=72>-- \nA &lt;b&gt; &amp; C</pre>');
  });

  it("frames an HTML signature as HTML, with the file: images it holds as data: URLs", () => {
    const logo = file("A", { mime: "image/png", leafName: "logo.png" });
    const { signatureFor } = load({ files: { "file:///home/me/logo.png": logo } });
    assert.equal(signatureFor(textIdentity({ htmlSigFormat: true, htmlSigText: '<b>Me</b><img src="file:///home/me/logo.png">' }), CompType.New, true, false, prefs),
      '<br><div class="moz-signature">-- <br><b>Me</b><img src="data:image/png;filename=logo.png;base64,QQ=="></div>');
  });

  it("converts an HTML signature to text for a plain message (the converter ends its text), and takes a text signature as it is", () => {
    const { signatureFor, log } = load();
    assert.equal(signatureFor(textIdentity({ htmlSigFormat: true, htmlSigText: "<b>Me</b>" }), CompType.New, false, false, prefs), "-- \nTEXT[<b>Me</b>]");
    assert.deepEqual(log.plain, [["<b>Me</b>", false, true, true]]);
    assert.equal(signatureFor(textIdentity(), CompType.New, false, false, prefs), "-- \nBench\nUser\n");
    assert.equal(signatureFor(textIdentity(), CompType.New, false, true, { ...prefs, replyOnTop: 1, sigBottom: false }), "\nBench\nUser\n");
  });

  it("has no signature when the identity has no text for one", () => {
    const { signatureFor } = load();
    assert.equal(signatureFor(textIdentity({ htmlSigText: "" }), CompType.New, true, false, prefs), "");
    assert.equal(signatureFor(textIdentity({ htmlSigText: undefined }), CompType.New, false, false, prefs), "");
  });

  it("adds the signature to a forward only when the identity wants it there", () => {
    const { signatureFor } = load();
    for (const type of ["ForwardInline", "ForwardAsAttachment"]) {
      assert.equal(signatureFor(textIdentity({ sigOnForward: false }), CompType[type], false, true, prefs), "", type);
      assert.equal(signatureFor(textIdentity({ sigOnForward: true, sigOnReply: false }), CompType[type], false, true, prefs), "-- \nBench\nUser\n", type);
    }
  });

  it("adds the signature to a reply, whatever kind, only when the identity wants it there", () => {
    const { signatureFor } = load();
    for (const kind of REPLIES) {
      assert.equal(signatureFor(textIdentity({ sigOnReply: false }), CompType[kind], false, true, prefs), "", kind);
      assert.equal(signatureFor(textIdentity({ sigOnReply: true, sigOnForward: false }), CompType[kind], false, true, prefs), "-- \nBench\nUser\n", kind);
    }
  });

  it("does not look at sig_on_reply or sig_on_fwd for a new message or a draft", () => {
    const { signatureFor } = load();
    for (const type of [CompType.New, CompType.Draft]) {
      assert.equal(signatureFor(textIdentity({ sigOnReply: false, sigOnForward: false }), type, false, false, prefs), "-- \nBench\nUser\n");
    }
  });

  describe("from a file", () => {
    // sig_file is read when the signature is made, and can fail then
    const attached = f => Object.defineProperty(textIdentity({ attachSignature: true, htmlSigText: "ignored" }), "signature", { get() { if (f instanceof Error) throw f; return f; } });

    it("reads a text file as the text of the signature", () => {
      const { signatureFor } = load();
      const sig = attached(file(bytesOf("File sig é <3")));
      assert.equal(signatureFor(sig, CompType.New, true, false, prefs), '<br><pre class="moz-signature" cols=72>-- \nFile sig é &lt;3</pre>');
      assert.equal(signatureFor(sig, CompType.New, false, false, prefs), "-- \nFile sig é <3\n");
    });

    it("reads an HTML file as HTML, or as converted text in a plain message", () => {
      const { signatureFor, log } = load();
      const sig = attached(file(bytesOf("<i>Me</i>"), { mime: "text/html" }));
      assert.equal(signatureFor(sig, CompType.New, true, false, prefs), '<br><div class="moz-signature">-- <br><i>Me</i></div>');
      assert.equal(signatureFor(sig, CompType.New, false, false, prefs), "-- \nTEXT[<i>Me</i>]");
      assert.deepEqual(log.plain, [["<i>Me</i>", false, true, true]]);
    });

    it("reads a file of unknown type as text", () => {
      const { signatureFor } = load();
      assert.equal(signatureFor(attached(file("plain", { mime: undefined })), CompType.New, false, false, prefs), "-- \nplain\n");
    });

    it("puts an image in an HTML message as an inline image, and has no signature in a plain one", () => {
      const { signatureFor } = load();
      const sig = attached(file("\x00\x01\x02", { mime: "IMAGE/PNG", leafName: "me.png" }));
      assert.equal(signatureFor(sig, CompType.New, true, false, prefs),
        "<br><div class=\"moz-signature\">-- <br><img src='data:IMAGE/PNG;filename=me.png;base64,AAEC' border=0></div>");
      assert.equal(signatureFor(sig, CompType.New, false, false, prefs), "");
    });

    it("has no signature when the file cannot be used: none set, no path, missing, or a directory", () => {
      const { signatureFor } = load();
      for (const unusable of [null, new Error("no sig_file"), file("x", { path: "" }), file("x", { exists: () => false }), file("x", { isDirectory: () => true })]) {
        assert.equal(signatureFor(attached(unusable), CompType.New, false, false, prefs), "", String(unusable?.message || unusable?.path));
      }
    });
  });

  it("goes on without a signature, and says why, when the identity cannot be read", () => {
    const { signatureFor, log } = load();
    const error = new Error("identity gone");
    const broken = { get sigOnForward() { throw error; } };
    assert.equal(signatureFor(broken, CompType.ForwardInline, true, true, prefs), "");
    assert.equal(log.warnings.length, 1);
    assert.match(log.warnings[0][0], /signature not added/);
    assert.equal(log.warnings[0][1], error);
  });
});
