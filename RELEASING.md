# Releasing

How a version of Commonpost MCP for Thunderbird is released. Only maintainers who can approve the `release`
environment can publish.

## 1. Prepare

- Every change reaches `main` through a pull request. The `protect-main` ruleset requires the checks to pass:
  tests (Node 22 and 24), Lint, Version sync, zizmor and CodeQL.
- Open a release pull request that:
  - sets the new version in `package.json`, `package-lock.json` (two places) and `extension/manifest.json`;
  - runs `node scripts/check-versions.cjs`: it says whether the bridge bundle (`mcp-bridge.cjs`, the other files of the
    `.mcpb` and the scripts that build it) changed since the previous release tag. Changed: set `BRIDGE_VERSION` in
    `mcp-bridge.cjs` and the version of `mcpb/manifest.json` to the new version. Unchanged: leave both (the release
    ships the same bridge and `.mcpb` again, byte for byte);
  - reviews the compatibility thresholds (below) and copies their checklist, ticked, into the pull request description;
  - turns the `Unreleased` section of `CHANGELOG.md` into `## [x.y.z] - YYYY-MM-DD`, crediting contributors and
    the upstream pull requests that were adapted.
- Before merging, build twice from a clean checkout with `node scripts/build-xpi-reproducible.cjs` and
  `node scripts/build-mcpb-reproducible.cjs`: both XPI files, and both `.mcpb` files, must have the same SHA-256.

## 2. Tag

- Tag the merged commit on `main`, and push that tag only:
  `git tag vX.Y.Z <commit>` then `git push origin refs/tags/vX.Y.Z`.
- `v*` tags are protected (no deletion, no update) and releases are immutable: a mistake is fixed by a new
  version, never by moving a tag.

## 3. What the Build and Release workflow does

1. Checks that the tag is on `main` and runs `scripts/check-versions.cjs --release-tag` (tag =
   `package.json` = add-on manifest; `BRIDGE_VERSION` = `.mcpb` manifest, the new version only if the bridge bundle
   changed since the previous tag; thresholds; an armed floor announced in the CHANGELOG).
2. Builds the XPI and the `.mcpb` (Claude Desktop bundle) reproducibly and runs the tests.
3. Waits for a maintainer to approve the `release` environment.
4. Rebuilds both from the tag and refuses any difference with the first build.
5. Attests the build provenance of the XPI, the `.mcpb` and `mcp-bridge.cjs` (Sigstore bundles).
6. Creates the release with the XPI, the `.mcpb`, the bridge and the three `.sigstore.json` bundles.
7. Publishes `updates.json` on `gh-pages` with the new version and its `update_hash`, so installed copies update.

## 4. Verify

- `gh attestation verify <xpi> -R commonpost/thunderbird-mcp --format json` (and the same for the `.mcpb` and for
  `mcp-bridge.cjs`).
  Use `--format json`: some `gh` versions print nothing in text mode, even on success.
- The SHA-256 of the released XPI equals your local reproducible build of the tagged commit. The `.mcpb` has no date or
  commit inside, so it equals a rebuild of the same sources whatever the merge method.
  A rebase merge rewrites the commit date, which is part of the reproducible build (`SOURCE_DATE_EPOCH` is the committer date of `HEAD`, and the commit hash is recorded too), so the hash built from the pull request branch before merging cannot match the release; compare with a rebuild from a checkout of the tag.
- In a release that does not change the bridge, `mcp-bridge.cjs` and
  `commonpost-mcp-v<bridge version>.mcpb` are byte for byte those of the previous release; each release attests them
  again.
- <https://commonpost.github.io/thunderbird-mcp/updates.json> lists the new version with the same hash.

## Compatibility thresholds

The bridge and the add-on are installed separately and only the add-on updates itself. Each side warns only about an
older other side, with its own threshold; `scripts/check-versions.cjs` keeps every threshold at or below
`BRIDGE_VERSION` in a release, so they never warn about the same pair. Review them in each release pull request:

- [ ] `MIN_EXTENSION_VERSION` (`mcp-bridge.cjs`): the oldest add-on that acts on everything this bridge sends (header
  fields, `_meta`, new arguments). It can change only in a release that changes the bridge; when the bridge starts
  sending something an add-on must act on, raise it to that release.
- [ ] `MIN_BRIDGE_VERSION` (`extension/mcp_server/api.js`): the oldest bridge whose `isDirectSendCall` / `isDraftCall`
  classify every tool and mode of this add-on that sends or saves without a window, and that has no fixed flaw users
  should not keep. Raising it adds a notice; it refuses nothing.
- [ ] `MODE_MIN_BRIDGE_VERSION`: the oldest bridge that waits long enough for `mode: "send"` and `"draft"`; older
  bridges get those calls refused before anything is done.
- [ ] `BRIDGE_SECURITY_FLOOR` stays `0.0.0` unless a flaw in a protection that only the bridge has (connection file
  discovery and checks, the token sent to 127.0.0.1 only, attachment path checks, the waits of direct sends, the
  instructions it answers to `initialize`) is exploitable in practice and cannot be neutralized in the add-on (prefer
  refusing the one affected call, as for `mode: "send"`). Its value is the `BRIDGE_VERSION` of the fixed bridge, released
  in the same release or before. Price: an armed floor refuses every tool call from bridges 0.11.0 or older and from
  any client without the `X-Commonpost-Bridge` header. The version check refuses an armed floor that the CHANGELOG
  section of the release does not announce ("security floor" and its version); publish an advisory too.

Between releases, a bridge on `main` keeps the number of the last released bridge even when its code changed, and the
thresholds may already name the coming version (they are compared with `BRIDGE_VERSION` only once it is final): the
version of a bridge built from `main` is only meaningful at a tag.

## Security releases

Fixes for problems reported under [SECURITY.md](SECURITY.md) are prepared and reviewed privately, and released on the
date agreed through coordinated disclosure. Until the advisory is published, release notes describe them in general
terms.

## Dependabot pull requests

The CodeQL setup enforced by the organization does not analyze a pull request whose latest commit was made by
`dependabot[bot]`, so a required check never appears. Push an empty commit to the branch
(`git commit --allow-empty -m "ci: run the required checks"`) to start it.
