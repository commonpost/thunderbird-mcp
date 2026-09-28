#!/usr/bin/env bash
# Test bench: a throwaway headless Thunderbird with synthetic mail (test/fixtures/mail),
# driven through mcp-bridge.cjs and Marionette. Never touches the user's profile:
# HOME, TMPDIR (connection.json) and the profile live under .cache/tb-bench.
#
# Usage: scripts/tb-bench.sh [run|start|stop|status|setup] [node --test args]
#   run    start, run test/bench/*.test.cjs, stop (default)
#   start  start and leave running (state in .cache/tb-bench/state.json)
# Env: TB_VERSION (default 156.0.1, e.g. 140.16.0esr) or TB_CHANNEL=stable|beta|esr|esr-next, TB_BENCH_XPI (install an XPI
#      instead of linking extension/), TB_BENCH_MARIONETTE_PORT (default 2830).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/.cache"
BENCH="$CACHE/tb-bench"
STATE="$BENCH/state.json"
PORT="${TB_BENCH_MARIONETTE_PORT:-2830}"
ADDON_ID="$(node -p "require('$ROOT/extension/manifest.json').browser_specific_settings.gecko.id")"

log() { echo "[tb-bench] $*" >&2; }
die() { log "error: $*"; exit 1; }

validate_version() {
  [[ "$1" =~ ^[0-9]+(\.[0-9]+){0,2}(esr|b[0-9]+)?$ ]] || die "invalid Thunderbird version: $1"
}

# Mozilla release signing key, pinned by fingerprint.
MOZ_RELEASE_KEY_FPR="14F26682D0916CDD81E37B6D61B7B526D98F0353"
MOZ_RELEASE_SIGNING_SUBKEY_FPR="827E658608679618CD349F93678E455D76767AA3"

# Confirms the key imported into $1 (a GNUPGHOME) is Mozilla's release key: its primary
# fingerprint matches MOZ_RELEASE_KEY_FPR and one of its subkeys matches
# MOZ_RELEASE_SIGNING_SUBKEY_FPR. Refuses (die) on any mismatch.
check_release_key_pins() {
  local gnupghome="$1" listing primary_fpr
  listing="$(GNUPGHOME="$gnupghome" gpg --batch --with-colons --fingerprint --fingerprint --list-keys 2>/dev/null)"
  primary_fpr="$(awk -F: '
    $1=="pub"{ctx="pub"} $1=="sub"{ctx="sub"}
    $1=="fpr" && ctx=="pub" && p==""{p=$10}
    END{print p}
  ' <<<"$listing")"
  [ "$primary_fpr" = "$MOZ_RELEASE_KEY_FPR" ] \
    || die "Mozilla release key fingerprint mismatch: got '${primary_fpr:-none}', expected $MOZ_RELEASE_KEY_FPR"
  awk -F: -v want="$MOZ_RELEASE_SIGNING_SUBKEY_FPR" '
    $1=="pub"{ctx="pub"} $1=="sub"{ctx="sub"}
    $1=="fpr" && ctx=="sub" && $10==want{found=1}
    END{exit(found ? 0 : 1)}
  ' <<<"$listing" || die "Mozilla signing subkey $MOZ_RELEASE_SIGNING_SUBKEY_FPR not found on the imported release key"
}

# Verifies $1 (a downloaded archive) against the SHA512SUMS for $2 (its path within the
# release, e.g. linux-x86_64/en-US/thunderbird-<version>.tar.xz), fetched with $3 (the
# release's base URL) and authenticated with Mozilla's release key pinned by fingerprint.
# Returns non-zero if the archive's hash does not match; dies on any other failure.
verify_archive() {
  local archive="$1" rel_path="$2" base_url="$3"
  local vtmp="$CACHE/thunderbird/.verify"
  rm -rf "$vtmp" && mkdir -p "$vtmp"
  curl -fsSL -o "$vtmp/SHA512SUMS" "$base_url/SHA512SUMS" || die "failed to download SHA512SUMS"
  curl -fsSL -o "$vtmp/SHA512SUMS.asc" "$base_url/SHA512SUMS.asc" || die "failed to download SHA512SUMS.asc"
  curl -fsSL -o "$vtmp/KEY" "$base_url/KEY" || die "failed to download the release KEY"
  local gnupghome="$vtmp/gnupg"
  mkdir -m 700 -p "$gnupghome"
  GNUPGHOME="$gnupghome" gpg --batch --quiet --import "$vtmp/KEY" 2>/dev/null || die "failed to import the Mozilla release key"
  check_release_key_pins "$gnupghome"
  GNUPGHOME="$gnupghome" gpg --batch --quiet --verify "$vtmp/SHA512SUMS.asc" "$vtmp/SHA512SUMS" 2>/dev/null \
    || die "SHA512SUMS signature does not verify against the pinned Mozilla release key"
  local expected actual
  expected="$(awk -v p="$rel_path" '$2==p || $2=="./"p {print $1; exit}' "$vtmp/SHA512SUMS")"
  [ -n "$expected" ] || die "no SHA512SUMS entry for $rel_path"
  actual="$(sha512sum "$archive" | awk '{print $1}')"
  rm -rf "$vtmp"
  [ "$actual" = "$expected" ]
}

