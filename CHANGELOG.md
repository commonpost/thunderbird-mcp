# Changelog

All notable changes are listed here, newest first. This project is a continuation of
[thunderbird-mcp](https://github.com/TKasperczyk/thunderbird-mcp) by Tomasz Kasperczyk (MIT); the history of that
project is kept in this repository.

## [0.8.0] - Unreleased

First release of **Commonpost MCP for Thunderbird**, a continuation of thunderbird-mcp 0.7.5.

### Changed
- New identity so that it can be installed **beside** the original add-on in the same profile: add-on id
  `commonpost-mcp@commonpost.github.io`, preferences `extensions.commonpost-mcp.*`, temporary directory
  `commonpost-mcp/`, environment variables `COMMONPOST_MCP_*` (no fallback on the old names), Experiment namespace
  `commonpostMcp`, default port range 8780-8789 (the original uses 8765-8774), MCP server name `commonpost-mcp`.
  See "Migrating from thunderbird-mcp" in the README.
- Automatic updates come from `https://commonpost.github.io/thunderbird-mcp/updates.json`.
- Requires Thunderbird 128 or later (developed and tested on Thunderbird 156).

### Added
- The options page warns when the original thunderbird-mcp add-on is also active.
- Reproducible XPI build (`scripts/build-xpi-reproducible.cjs`); the release carries a build provenance
  attestation (`*.sigstore.json`); LICENSE and THIRD-PARTY.md are inside the XPI.
- Filter rules that forward or reply can no longer be created or changed through MCP while the new
  **Block filter forward/reply** setting is on (default: on). Idea and preference name from
  TKasperczyk/thunderbird-mcp#127 by JordanRO2.
- Property-based tests (fast-check); CI with pinned actions, CodeQL, zizmor and OpenSSF Scorecard; lockfile.

### Fixed
- Windows: the server no longer fails to start because of a POSIX permission check on the temporary directory
  (TKasperczyk/thunderbird-mcp#209 by Tony).
- A failed server start is now visible in the options page and can be retried without restarting Thunderbird (TKasperczyk/thunderbird-mcp#179).
- Large inline attachments (Base64) no longer overflow the regular-expression stack; the size limit is checked
  first (TKasperczyk/thunderbird-mcp#214 by safrano9999).
- Filters: search attributes, operators and actions are resolved by name instead of hand-numbered tables,
  values are typed, and updating a filter copies what it does not change faithfully (TKasperczyk/thunderbird-mcp#195 by Daniel
  Glaser and ideas from TKasperczyk/thunderbird-mcp#175 by Neel Radhakrishnan).
- Removed a source of ESLint errors in the filter code (rethrown errors keep their `cause`).

### Removed
- The pre-built `dist/thunderbird-mcp.xpi` is no longer tracked in git; releases carry the XPI.
