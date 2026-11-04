// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The deny-list of attachment file paths: which component of a path makes it sensitive, why the caller is told so,
// the Windows spellings that name another file, UNC paths, the home Library folder and the protected directories.

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

// services: what Services answers (absent: the unit-test sandbox without Services)
function load(services) {
  const sandbox = services ? { Services: services, Ci: { nsIFile: {} } } : {};
  vm.createContext(sandbox);
  vm.runInContext(`${region("SENSITIVE ATTACHMENT PATH HELPERS")}
Object.assign(this, { isExemptCommonpostMcpDir, sensitivePathComponentReason, hasSensitivePathComponent,
  sensitiveAttachmentNote, isSensitiveFilePath, matchesSensitivePattern, isHomeLibraryPath, isWindowsHost,
  windowsPathAmbiguity, knownWindowsTempDir, isUncOrDevicePath, protectedDirKey, normalizeProtectedDir,
  isInsideProtectedDirs });`, sandbox);
  return sandbox;
}

function servicesOf({ os = "Linux", home = "/home/me", tmp = "/tmp" } = {}) {
  return {
    appinfo: { OS: os },
    dirsvc: {
      get(key) {
        const value = key === "Home" ? home : tmp;
        if (value instanceof Error) throw value;
        return { path: value };
      },
    },
  };
}

const bare = load();

describe("isExemptCommonpostMcpDir", () => {
  it("exempts commonpost-mcp only directly under temp or tmp, with no .. anywhere", () => {
    assert.equal(bare.isExemptCommonpostMcpDir(["c:", "users", "u", "appdata", "local", "temp", "commonpost-mcp", "x"]), true);
    assert.equal(bare.isExemptCommonpostMcpDir(["tmp", "commonpost-mcp"]), true);
    assert.equal(bare.isExemptCommonpostMcpDir(["temp", "commonpost-mcp", "..", "x"]), false);
    assert.equal(bare.isExemptCommonpostMcpDir(["appdata", "roaming", "commonpost-mcp"]), false);
    assert.equal(bare.isExemptCommonpostMcpDir(["commonpost-mcp", "x"]), false);
    assert.equal(bare.isExemptCommonpostMcpDir(["temporary", "commonpost-mcp"]), false);
    assert.equal(bare.isExemptCommonpostMcpDir(["x", "y"]), false);
  });
});

describe("sensitivePathComponentReason and hasSensitivePathComponent", () => {
  const reasons = [
    ["", null],
    ["/", null],
    ["/home/u/.ssh/id_rsa", "dotfile"],
    ["/home/u/.config/appdata/x", "dotfile"],
    ["/home/u/project/.env", "dotfile"],
    ["/home/u/./x/../y.txt", null],
    ["/home/u/a.b/c.d.txt", null],
    ["c:/users/u/appdata/local/x.txt", "appdata"],
    ["c:/users/u/application data/x.txt", "appdata"],
    ["c:/users/u/local settings/x.txt", "appdata"],
    ["c:/users/u/appdata/.ssh/x", "appdata"],
    ["c:/users/u/appdata/local/temp/commonpost-mcp/id/file.txt", null],
    ["c:/users/u/appdata/local/tmp/commonpost-mcp/id/file.txt", null],
    ["c:/users/u/appdata/roaming/x/commonpost-mcp/file.txt", "appdata"],
    ["c:/users/u/appdata/local/temp/commonpost-mcp/../../file.txt", "appdata"],
    ["c:/users/u/appdata/local/temp/commonpost-mcp/id/.hidden", "dotfile"],
    ["c:/users/u/appdata/local/temp/commonpost-mcp/id/credentials.json", "filename"],
    ["/srv/credentials", "filename"],
    ["/srv/credentials.json", "filename"],
    ["/srv/credentials.toml", "filename"],
    ["/srv/credentials.yaml", null],
    ["/srv/credentials/readme.txt", null],
    ["/srv/terraform.tfstate.backup", "filename"],
    ["/srv/key.ppk", "filename"],
    ["/srv/store.jks", "filename"],
    ["/srv/app.keystore", "filename"],
    ["/srv/vpn.ovpn", "filename"],
    ["/srv/login.keychain-db", "filename"],
    ["/srv/wallet.dat", "filename"],
    ["/srv/local state", "filename"],
    ["/srv/web data", "filename"],
    ["/srv/places.sqlite", "filename"],
    ["/srv/formhistory.sqlite", "filename"],
    ["/srv/consolehost_history.txt", "filename"],
    ["/srv/ntuser.dat", "filename"],
    ["/srv/auth.json", "filename"],
    ["/srv/auth.json.txt", null],
  ];

  it("gives the first reason a path has: a dotfile or an AppData directory on the way, else the file name", () => {
    for (const [normalized, reason] of reasons) {
      assert.equal(bare.sensitivePathComponentReason(normalized), reason, normalized);
    }
  });

  it("agrees with the plain yes or no", () => {
    for (const [normalized, reason] of reasons) {
      assert.equal(bare.hasSensitivePathComponent(normalized), reason !== null, normalized);
    }
  });
});