resolve_version() {
  if [ -n "${TB_VERSION:-}" ]; then echo "$TB_VERSION"; return; fi
  case "${TB_CHANNEL:-}" in
    "") echo "156.0.1" ;;
    stable) key="LATEST_THUNDERBIRD_VERSION" ;;&
    beta) key="LATEST_THUNDERBIRD_DEVEL_VERSION" ;;&
    esr) key="THUNDERBIRD_ESR" ;;&
    esr-next) key="THUNDERBIRD_ESR_NEXT" ;;&
    stable|beta|esr|esr-next)
      curl -fsSL https://product-details.mozilla.org/1.0/thunderbird_versions.json \
        | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)['$key']))" ;;
    *) die "unsupported TB_CHANNEL: $TB_CHANNEL" ;;
  esac
}

setup() {
  VERSION="$(resolve_version)"
  validate_version "$VERSION"
  TB_DIR="$CACHE/thunderbird/$VERSION"
  TB_BIN="$TB_DIR/thunderbird"
  [ -x "$TB_BIN" ] && return
  command -v gpg >/dev/null 2>&1 || die "gpg is required to verify the Thunderbird release signature"
  local rel_path="linux-x86_64/en-US/thunderbird-$VERSION.tar.xz"
  local base_url="https://archive.mozilla.org/pub/thunderbird/releases/$VERSION"
  local archive="$CACHE/thunderbird/thunderbird-$VERSION.tar.xz"
  mkdir -p "$CACHE/thunderbird"
  if [ -s "$archive" ] && ! verify_archive "$archive" "$rel_path" "$base_url"; then
    log "cached archive no longer matches SHA512SUMS, redownloading"
    rm -f "$archive"
  fi
  if [ ! -s "$archive" ]; then
    log "downloading Thunderbird $VERSION"
    curl -fL -o "$archive.part" "$base_url/$rel_path"
    mv "$archive.part" "$archive"
    verify_archive "$archive" "$rel_path" "$base_url" || die "downloaded archive does not match SHA512SUMS"
  fi
  rm -rf "$TB_DIR" && mkdir -p "$TB_DIR"
  tar -xf "$archive" -C "$TB_DIR" --strip-components=1
  [ -x "$TB_BIN" ] || die "no Thunderbird binary in $TB_DIR"
}

# One line with the add-on state from extensions.json (load failures: appDisabled, inactive).
addon_state() {
  node -e "
    try {
      const a = JSON.parse(require('fs').readFileSync('$BENCH/profile/extensions.json', 'utf8')).addons.find(x => x.id === '$ADDON_ID');
      console.log(a ? 'add-on ' + a.version + ': active=' + a.active + ', appDisabled=' + a.appDisabled : 'add-on not in extensions.json');
    } catch { console.log('extensions.json not written'); }
  "
}

summary() { printf '%s\n' "$@" >> "$BENCH/summary.md"; }

fail_start() {
  local msg="$1"
  tail -50 "$BENCH/thunderbird.log" >&2 || true
  summary "- Failed: $msg" "- $(addon_state)"
  stop
  die "$msg ($(addon_state))"
}

state_pid() { [ -f "$STATE" ] && node -p "require('$STATE').pid" 2>/dev/null || true; }

