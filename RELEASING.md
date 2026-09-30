# Releasing

How a version of Commonpost MCP for Thunderbird is released. Only maintainers who can approve the `release`
environment can publish.

## 1. Prepare

- Every change reaches `main` through a pull request. The `protect-main` ruleset requires the checks to pass:
  tests (Node 22 and 24), Lint, Version sync, zizmor and CodeQL.
- Open a release pull request that:
  - sets the new version in `package.json`, `package-lock.json` (two places) and `extension/manifest.json`
    (the Version sync check refuses any disagreement);
  - turns the `Unreleased` section of `CHANGELOG.md` into `## [x.y.z] - YYYY-MM-DD`, crediting contributors and
    the upstream pull requests that were adapted.
- Before merging, build twice from a clean checkout with `node scripts/build-xpi-reproducible.cjs`: both XPI files
  must have the same SHA-256.

## 2. Tag

- Tag the merged commit on `main`, and push that tag only:
  `git tag vX.Y.Z <commit>` then `git push origin refs/tags/vX.Y.Z`.
- `v*` tags are protected (no deletion, no update) and releases are immutable: a mistake is fixed by a new
  version, never by moving a tag.

## 3. What the Build and Release workflow does

1. Checks that the tag is on `main` and that the tag, `package.json` and the manifest agree.
2. Builds the XPI reproducibly and runs the tests.
3. Waits for a maintainer to approve the `release` environment.
4. Rebuilds from the tag and refuses any difference with the first build.
5. Attests the build provenance of the XPI and of `mcp-bridge.cjs` (Sigstore bundles).
6. Creates the release with the XPI, the bridge and both `.sigstore.json` bundles.
7. Publishes `updates.json` on `gh-pages` with the new version and its `update_hash`, so installed copies update.

## 4. Verify

- `gh attestation verify <xpi> -R commonpost/thunderbird-mcp --format json` (and the same for `mcp-bridge.cjs`).
  Use `--format json`: some `gh` versions print nothing in text mode, even on success.
- The SHA-256 of the released XPI equals your local reproducible build of the tagged commit.
  A rebase merge rewrites the commit date, which is part of the reproducible build (`SOURCE_DATE_EPOCH` is the committer date of `HEAD`, and the commit hash is recorded too), so the hash built from the pull request branch before merging cannot match the release; compare with a rebuild from a checkout of the tag.
- <https://commonpost.github.io/thunderbird-mcp/updates.json> lists the new version with the same hash.

## Security releases

Fixes for problems reported under [SECURITY.md](SECURITY.md) are prepared and reviewed privately, and released on the
date agreed through coordinated disclosure. Until the advisory is published, release notes describe them in general
terms.

## Dependabot pull requests

The CodeQL setup enforced by the organization does not analyze a pull request whose latest commit was made by
`dependabot[bot]`, so a required check never appears. Push an empty commit to the branch
(`git commit --allow-empty -m "ci: run the required checks"`) to start it.
