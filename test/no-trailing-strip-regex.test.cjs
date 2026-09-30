"use strict";

// Fails on a regular expression literal with an alternative that ends in a quantified atom followed by `$`
// and has no `^` bounding its start (/x+$/, /[. ]+$/, /\s*$/, the second half of /^<+|>+$/g). Such a
// pattern backtracks quadratically on a long run of the repeated character followed by another character
// (CodeQL js/polynomial-redos). Use stripTrailing / stripLeading (linear, a loop from the end) instead.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

// Files to scan: the bridge and every .js/.cjs/.mjs file under extension/, except third-party libraries.
// extension/httpd.sys.mjs is Mozilla's httpd.js taken over from mozilla-central (MPL-2.0, see
// THIRD-PARTY.md), not our code: excluded.
const THIRD_PARTY = new Set(["extension/httpd.sys.mjs"]);

// Exceptions: "file:line" entries, EMPTY on purpose. Add one only for a pattern proven linear (say why, in a
// comment next to the entry); otherwise rewrite the code with stripTrailing / stripLeading.
const EXCEPTIONS = new Set([]);

function listFiles() {
  const out = ["mcp-bridge.cjs"];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(?:js|cjs|mjs)$/.test(entry.name) && !THIRD_PARTY.has(rel)) out.push(rel);
    }
  };
  walk("extension");
  return out.sort();
}

const REGEX_PRECEDING_WORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

// Returns [{ index, body }] for every regular expression literal in `src`.
function findRegexLiterals(src) {
  const found = [];
  const braces = []; // template literal nesting: brace depth at each "${"
  let depth = 0;
  let prev = ""; // last significant token: "" | "word:<w>" | "num" | punctuation char
  let i = 0;
  const n = src.length;
  const skipTemplate = () => {
    // i is just after a backtick or after the "}" that closes a "${"
    while (i < n) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; return; }
      if (c === "$" && src[i + 1] === "{") { i += 2; braces.push(depth); depth++; return; }
      i++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i++; prev = "str"; continue;
    }
    if (c === "`") { i++; skipTemplate(); prev = "str"; continue; }
    if (c === "{") { depth++; i++; prev = "{"; continue; }
    if (c === "}") {
      depth--; i++;
      if (braces.length && braces[braces.length - 1] === depth) { braces.pop(); skipTemplate(); prev = "str"; }
      else prev = "}";
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-￿]/.test(src[j])) j++;
      prev = `word:${src.slice(i, j)}`; i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      prev = "num"; i = j; continue;
    }
    if (c === "/") {
      const isRegex = prev === "" || (prev.startsWith("word:") ? REGEX_PRECEDING_WORDS.has(prev.slice(5))
        : !(prev === "num" || prev === "str" || prev === ")" || prev === "]" || prev === "re"));
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) break;
          j++;
        }
        found.push({ index: i, body: src.slice(i + 1, j) });
        j++;
        while (j < n && /[a-z]/.test(src[j])) j++;
        i = j; prev = "re"; continue;
      }
    }
    prev = c; i++;
  }
  return found;
}

// True when some alternative of the pattern ends in a quantified atom (+, *, {n,}) then `$`, with no `^`
// outside a character class in that alternative or in an enclosing one.
function hasUnanchoredTrailingQuantifier(body) {
  const stack = [{ caret: false }];
  let quantified = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const top = stack[stack.length - 1];
    if (c === "\\") { i++; quantified = false; continue; }
    if (c === "[") {
      i++;
      if (body[i] === "^") i++;
      while (i < body.length && body[i] !== "]") i += body[i] === "\\" ? 2 : 1;
      quantified = false;
      continue;
    }
    if (c === "(") { stack.push({ caret: false }); quantified = false; continue; }
    if (c === ")") { if (stack.length > 1) stack.pop(); quantified = false; continue; }
    if (c === "|") { top.caret = false; quantified = false; continue; }
    if (c === "^") { top.caret = true; quantified = false; continue; }
    if (c === "+" || c === "*") { quantified = true; continue; }
    if (c === "?") continue; // lazy marker after a quantifier, or an optional atom / group prefix
    if (c === "{") {
      const m = /^\{\d+,\}/.exec(body.slice(i));
      if (m) { quantified = true; i += m[0].length - 1; continue; }
      quantified = false;
      continue;
    }
    if (c === "$") {
      const next = body[i + 1];
      const endsAlternative = next === undefined || next === "|" || next === ")";
      if (quantified && endsAlternative && !stack.some((f) => f.caret)) return true;
      quantified = false;
      continue;
    }
    quantified = false;
  }
  return false;
}

function scan(src) {
  return findRegexLiterals(src)
    .filter(({ body }) => hasUnanchoredTrailingQuantifier(body))
    .map(({ index, body }) => ({ line: src.slice(0, index).split("\n").length, body }));
}

describe("no regular expression that strips a trailing run", () => {
  it("finds the patterns it is meant to find", () => {
    const bad = ["/x+$/", "/[. ]+$/", "/\\s*$/", "/^<+|>+$/g", "/[\\\\/]+$/", "/(?:a|b+$)/", "/a{2,}$/", "/x+?$/"];
    for (const re of bad) assert.equal(scan(`const a = s.replace(${re}, "");`).length, 1, re);
  });

  it("leaves anchored and non-quantified patterns alone", () => {
    const good = ["/^\\d+$/", "/^[a-z]+$/", "/^<+/", "/x$/", "/[+$]/", "/a+\\$/", "/^(?:a|b)+$/", "/x+$y/", "/\\d{1,3}$/"];
    for (const re of good) assert.equal(scan(`const a = ${re}.test(s);`).length, 0, re);
    assert.equal(scan("const a = `${b}/${c}+$/`; const d = e / f / g;").length, 0);
  });

  const files = listFiles();
  it("scans the expected files", () => {
    assert.ok(files.includes("mcp-bridge.cjs"));
    assert.ok(files.includes("extension/mcp_server/api.js"));
    assert.ok(!files.includes("extension/httpd.sys.mjs"));
  });

  for (const file of files) {
    it(file, () => {
      const src = fs.readFileSync(path.join(root, file), "utf8");
      const hits = scan(src).filter((h) => !EXCEPTIONS.has(`${file}:${h.line}`));
      assert.deepEqual(
        hits.map((h) => `${file}:${h.line}: /${h.body}/ backtracks quadratically (js/polynomial-redos); ` +
          "use stripTrailing(s, chars) / stripLeading(s, chars) instead"),
        [],
      );
    });
  }
});