running() {
  local pid; pid="$(state_pid)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

stop() {
  running || { rm -f "$STATE"; return 0; }
  local pid; pid="$(state_pid)"
  node "$ROOT/test/bench/marionette.cjs" "$PORT" -e 'Services.startup.quit(Ci.nsIAppStartup.eForceQuit); return true;' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$STATE"
  log "stopped"
}

start() {
  running && die "bench already running (scripts/tb-bench.sh stop)"
  setup
  command -v node >/dev/null || die "node is required"

  rm -rf "$BENCH/profile" "$BENCH/tmp" "$BENCH/home" "$BENCH/summary.md"
  mkdir -p "$BENCH/profile/extensions" "$BENCH/tmp" "$BENCH/home"
  summary "- Thunderbird $VERSION${TB_CHANNEL:+ ($TB_CHANNEL)}, extension from ${TB_BENCH_XPI:-extension/}"
  local profile="$BENCH/profile"
  cp "$ROOT/test/bench/user.js" "$profile/user.js"
  {
    echo "user_pref(\"marionette.port\", $PORT);"
  } >> "$profile/user.js"
  if [ -n "${TB_BENCH_XPI:-}" ]; then
    [ -f "$TB_BENCH_XPI" ] || die "TB_BENCH_XPI not found: $TB_BENCH_XPI"
    cp "$TB_BENCH_XPI" "$profile/extensions/$ADDON_ID.xpi"
  else
    printf '%s\n' "$ROOT/extension" > "$profile/extensions/$ADDON_ID"
  fi
  local counts
  counts="$(node "$ROOT/test/bench/pack-mbox.cjs" "$ROOT/test/fixtures/mail" "$profile/Mail/127.0.0.1")"
  : > "$profile/Mail/127.0.0.1/Drafts"
  : > "$profile/Mail/127.0.0.1/Templates"
  mkdir -p "$profile/Mail/Local Folders"
  log "fixtures: $counts"

  log "starting Thunderbird $VERSION (headless, marionette :$PORT)"
  HOME="$BENCH/home" TMPDIR="$BENCH/tmp" MOZ_HEADLESS=1 MOZ_NO_REMOTE=1 \
    XDG_CACHE_HOME="$BENCH/home/.cache" XDG_CONFIG_HOME="$BENCH/home/.config" \
    nohup "$TB_BIN" --profile "$profile" --headless --no-remote --marionette --remote-allow-system-access \
    > "$BENCH/thunderbird.log" 2>&1 &
  local pid=$!
  local conn="$BENCH/tmp/commonpost-mcp/connection.json"
  node -e "require('fs').writeFileSync('$STATE', JSON.stringify({pid:$pid,marionettePort:$PORT,connectionFile:'$conn',profileDir:'$profile',version:'$VERSION'}, null, 2))"

  for _ in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || fail_start "Thunderbird exited"
    [ -s "$conn" ] && break
    sleep 0.5
  done
  [ -s "$conn" ] || fail_start "MCP server did not start (connection.json not written)"

  local expected
  expected="$(node -e "const c=$counts;let n=0;for(const[k,v]of Object.entries(c))if(!/^(Trash|Junk)$/.test(k))n+=v;process.stdout.write(String(n))")"
  local ready
  ready="$(node -e "
    const { Marionette } = require('$ROOT/test/bench/marionette.cjs');
    const fs = require('fs');
    (async () => {
      const m = await new Marionette($PORT).start();
      const res = await m.exec(fs.readFileSync('$ROOT/test/bench/ready.js', 'utf8'), { expected: $expected, timeoutMs: 90000 });
      m.close();
      process.stdout.write(JSON.stringify(res));
    })().catch(e => { console.error(e.message); process.exit(1); });
  ")" || fail_start "ready script failed"
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$STATE', 'utf8'));
    s.ready = $ready; s.expectedIndexed = $expected;
    fs.writeFileSync('$STATE', JSON.stringify(s, null, 2));
  "
  local line
  line="$(node -p "const r=$ready; 'TB '+r.appVersion+', default '+JSON.stringify(r.defaultAccount)+', gloda '+r.indexed+'/'+$expected")"
  summary "- $(addon_state)" "- Ready: $line"
  log "ready: $line"
}

cmd="${1:-run}"; shift || true
case "$cmd" in
  setup) setup; log "Thunderbird $VERSION in $TB_DIR" ;;
  start) start ;;
  stop) stop ;;
  status) if running; then cat "$STATE"; else echo "not running"; exit 1; fi ;;
  run)
    start
    trap stop EXIT
    TB_BENCH_STATE="$STATE" node --test --test-concurrency=1 "$@" "$ROOT"/test/bench/*.test.cjs
    ;;
  *) die "unknown command: $cmd" ;;
esac