describe("sensitiveAttachmentNote", () => {
  it("explains the AppData rule, with its %TEMP% consequence, in any spelling of the path", () => {
    for (const p of ["C:\\Users\\Me\\AppData\\Local\\Temp\\report.pdf", "c:/users/me/appdata/local/temp/report.pdf", "C:\\Users\\Me\\Application Data\\x.txt"]) {
      assert.match(bare.sensitiveAttachmentNote(p), /files under AppData \(on Windows this includes %TEMP%\) can't be attached; copy the file to another folder/, p);
    }
  });

  it("gives the generic note for anything else", () => {
    for (const p of ["/home/me/.ssh/id_rsa", "/etc/passwd", "C:\\Users\\Me\\Documents\\credentials.json", "report.pdf"]) {
      assert.equal(bare.sensitiveAttachmentNote(p), "sensitive path blocked", p);
    }
  });
});

describe("isSensitiveFilePath", () => {
  it("is false for something that is not a path", () => {
    for (const value of [undefined, null, "", 42, {}, ["/etc/passwd"]]) assert.equal(bare.isSensitiveFilePath(value), false, String(value));
  });

  it("refuses UNC and device paths whatever the host", () => {
    for (const p of ["\\\\server\\share\\a.txt", "//server/share/a.txt", "\\\\?\\C:\\a.txt", "\\\\.\\PhysicalDrive0", "\\??\\C:\\a.txt", "/??/C:/a.txt"]) {
      assert.equal(bare.isSensitiveFilePath(p, false), true, p);
    }
  });

  it("refuses the credentials, system folders and profiles of both families of systems, in any case and slash", () => {
    const refused = [
      "/home/u/.ssh/id_rsa", "/home/u/.aws/credentials", "/home/u/.gnupg/pubring.kbx", "/home/u/.kube/config",
      "/home/u/.config/gcloud/credentials.db", "/home/u/.docker/config.json", "/home/u/.netrc", "/srv/keys/server.pem",
      "/srv/keys/archive.kdbx", "/srv/keys/mail.asc", "/srv/keys/mail.gpg", "/etc/shadow", "/proc/self/environ",
      "/root/anything.txt", "/var/log/auth.log", "/Users/me/Library/Keychains/login.keychain-db",
      "/Users/me/Library/Mail/V10/x.emlx", "/System/Volumes/Data/Users/me/Library/Messages/chat.db",
      "/private/etc/hosts", "/home/me/.thunderbird/abc.default/prefs.js", "/home/me/.icedove/abc/prefs.js",
      "/Users/me/Library/Thunderbird/Profiles/a/prefs.js", "C:\\Windows\\System32\\config\\SAM", "D:\\ProgramData\\Microsoft\\Crypto\\x",
      "C:\\Users\\Me\\AppData\\Roaming\\Thunderbird\\Profiles\\a\\prefs.js",
      "C:\\Users\\Me\\AppData\\Local\\Microsoft\\Credentials\\x", "C:\\Users\\Me\\Application Data\\Thunderbird\\profiles.ini",
      "C:\\Users\\Me\\Local Settings\\Microsoft\\Vault\\x", "C:\\Documents and Settings\\All Users\\Application Data\\Microsoft\\Crypto\\x",
      "C:\\ProgramData\\Application Data\\Microsoft\\Protect\\x", "C:\\Users\\Me\\Cookies\\x.txt",
      "C:\\Users\\Me\\Start Menu\\x.lnk", "/home/me/.mozilla/firefox/a/logins.json", "/home/me/.mozilla/firefox/a/key4.db",
      "/home/me/.mozilla/firefox/a/cookies.sqlite", "/home/me/Default/Login Data", "/tmp/commonpost-mcp/connection.json",
      "/home/me/.local/share/commonpost-mcp/connection.json", "/home/me/thunderbird-mcp/connection.json",
    ];
    for (const p of refused) assert.equal(bare.isSensitiveFilePath(p, false), true, p);
    assert.equal(bare.isSensitiveFilePath("/ETC/Hosts", false), true);
  });

  it("lets an ordinary file through, a saved attachment in the extension's temporary folder included", () => {
    for (const p of ["/home/me/Documents/report.pdf", "/tmp/commonpost-mcp/abc/report.pdf", "/srv/export/data.csv", "C:\\Users\\Me\\Documents\\a.docx", "relative/report.pdf"]) {
      assert.equal(bare.isSensitiveFilePath(p, false), false, p);
    }
  });

  it("applies the Windows spellings only on a Windows host", () => {
    const path8dot3 = "C:\\Users\\ALICE~1\\Documents\\a.txt";
    assert.equal(bare.isSensitiveFilePath(path8dot3, false), false);
    assert.equal(bare.isSensitiveFilePath(path8dot3, true), true);
    const windows = load(servicesOf({ os: "WINNT", tmp: "C:\\Users\\ALICE~1\\AppData\\Local\\Temp" }));
    assert.equal(windows.isSensitiveFilePath(path8dot3), true);
    assert.equal(windows.isSensitiveFilePath("C:\\Users\\Me\\Documents\\a.txt"), false);
    const linux = load(servicesOf());
    assert.equal(linux.isSensitiveFilePath(path8dot3), false);
  });

  it("refuses the home Library folder wherever the home directory is", () => {
    const mac = load(servicesOf({ home: "/volumes/data/me" }));
    assert.equal(mac.isSensitiveFilePath("/Volumes/Data/Me/Library/Mail/x.emlx", false), true);
    assert.equal(mac.isSensitiveFilePath("/Volumes/Data/Me/Library", false), true);
    assert.equal(mac.isSensitiveFilePath("/Volumes/Data/Me/Libraryx/a.txt", false), false);
    assert.equal(mac.isSensitiveFilePath("/Volumes/Data/Me/Documents/a.txt", false), false);
  });
});

describe("isHomeLibraryPath", () => {
  it("compares with the home directory in any spelling of it", () => {
    for (const home of ["/home/me/", "/HOME/me", "\\home\\me\\", "/home/me//"]) {
      const helper = load(servicesOf({ home }));
      assert.equal(helper.isHomeLibraryPath("/home/me/library/x"), true, home);
      assert.equal(helper.isHomeLibraryPath("/home/me/library"), true, home);
      assert.equal(helper.isHomeLibraryPath("/home/me/libraries"), false, home);
    }
  });

  it("is false when the home directory is unknown, empty or the root", () => {
    for (const home of [new Error("no home"), "", null, "/", "\\\\"]) {
      assert.equal(load(servicesOf({ home })).isHomeLibraryPath("/library/x"), false, String(home));
    }
    assert.equal(bare.isHomeLibraryPath("/home/me/library/x"), false);
  });
});

describe("isWindowsHost and knownWindowsTempDir", () => {
  it("reads the operating system from Services, and is false without it or when it fails", () => {
    assert.equal(bare.isWindowsHost(), false);
    assert.equal(load(servicesOf({ os: "WINNT" })).isWindowsHost(), true);
    assert.equal(load(servicesOf({ os: "Linux" })).isWindowsHost(), false);
    assert.equal(load({ get appinfo() { throw new Error("no appinfo"); } }).isWindowsHost(), false);
  });

  it("reads the temporary directory, or nothing", () => {
    assert.equal(bare.knownWindowsTempDir(), null);
    assert.equal(load(servicesOf({ tmp: "C:\\Temp" })).knownWindowsTempDir(), "C:\\Temp");
    assert.equal(load(servicesOf({ tmp: new Error("no tmp") })).knownWindowsTempDir(), null);
  });
});

describe("windowsPathAmbiguity", () => {
  const ambiguity = (p, temp = null) => bare.windowsPathAmbiguity(p, temp);

  it("is null for an ordinary path and for something that is not a path", () => {
    assert.equal(ambiguity("C:\\Users\\Alice\\Documents\\file.txt"), null);
    assert.equal(ambiguity("C:/Users/Alice/../Bob/./file.txt"), null);
    assert.equal(ambiguity(undefined), null);
    assert.equal(ambiguity(42), null);
  });

  it("names an alternate data stream", () => {
    assert.match(ambiguity("C:\\Users\\a\\logins.json::$DATA"), /alternate data stream/);
    assert.match(ambiguity("C:\\a\\b.kdbx:stream"), /alternate data stream/);
    assert.equal(ambiguity("C:\\a\\b.txt"), null);
  });

  it("names a reserved device name, with or without extension and trailing spaces", () => {
    for (const name of ["CON", "nul.txt", "Aux.tar.gz", "COM1", "lpt9.log", "com\u00b9", "CONIN$", "conout$", "PRN  .txt"]) {
      assert.match(ambiguity(`C:\\dir\\${name}`), /naming a Windows device/, name);
    }
    for (const name of ["console", "com0", "com10", "lpt", "nullable.txt", "con-1"]) assert.equal(ambiguity(`C:\\dir\\${name}`), null, name);
  });

  it("names a component that ends with a dot or a space", () => {
    assert.match(ambiguity("C:\\Users\\Thunderbird.\\a.txt"), /ending with a dot or a space/);
    assert.match(ambiguity("C:\\keys\\a.pem."), /ending with a dot or a space/);
    assert.match(ambiguity("C:\\keys\\dir \\a.txt"), /ending with a dot or a space/);
  });

  it("names an 8.3 short name", () => {
    for (const name of ["THUNDE~1", "APPDAT~1", "A~1", "PROGRA~2.EXE", "ab~12345.txt"]) {
      assert.match(ambiguity(`C:\\Users\\${name}\\a.txt`), /8\.3 short-name/, name);
    }
    for (const name of ["TOOLONG~1", "a.b~1", "no tilde", "x~y", "abc~1.long", "ab~123456.txt"]) assert.equal(ambiguity(`C:\\Users\\${name}\\a.txt`), null, name);
  });

  it("skips the 8.3 check for the components of the known temporary directory only", () => {
    const temp = "C:\\Users\\JEANTR~1\\AppData\\Local\\Temp";
    assert.equal(ambiguity("C:\\Users\\JEANTR~1\\AppData\\Local\\Temp\\commonpost-mcp\\a.txt", temp), null);
    assert.equal(ambiguity("c:/users/jeantr~1/appdata/local/temp/a.txt", temp), null);
    assert.match(ambiguity("C:\\Users\\JEANTR~1\\Documents\\a.txt", temp), /8\.3 short-name/);
    assert.match(ambiguity("C:\\Users\\JEANTR~1\\AppData\\Local\\Temp\\THUNDE~1\\a.txt", temp), /8\.3 short-name/);
    // Other checks still apply under it
    assert.match(ambiguity("C:\\Users\\JEANTR~1\\AppData\\Local\\Temp\\NUL", temp), /Windows device/);
    // A temporary directory longer than the path, or an empty one, skips nothing
    assert.match(ambiguity("C:\\Users\\JEANTR~1", temp), /8\.3 short-name/);
    assert.match(ambiguity("C:\\Users\\JEANTR~1\\a.txt", ""), /8\.3 short-name/);
    assert.match(ambiguity("C:\\Users\\JEANTR~1\\a.txt", 42), /8\.3 short-name/);
    assert.match(ambiguity("C:\\Users\\JEANTR~1\\a.txt", "C:\\"), /8\.3 short-name/);
  });
});

describe("isUncOrDevicePath", () => {
  it("recognizes the UNC and device namespaces in either slash direction", () => {
    for (const p of ["\\\\server\\share", "//server/share", "\\\\?\\C:\\x", "\\\\.\\COM1", "\\??\\C:\\x", "/??/C:/x"]) {
      assert.equal(bare.isUncOrDevicePath(p), true, p);
    }
    for (const p of ["/home/x", "C:\\x", "/?/x", "\\single", "relative", "", undefined, null, 42]) {
      assert.equal(bare.isUncOrDevicePath(p), false, String(p));
    }
  });
});

describe("protected directories", () => {
  it("writes every directory in one spelling", () => {
    assert.equal(bare.protectedDirKey("C:\\Users\\Me\\\\Profile//Dir"), "c:/users/me/profile/dir");
    assert.equal(bare.protectedDirKey("/System/Volumes/Data/Users/Me"), "/users/me");
    assert.equal(bare.protectedDirKey("/System/Volumes/Data"), "/system/volumes/data");
    assert.equal(bare.protectedDirKey("/System/Volumes/Database/x"), "/system/volumes/database/x");
    assert.equal(bare.protectedDirKey("/Users/Cafe\u0301"), bare.protectedDirKey("/Users/Caf\u00e9"));
  });

  it("ignores an entry that is not a directory, is empty or is only a root", () => {
    for (const dir of [undefined, null, 42, "", "/", "//", "\\", "C:", "C:\\", "c:/"]) {
      assert.equal(bare.normalizeProtectedDir(dir), "", String(dir));
    }
    assert.equal(bare.normalizeProtectedDir("D:\\Mail\\Profile\\"), "d:/mail/profile");
  });

  it("refuses the directory itself and what is under it, not a sibling that shares a prefix", () => {
    const dirs = ["/home/me/.thunderbird/prof", "C:\\Mail\\Store\\", "", null, "/", 7];
    for (const p of ["/home/me/.thunderbird/prof", "/HOME/me/.thunderbird/prof/ImapMail/x.msf", "c:\\mail\\store\\a\\b.mbox", "C:/Mail/Store"]) {
      assert.equal(bare.isInsideProtectedDirs(p, dirs), true, p);
    }
    for (const p of ["/home/me/.thunderbird/prof2/x", "/home/me/.thunderbird", "c:/mail/storeroom/x", "/etc/hosts"]) {
      assert.equal(bare.isInsideProtectedDirs(p, dirs), false, p);
    }
  });

  it("compares the macOS data-volume path and the normalized form of a name as the same", () => {
    assert.equal(bare.isInsideProtectedDirs("/System/Volumes/Data/Users/me/Mail/x", ["/Users/me/Mail"]), true);
    assert.equal(bare.isInsideProtectedDirs("/Users/me/Mail/x", ["/System/Volumes/Data/Users/me/Mail"]), true);
    assert.equal(bare.isInsideProtectedDirs("/Users/Cafe\u0301/x", ["/Users/Caf\u00e9"]), true);
  });

  it("is false without a path or without a list of directories", () => {
    assert.equal(bare.isInsideProtectedDirs("", ["/a"]), false);
    assert.equal(bare.isInsideProtectedDirs(undefined, ["/a"]), false);
    assert.equal(bare.isInsideProtectedDirs(42, ["/a"]), false);
    assert.equal(bare.isInsideProtectedDirs("/a/b", undefined), false);
    assert.equal(bare.isInsideProtectedDirs("/a/b", "/a"), false);
    assert.equal(bare.isInsideProtectedDirs("/a/b", []), false);
  });
});
