// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
/**
 * ESLint flat config (eslint v9+).
 *
 * Three file groups with different runtime expectations:
 *
 *   1. extension/  -- runs inside Thunderbird's chrome / WebExtension /
 *      experiment-API sandboxes. Has XPCOM globals (Cc, Ci, Services,
 *      ChromeUtils, MailServices, dump). WebExtension page scripts
 *      (background.js, options.js) get the `browser` and `messenger`
 *      globals from the WebExtensions framework.
 *
 *      Imports go via ChromeUtils.importESModule("resource://...") --
 *      not standard ES `import`. ESLint can see static `import` but
 *      not the resource:// edges. That's fine for the rules we
 *      enable: no-undef catches typos / orphan refs, no-unused-vars
 *      flags dead destructures, the promise/* rules catch missing
 *      .catch() on Promise chains. Boundary enforcement happens via
 *      dependency-cruiser (see .dependency-cruiser.cjs).
 *
 *   2. scripts/, test/, mcp-bridge.cjs -- standard Node code. eslint-
 *      plugin-n covers Node-specific patterns.
 *
 *   3. .mjs files under scripts/ are ESM, sourceType:module override.
 *
 * Strict for bugs, silent on style: every rule is an error and CI runs
 * `eslint . --max-warnings 0`, so no warning can pile up. On top of
 * js/recommended, plugin-promise's and plugin-n's recommended sets, the
 * BUG_RULES below catch real defects (loose equality, shadowing, missing
 * radix, promise executors that return, ...). Stylistic formatting is
 * intentionally NOT enforced (prettier-style).
 *
 * Left off on purpose, each because it flags correct code here:
 *   - no-await-in-loop: sequential awaits are deliberate (one IMAP folder,
 *     one Thunderbird operation at a time).
 *   - no-implicit-coercion: `!!x` and `+x` are idiomatic and clear.
 *   - consistent-return: handlers return a value on some paths by design.
 *   - require-atomic-updates: false positives on start-once guards.
 *   - no-template-curly-in-string / no-script-url: the tests and the
 *     HTML sanitiser handle these strings as data on purpose.
 *   - n/hashbang: the build scripts are also run directly.
 *
 * Notably useful in this codebase:
 *   - no-undef:    catches free references in api.js's nested closures
 *                  (anything from the old monolithic structure where a
 *                  helper was defined in one IIFE and called from a
 *                  sibling IIFE that doesn't close over it).
 *   - promise/catch-or-return: catches .then() chains without .catch().
 *                  In the experiment-API surface this is the difference
 *                  between a clear { error } response and a 60s
 *                  tools/call timeout that hangs the client.
 */

import js from "@eslint/js";
import nodePlugin from "eslint-plugin-n";
import promisePlugin from "eslint-plugin-promise";
import globals from "globals";

// Bug-catching rules on top of the recommended sets (see the header).
const BUG_RULES = {
  eqeqeq: ["error", "smart"],
  "no-var": "error",
  "prefer-const": ["error", { destructuring: "all", ignoreReadBeforeAssign: true }],
  "no-eval": "error",
  "no-new-func": "error",
  "no-implied-eval": "error",
  "no-throw-literal": "error",
  "prefer-promise-reject-errors": "error",
  "no-self-compare": "error",
  "no-unmodified-loop-condition": "error",
  "no-unreachable-loop": "error",
  "no-promise-executor-return": "error",
  "array-callback-return": "error",
  "no-unused-expressions": "error",
  "no-useless-return": "error",
  "no-useless-concat": "error",
  "no-useless-rename": "error",
  "no-useless-computed-key": "error",
  "no-lone-blocks": "error",
  "no-new-wrappers": "error",
  "no-proto": "error",
  "no-extend-native": "error",
  "no-caller": "error",
  "no-sequences": "error",
  "no-return-assign": "error",
  "no-shadow": "error",
  "default-case-last": "error",
  "no-constructor-return": "error",
  "no-new": "error",
  radix: "error",
  // A nested executor gets a distinct name (resolveImage, ...) so that it does not shadow the outer resolve.
  "promise/param-names": ["error", { resolvePattern: "^_?resolve\\w*$", rejectPattern: "^_?reject\\w*$" }],
};

export default [
  // ── Global ignores ────────────────────────────────────────────────
  {
    ignores: [
      "node_modules/",
      "dist/",
      "extension/buildinfo.json",
      "extension/httpd.sys.mjs",  // vendored Mozilla httpd, not ours
      "plugins/claude-code/mcp-bridge.cjs",  // byte-for-byte copy of mcp-bridge.cjs (scripts/check-versions.cjs)
      ".claude/",
      ".cache/",                // bench Thunderbird + profile (scripts/tb-bench.sh)
      "test/bench/user.js",     // prefs file, not JS
      "test/bench/ready.js",    // Marionette script body (top-level return)
    ],
  },

  // ── Base JS recommendations apply to everything ──────────────────
  js.configs.recommended,
  promisePlugin.configs["flat/recommended"],
  { rules: BUG_RULES },

  // ── Extension chrome-context code ────────────────────────────────
  {
    files: ["extension/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // ── XPCOM / chrome ──
        Components: "readonly",
        ChromeUtils: "readonly",
        Services: "readonly",
        Cc: "readonly", Ci: "readonly", Cr: "readonly", Cu: "readonly",
        MailServices: "readonly",
        dump: "readonly",
        // ── WebExtension globals ──
        browser: "readonly",
        messenger: "readonly",
        ExtensionAPI: "readonly",
        ExtensionCommon: "readonly",
        // ── Standard browser-ish (background.js + options.js) ──
        ...globals.browser,
      },
    },
    plugins: {
      promise: promisePlugin,
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^(_|e$|err$|ex$)",
      }],
      "no-redeclare": "error",
      "no-implicit-globals": "off",  // chrome module loader has its own scope
      "no-prototype-builtins": "error",

      // Promise hygiene -- the bug class that hides 30s tools/call hangs.
      "promise/catch-or-return": ["error", { allowFinally: true }],
      "promise/no-nesting": "error",
      // always-return is too strict for chrome XPCOM fire-and-forget patterns.
      "promise/always-return": "off",

      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",  // we filter JSON-RPC control chars intentionally
    },
  },

  // ── Node-side scripts and tests ──────────────────────────────────
  {
    files: ["scripts/**/*.{cjs,mjs,js}", "test/**/*.{cjs,mjs,js}", "mcp-bridge.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    plugins: {
      n: nodePlugin,
    },
    rules: {
      ...nodePlugin.configs["flat/recommended-script"].rules,
      "n/hashbang": "off",                 // build scripts are also run directly
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^(_|e$|err$|ex$)",
      }],
      "n/no-unsupported-features/node-builtins": "off",
      "n/no-process-exit": "off",          // mcp-bridge.cjs uses it intentionally
      "n/no-missing-require": "off",        // native deps confuse the resolver
      "n/no-extraneous-require": "off",
      "promise/catch-or-return": ["error", { allowFinally: true }],
      "promise/always-return": "off",
      "promise/no-nesting": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // ── Scripts that are real ESM (rare, but supported) ──────────────
  {
    files: ["scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: { sourceType: "module" },
  },

];
