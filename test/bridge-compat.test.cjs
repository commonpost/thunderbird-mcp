/**
 * What the add-on knows about the MCP bridge that calls it: the X-Commonpost-Bridge header, the states and
 * decisions, the notices and refusals, the memory of bridges seen. The production BRIDGE COMPAT block runs in a vm.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fc = require('fast-check');

const apiSource = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');

function snippet(name) {
  const start = apiSource.indexOf(`// BEGIN ${name}`);
  const end = apiSource.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `marker missing: ${name}`);
  return apiSource.slice(start, end);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${['COMPOSE HELPERS', 'BRIDGE COMPAT'].map(snippet).join('\n')}
this.x = {
  MIN_BRIDGE_VERSION, CURRENT_BRIDGE_VERSION, MODE_MIN_BRIDGE_VERSION, BRIDGE_SECURITY_FLOOR, BRIDGE_THRESHOLDS, BRIDGE_NOTICE_COOLDOWN_MS,
  BRIDGES_SEEN_MAX, versionCoreOf, compareVersionCores, parseBridgeHeader, bridgeFloorArmed, bridgeState,
  bridgeCompatDecision, bridgeReleaseUrl, bridgePhrase, bridgeAdvice, bridgeAddOn, bridgeNoticeText, bridgeRefusalText,
  bridgeModeRefusal, isRawDirectSend, rememberBridge, armBridgeNotice, takeBridgeNotice, appendBridgeNotice,
  bridgeStatusView, takeBridgeAlert, bridgeAlertContent,
};`, sandbox);
const x = sandbox.x;

const T0 = { minBridge: '0.12.0', modeMin: '0.12.0', floor: '0.0.0' };
const T1 = { minBridge: '0.12.1', modeMin: '0.12.0', floor: '0.12.1' };
const PREFS = { skipReviewBlocked: false, saveDraftEnabled: true };
const TAG = 'https://github.com/commonpost/thunderbird-mcp/releases/tag/v';
const LATEST = 'https://github.com/commonpost/thunderbird-mcp/releases/latest';
const ADVICE_FILE = 'Download mcp-bridge.cjs from the release page below and put it in place of the copy this MCP client runs (its path is in the MCP configuration of the client; in Claude Code: claude mcp get <server name>), then restart the client or reconnect the server. In Claude Desktop, install the .mcpb bundle from that page instead.';
const ADVICE_MCPB = "Download the .mcpb bundle from the release page below and install it in Claude Desktop again: open the file with Claude Desktop, or use Settings > Extensions > Advanced settings > Install Extension (a bundle installed from a file is never updated automatically; its version number can be lower than the add-on's: it is still the current bridge).";

const info = (version, packaging = 'file', profile = null, profileInvalid = false) => ({ version, packaging, profile, profileInvalid });
const NONE = info(null, 'none');
const plain = (value) => ({ ...value });

const G1 = `Commonpost notice (please tell the user): the MCP bridge does not report its version (0.11 or older); this Thunderbird add-on (version 0.12.0) recommends bridge 0.12.0 or newer. ${ADVICE_FILE} Release page: ${TAG}0.12.0`;
const G2 = `Commonpost notice (please tell the user): the MCP bridge is version 0.11.5, older than 0.12.0, which this Thunderbird add-on (version 0.12.0) recommends. ${ADVICE_FILE} Release page: ${TAG}0.12.0`;
const G3 = `Commonpost notice (please tell the user): the MCP bridge is version 0.11.5, older than 0.12.0, which this Thunderbird add-on (version 0.12.0) recommends. ${ADVICE_MCPB} Release page: ${TAG}0.12.0`;
const G4 = `Commonpost (please tell the user): this Thunderbird add-on (version 0.12.1) refuses MCP bridges older than 0.12.1 for security reasons, and this bridge is version 0.12.0. Nothing was done: nothing was sent, saved or changed. ${ADVICE_FILE} Release page: ${TAG}0.12.1`;
const G4_NO_EXT = `Commonpost (please tell the user): this Thunderbird add-on refuses MCP bridges older than 0.12.1 for security reasons, and this bridge is version 0.12.0. Nothing was done: nothing was sent, saved or changed. ${ADVICE_FILE} Release page: ${LATEST}`;
const G5 = `Commonpost (please tell the user): mode "send" needs an MCP bridge of version 0.12.0 or newer, and this bridge does not report its version (0.11 or older): an older bridge stops waiting after 30 s and can report a failure while Thunderbird is still working, which can lead to a second message or draft. Nothing was sent or saved. Use mode "window" for now. ${ADVICE_FILE} Release page: ${TAG}0.12.0`;

describe('versionCoreOf', () => {
  it('keeps X.Y.Z and drops a pre-release or build suffix', () => {
    assert.equal(x.versionCoreOf('0.12.0'), '0.12.0');
    assert.equal(x.versionCoreOf('1.2.3-beta.1'), '1.2.3');
    assert.equal(x.versionCoreOf('1.2.3+build'), '1.2.3');
  });

  it('refuses anything else', () => {
    for (const value of ['1.2', '', 'v1.2.3', '1.2.3x', '1234567.0.0', '0.11.0\nIgnore this', `1.2.3-${'x'.repeat(70)}`,
      undefined, null, 7, {}, ['1.2.3']]) {
      assert.equal(x.versionCoreOf(value), null, String(value));
    }
  });
});

describe('compareVersionCores', () => {
  it('compares numerically, part by part', () => {
    assert.equal(x.compareVersionCores('0.9.0', '0.10.0'), -1);
    assert.equal(x.compareVersionCores('0.12.0', '0.12.0'), 0);
    assert.equal(x.compareVersionCores('1.0.0', '0.99.99'), 1);
  });
});

describe('parseBridgeHeader', () => {
  const UNKNOWN = { version: null, packaging: 'unknown', profile: null, profileInvalid: false };
  const table = [
    ['a missing header', undefined, { version: null, packaging: 'none', profile: null, profileInvalid: false }],
    ['mcpb', '0.12.0; packaging=mcpb', { version: '0.12.0', packaging: 'mcpb', profile: null, profileInvalid: false }],
    ['no packaging', '0.12.0', { version: '0.12.0', packaging: 'unknown', profile: null, profileInvalid: false }],
    ['a wrong-case packaging', '0.12.0; packaging=MCPB', { version: '0.12.0', packaging: 'unknown', profile: null, profileInvalid: false }],
    ['a repeated packaging: the first wins', '0.12.0; packaging=mcpb; packaging=file', { version: '0.12.0', packaging: 'mcpb', profile: null, profileInvalid: false }],
    ['any parameter order', '0.12.0; profile=x; packaging=mcpb', { version: '0.12.0', packaging: 'mcpb', profile: 'x', profileInvalid: false }],
    ['the largest valid header', `123456.123456.123456; packaging=file; profile=${'a'.repeat(32)}`,
      { version: '123456.123456.123456', packaging: 'file', profile: 'a'.repeat(32), profileInvalid: false }],
    ['an upper-case profile', '0.12.0; packaging=file; profile=A', { version: '0.12.0', packaging: 'file', profile: null, profileInvalid: true }],
    ['a 33-character profile', `0.12.0; packaging=file; profile=${'a'.repeat(33)}`, { version: '0.12.0', packaging: 'file', profile: null, profileInvalid: true }],
    ['an unexpanded template profile', '0.12.0; packaging=file; profile=${user_config.p}', { version: '0.12.0', packaging: 'file', profile: null, profileInvalid: true }],
    ['an empty profile', '0.12.0; packaging=file; profile=', { version: '0.12.0', packaging: 'file', profile: null, profileInvalid: true }],
    ['an unknown key', '0.12.0; foo=bar; packaging=file', { version: '0.12.0', packaging: 'file', profile: null, profileInvalid: false }],
    ['no space after the semicolon', '0.12.0;packaging=file', { version: '0.12.0', packaging: 'file', profile: null, profileInvalid: false }],
    ['a development build', '0.0.0; packaging=file', { version: '0.0.0', packaging: 'file', profile: null, profileInvalid: false }],
    ['two merged headers', '0.12.0; packaging=file,0.12.0; packaging=file', UNKNOWN],
    ['a v prefix', 'v0.12.0; packaging=file', UNKNOWN],
    ['a 7-digit part', '1234567.0.0; packaging=file', UNKNOWN],
    ['a line break', '0.12.0\r\nX: y', UNKNOWN],
    ['257 characters', 'x'.repeat(257), UNKNOWN],
    ['Arabic-Indic digits', '٠.١٢.٠; packaging=file', UNKNOWN],
    ['a number', 12, UNKNOWN],
    ['an empty string', '', UNKNOWN],
    ['a word', 'x', UNKNOWN],
  ];
  for (const [label, raw, expected] of table) {
    it(`parses ${label}`, () => {
      assert.deepEqual(plain(x.parseBridgeHeader(raw)), expected);
    });
  }
});

// A text of a template: the variable slots take X.Y.Z or one of the fixed bridge phrases.
const reEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHRASE = '(?:does not report its version \\(0\\.11 or older\\)|reports an unreadable version|is a development build \\(version 0\\.0\\.0\\)|is version \\d+\\.\\d+\\.\\d+)';
const ADVICE = `(?:${reEscape(ADVICE_FILE)}|${reEscape(ADVICE_MCPB)})`;
const NOTICE_RE = new RegExp(`^Commonpost notice \\(please tell the user\\): the MCP bridge (?:(?:does not report its version \\(0\\.11 or older\\)|reports an unreadable version); this Thunderbird add-on \\(version 0\\.12\\.0\\) recommends bridge 0\\.12\\.0 or newer|is version \\d+\\.\\d+\\.\\d+, older than 0\\.12\\.0, which this Thunderbird add-on \\(version 0\\.12\\.0\\) recommends)\\. ${ADVICE} Release page: ${reEscape(TAG)}0\\.12\\.0$`);
const REFUSAL_RE = new RegExp(`^Commonpost \\(please tell the user\\): this Thunderbird add-on \\(version 0\\.12\\.1\\) refuses MCP bridges older than 0\\.12\\.1 for security reasons, and this bridge ${PHRASE}\\. Nothing was done: nothing was sent, saved or changed\\. ${ADVICE} Release page: ${reEscape(TAG)}0\\.12\\.1$`);
const MODE_RE = new RegExp(`^Commonpost \\(please tell the user\\): mode "send" needs an MCP bridge of version 0\\.12\\.0 or newer, and this bridge ${PHRASE}: an older bridge stops waiting after 30 s and can report a failure while Thunderbird is still working, which can lead to a second message or draft\\. Nothing was sent or saved\\. Use mode "window" for now\\. ${ADVICE} Release page: ${reEscape(TAG)}0\\.12\\.0$`);

describe('parseBridgeHeader on arbitrary input', () => {
  const arbitraryHeaders = [
    fc.string({ maxLength: 300 }),
    fc.array(fc.constantFrom('0.12.0', ';', ' packaging=', 'mcpb', 'file', ' profile=', 'x', 'A', '=', ',', '\r\n', '${', '9999999', ' '),
      { maxLength: 12 }).map((parts) => parts.join('')),
  ];
  for (const [index, arbitrary] of arbitraryHeaders.entries()) {
    it(`never throws, only yields parsed values and never lets the profile reach a text (generator ${index + 1})`, () => {
      fc.assert(fc.property(arbitrary, (raw) => {
        const parsed = x.parseBridgeHeader(raw);
        assert.ok(parsed.version === null || /^\d+\.\d+\.\d+$/.test(parsed.version));
        assert.ok(['mcpb', 'file', 'unknown'].includes(parsed.packaging));
        assert.ok(parsed.profile === null || /^[a-z0-9][a-z0-9-]{0,31}$/.test(parsed.profile));
        const withoutProfile = { ...parsed, profile: null, profileInvalid: false };
        const cases = [
          [x.bridgeNoticeText(parsed, '0.12.0', T0), x.bridgeNoticeText(withoutProfile, '0.12.0', T0), NOTICE_RE],
          [x.bridgeRefusalText(parsed, '0.12.1', T1), x.bridgeRefusalText(withoutProfile, '0.12.1', T1), REFUSAL_RE],
          [
            x.bridgeModeRefusal('replyToMessage', { mode: 'send' }, parsed, '0.12.0', T0, PREFS),
            x.bridgeModeRefusal('replyToMessage', { mode: 'send' }, withoutProfile, '0.12.0', T0, PREFS),
            MODE_RE,
          ],
        ];
        for (const [text, textWithoutProfile, pattern] of cases) {
          assert.equal(text, textWithoutProfile);
          if (text !== null) {
            assert.ok(!/[\r\n]/.test(text));
            assert.match(text, pattern);
          }
        }
      }), { numRuns: 300 });
    });
  }
});

describe('bridgeState and bridgeCompatDecision', () => {
  const run = (version, thresholds, ext, packaging = 'file') => {
    const bridge = version === undefined ? NONE : info(version, packaging);
    return [x.bridgeState(bridge, ext, thresholds), x.bridgeCompatDecision(bridge, ext, thresholds)];
  };

  it('shipped thresholds (floor disarmed), add-on 0.12.0', () => {
    assert.deepEqual(run(undefined, T0, '0.12.0'), ['unversioned', 'warn']);
    assert.deepEqual(run(null, T0, '0.12.0', 'unknown'), ['unversioned', 'warn']); // "junk"
    assert.deepEqual(run('0.0.0', T0, '0.12.0'), ['development', 'ok']);
    assert.deepEqual(run('0.11.9', T0, '0.12.0'), ['update-recommended', 'warn']);
    assert.deepEqual(run('0.12.0', T0, '0.12.0'), ['up-to-date', 'ok']);
    assert.deepEqual(run('0.13.0', T0, '0.12.0'), ['newer-than-add-on', 'ok']);
  });

  it('with the floor armed by hand, add-on 0.12.1', () => {
    assert.deepEqual(run(undefined, T1, '0.12.1'), ['refused', 'refuse']);
    assert.deepEqual(run('0.0.0', T1, '0.12.1'), ['refused', 'refuse']);
    assert.deepEqual(run('0.12.0', T1, '0.12.1'), ['refused', 'refuse']);
    assert.deepEqual(run('0.12.1', T1, '0.12.1'), ['up-to-date', 'ok']);
    assert.deepEqual(run('0.13.0', T1, '0.12.1'), ['newer-than-add-on', 'ok']);
  });

  it('reads the junk header through the parser as unversioned', () => {
    assert.equal(x.bridgeState(x.parseBridgeHeader('junk'), '0.12.0', T0), 'unversioned');
  });
});

describe('texts', () => {
  it('G1 to G3: the notice for an older bridge', () => {
    assert.equal(x.bridgeNoticeText(NONE, '0.12.0', T0), G1);
    assert.equal(x.bridgeNoticeText(info('0.11.5', 'file'), '0.12.0', T0), G2);
    assert.equal(x.bridgeNoticeText(info('0.11.5', 'mcpb'), '0.12.0', T0), G3);
  });

  it('G4: the refusal, and its variant when the add-on version is unreadable', () => {
    assert.equal(x.bridgeRefusalText(info('0.12.0', 'file'), '0.12.1', T1), G4);
    assert.equal(x.bridgeRefusalText(info('0.12.0', 'file'), null, T1), G4_NO_EXT);
  });

  it('G5: the refusal of a send mode from a bridge that does not report its version', () => {
    assert.equal(x.bridgeModeRefusal('replyToMessage', { mode: 'send' }, NONE, '0.12.0', T0, PREFS), G5);
  });

  it('no notice when the add-on version is unreadable or 0.0.0, or when the decision is not "warn"', () => {
    assert.equal(x.bridgeNoticeText(NONE, null, T0), null);
    assert.equal(x.bridgeNoticeText(NONE, '0.0.0', T0), null);
    assert.equal(x.bridgeNoticeText(info('0.12.0'), '0.12.0', T0), null);
    assert.equal(x.bridgeNoticeText(info('0.0.0'), '0.12.0', T0), null);
    assert.equal(x.bridgeNoticeText(info('0.13.0'), '0.12.0', T0), null);
    assert.equal(x.bridgeNoticeText(NONE, '0.12.1', T1), null); // refused, not warned
  });

  it('the phrases and the release link', () => {
    assert.equal(x.bridgePhrase(info(null, 'unknown')), 'reports an unreadable version');
    assert.equal(x.bridgePhrase(info('0.0.0')), 'is a development build (version 0.0.0)');
    assert.equal(x.bridgeReleaseUrl('0.0.0'), LATEST);
    assert.equal(x.bridgeReleaseUrl(null), LATEST);
    assert.equal(x.bridgeReleaseUrl('0.12.0'), `${TAG}0.12.0`);
  });
});

describe('bridgeModeRefusal', () => {
  const refuse = (tool, args, bridge = NONE, prefs = PREFS) => x.bridgeModeRefusal(tool, args, bridge, '0.12.0', T0, prefs);

  it('names the draft mode too', () => {
    assert.match(refuse('forwardMessage', { mode: 'draft' }), /mode "draft"/);
  });

  it('lets through what an older bridge handles safely', () => {
    for (const [tool, args] of [
      ['replyToMessage', { mode: 'send', skipReview: true }],
      ['replyToMessage', { mode: 'draft', skipReview: true }],
      ['replyToMessage', { mode: 'window' }],
      ['replyToMessage', {}],
      ['replyToMessage', { skipReview: true }],
      ['sendMail', { skipReview: false }],
    ]) {
      assert.equal(refuse(tool, args), null, `${tool} ${JSON.stringify(args)}`);
    }
  });

  it('lets through a bridge that is recent enough', () => {
    assert.equal(refuse('replyToMessage', { mode: 'send' }, info('0.12.0')), null);
  });

  it("leaves the user's settings first: they refuse in the tool itself", () => {
    assert.equal(refuse('replyToMessage', { mode: 'send' }, NONE, { skipReviewBlocked: true, saveDraftEnabled: true }), null);
    assert.equal(refuse('replyToMessage', { mode: 'draft' }, NONE, { skipReviewBlocked: false, saveDraftEnabled: false }), null);
  });

  it('refuses older and development bridges', () => {
    assert.equal(typeof refuse('replyToMessage', { mode: 'send' }, info('0.11.9')), 'string');
    assert.equal(typeof refuse('replyToMessage', { mode: 'send' }, info('0.0.0')), 'string');
  });
});

describe('isRawDirectSend', () => {
  it('is true for what may send directly', () => {
    for (const [tool, args] of [
      ['sendMail', { skipReview: true }],
      ['sendMail', { skipReview: 'false' }],
      ['replyToMessage', { mode: ' SEND ' }],
      ['replyToMessage', { mode: 'draft', skipReview: true }],
      ['sendMail', 'x'],
    ]) {
      assert.equal(x.isRawDirectSend(tool, args), true, `${tool} ${JSON.stringify(args)}`);
    }
  });

  it('is false for the rest', () => {
    assert.equal(x.isRawDirectSend('replyToMessage', { mode: 'draft' }), false);
    assert.equal(x.isRawDirectSend('listAccounts', { skipReview: true }), false);
    assert.equal(x.isRawDirectSend('sendMail', undefined), false);
  });
});

describe('the memory of bridges seen', () => {
  it('keeps two profiles of one version apart', () => {
    const seen = new Map();
    x.rememberBridge(seen, info('0.12.0', 'file', 'a'), 1);
    x.rememberBridge(seen, info('0.12.0', 'file', 'b'), 2);
    assert.equal(seen.size, 2);
  });

  it('keeps 8 entries, dropping the oldest; a bridge seen again goes last', () => {
    const seen = new Map();
    for (let i = 0; i < 9; i++) x.rememberBridge(seen, info(`0.${i}.0`), i);
    assert.equal(seen.size, 8);
    assert.deepEqual([...seen.values()].map((entry) => entry.version), ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0']);
    x.rememberBridge(seen, info('0.1.0'), 20);
    assert.equal([...seen.values()].at(-1).version, '0.1.0');
    assert.equal([...seen.values()].at(-1).lastSeenMs, 20);
  });

  it('keeps parsed values only', () => {
    const entry = x.rememberBridge(new Map(), info('0.12.0', 'mcpb', 'x'), 5);
    assert.deepEqual(Object.keys(entry).sort(),
      ['alerted', 'armed', 'firstSeenMs', 'lastNoticedMs', 'lastSeenMs', 'packaging', 'pending', 'profile', 'profileInvalid', 'version']);
  });
});

describe('arming the notice', () => {
  const MIN = 60 * 1000;

  it('takes the notice once, and arms again at most every 10 minutes', () => {
    const entry = x.rememberBridge(new Map(), NONE, 0);
    assert.equal(x.takeBridgeNotice(entry, 1000), true);
    assert.equal(x.takeBridgeNotice(entry, 1000), false);
    x.armBridgeNotice(entry, 1000 + 5 * MIN);
    assert.equal(x.takeBridgeNotice(entry, 1000 + 5 * MIN), false);
    x.armBridgeNotice(entry, 1000 + 10 * MIN);
    assert.equal(x.takeBridgeNotice(entry, 1000 + 10 * MIN), true);
  });

  it('keeps the notice of a session that starts during the cooldown for its first call after it', () => {
    // Two clients behind bridges 0.11 share the entry: the first one takes the notice, the second one lists its
    // tools two minutes later
    const entry = x.rememberBridge(new Map(), NONE, 0);
    assert.equal(x.takeBridgeNotice(entry, 1000), true);
    x.armBridgeNotice(entry, 1000 + 2 * MIN);
    assert.equal(x.takeBridgeNotice(entry, 1000 + 3 * MIN), false, 'not during the cooldown');
    assert.equal(x.takeBridgeNotice(entry, 1000 + 98 * MIN), true, 'the first call after it');
    assert.equal(x.takeBridgeNotice(entry, 1000 + 99 * MIN), false, 'once');
    assert.equal(x.takeBridgeNotice(entry, 1000 + 200 * MIN), false, 'and no more without a new session');
  });

  it('does not repeat the notice to a session that goes on, however long', () => {
    const entry = x.rememberBridge(new Map(), NONE, 0);
    assert.equal(x.takeBridgeNotice(entry, 1000), true);
    for (const minutes of [1, 11, 60, 600]) assert.equal(x.takeBridgeNotice(entry, 1000 + minutes * MIN), false);
  });
});

describe('appendBridgeNotice', () => {
  const fresh = () => ({ result: { content: [{ type: 'text', text: 'result' }] }, entry: x.rememberBridge(new Map(), NONE, 0) });

  it('adds nothing to a direct send and keeps the notice for later', () => {
    const { result, entry } = fresh();
    assert.equal(x.appendBridgeNotice(result, 'sendMail', { skipReview: true }, NONE, entry, '0.12.0', T0, 1), null);
    assert.equal(result.content.length, 1);
    assert.equal(entry.armed, true);
  });

  it('adds the notice as the last item of an ordinary call, once', () => {
    const { result, entry } = fresh();
    assert.equal(x.appendBridgeNotice(result, 'listAccounts', {}, NONE, entry, '0.12.0', T0, 1), G1);
    assert.deepEqual(result.content.map((item) => item.text), ['result', G1]);
    assert.equal(x.appendBridgeNotice(result, 'listAccounts', {}, NONE, entry, '0.12.0', T0, 2), null);
    assert.equal(result.content.length, 2);
  });

  it('does nothing without a content list', () => {
    const { entry } = fresh();
    assert.equal(x.appendBridgeNotice({}, 'listAccounts', {}, NONE, entry, '0.12.0', T0, 1), null);
    assert.equal(x.appendBridgeNotice(null, 'listAccounts', {}, NONE, entry, '0.12.0', T0, 1), null);
  });
});

describe('bridgeStatusView', () => {
  it('has no bridge for an empty or missing memory', () => {
    for (const seen of [new Map(), null]) {
      assert.deepEqual(JSON.parse(JSON.stringify(x.bridgeStatusView(seen, '0.12.0', T0))).bridges, []);
    }
  });

  it('sorts by last seen, newest first, and links the right release page', () => {
    const seen = new Map();
    x.rememberBridge(seen, info('0.11.0'), 1000);
    x.rememberBridge(seen, info('0.13.0'), 3000);
    x.rememberBridge(seen, info('0.12.0'), 2000);
    const view = JSON.parse(JSON.stringify(x.bridgeStatusView(seen, '0.12.0', T0)));
    assert.deepEqual(view.bridges.map((bridge) => bridge.version), ['0.13.0', '0.12.0', '0.11.0']);
    assert.equal(view.bridges[0].releaseUrl, `${TAG}0.13.0`);
    assert.equal(view.bridges[1].releaseUrl, `${TAG}0.12.0`);
    assert.equal(view.bridges[0].state, 'newer-than-add-on');
    assert.equal(view.extensionVersion, '0.12.0');
    assert.equal(view.minBridgeVersion, '0.12.0');
    assert.equal(view.securityFloor, '0.0.0');
    assert.equal(view.bridges[0].lastSeen, new Date(3000).toISOString());
  });

  it('links the latest release when the add-on version is unreadable', () => {
    const seen = new Map();
    x.rememberBridge(seen, info('0.11.0'), 1000);
    const view = x.bridgeStatusView(seen, null, T0);
    assert.equal(view.bridges[0].releaseUrl, LATEST);
    assert.equal(view.extensionVersion, null);
  });
});

const TC = { minBridge: '0.12.0', modeMin: '0.12.0', floor: '0.0.0', current: '0.13.0' };

describe('newer-available state', () => {
  it('is a bridge between the recommended version and the current one, and is not a warning', () => {
    assert.equal(x.bridgeState(info('0.12.0'), '0.13.0', TC), 'newer-available');
    assert.equal(x.bridgeState(info('0.12.5'), '0.13.0', TC), 'newer-available');
    assert.equal(x.bridgeCompatDecision(info('0.12.0'), '0.13.0', TC), 'ok');
    assert.equal(x.bridgeNoticeText(info('0.12.0'), '0.13.0', TC), null);
  });

  it('is up-to-date at the current version, update-recommended below the recommended one', () => {
    assert.equal(x.bridgeState(info('0.13.0'), '0.13.0', TC), 'up-to-date');
    assert.equal(x.bridgeState(info('0.11.9'), '0.13.0', TC), 'update-recommended');
  });

  it('does not exist without thresholds.current, and keeps newer-than-add-on first', () => {
    assert.equal(x.bridgeState(info('0.12.0'), '0.13.0', T0), 'up-to-date');
    assert.equal(x.bridgeState(info('0.14.0'), '0.13.0', TC), 'newer-than-add-on');
  });

  it('shows the current bridge version in the status view', () => {
    const seen = new Map();
    x.rememberBridge(seen, info('0.12.0'), 1000);
    const view = JSON.parse(JSON.stringify(x.bridgeStatusView(seen, '0.13.0', TC)));
    assert.equal(view.currentBridgeVersion, '0.13.0');
    assert.equal(view.bridges[0].state, 'newer-available');
    assert.equal(x.bridgeStatusView(seen, '0.13.0', T0).currentBridgeVersion, null);
  });
});

describe('takeBridgeAlert', () => {
  it('is true once per entry, and again for another identity', () => {
    const seen = new Map();
    const a = x.rememberBridge(seen, info('0.11.5'), 1000);
    assert.equal(a.alerted, false);
    assert.equal(x.takeBridgeAlert(a), true);
    assert.equal(x.takeBridgeAlert(x.rememberBridge(seen, info('0.11.5'), 2000)), false);
    assert.equal(x.takeBridgeAlert(x.rememberBridge(seen, info('0.11.6'), 3000)), true);
    assert.equal(x.takeBridgeAlert(x.rememberBridge(seen, info('0.11.5', 'mcpb'), 4000)), true);
  });
});

describe('bridgeAlertContent', () => {
  const TITLE = 'Commonpost MCP: update the bridge';
  const SEE = 'See the options of the add-on, section Bridge.';

  it('says which bridge connected when its version is readable', () => {
    assert.deepEqual(plain(x.bridgeAlertContent(info('0.11.5'), '0.12.0', T0)), {
      title: TITLE,
      text: `An MCP client connected with bridge 0.11.5. This add-on (version 0.12.0) recommends bridge 0.12.0 or newer. ${SEE}`,
    });
  });

  it('describes a bridge without a readable version', () => {
    assert.equal(x.bridgeAlertContent(NONE, '0.12.0', T0).text,
      `An MCP client connected with a bridge that does not report its version (0.11 or older). This add-on (version 0.12.0) recommends bridge 0.12.0 or newer. ${SEE}`);
  });

  it('says that a refused bridge cannot work', () => {
    assert.deepEqual(plain(x.bridgeAlertContent(info('0.12.0'), '0.12.1', T1)), {
      title: TITLE,
      text: `An MCP client connected with a bridge that this add-on refuses for security reasons (older than 0.12.1). No tool works with it. ${SEE}`,
    });
  });

  it('is null when nothing is due or the add-on version is unreadable', () => {
    assert.equal(x.bridgeAlertContent(info('0.12.0'), '0.12.0', T0), null);
    assert.equal(x.bridgeAlertContent(info('0.12.0'), '0.13.0', TC), null);
    assert.equal(x.bridgeAlertContent(info('0.15.0'), '0.13.0', TC), null);
    assert.equal(x.bridgeAlertContent(info('0.11.5'), null, T0), null);
    assert.equal(x.bridgeAlertContent(info('0.11.5'), '0.0.0', T0), null);
  });

  it('never carries the raw header or the profile', () => {
    const alert = x.bridgeAlertContent(info('0.11.5', 'file', 'secret-profile'), '0.12.0', T0);
    assert.ok(!alert.text.includes('secret-profile'));
  });
});

describe('BRIDGE ALERT wiring', () => {
  it('calls the alert in the header block, right after the add-on version is read', () => {
    const block = snippet('BRIDGE HEADER READ');
    const first = 'const bridgeAlert = bridgeAlertContent(bridgeInfo, bridgeExtCore, BRIDGE_THRESHOLDS);';
    const second = 'if (bridgeAlert && takeBridgeAlert(bridgeEntry)) showBridgeAlert(bridgeAlert);';
    const core = block.indexOf('const bridgeExtCore = versionCoreOf(getExtVersion());');
    assert.ok(core >= 0 && block.indexOf(first) > core && block.indexOf(second) > block.indexOf(first));
  });

  it('reads the pref with true as default and calls the alerts service in a try/catch', () => {
    const block = snippet('BRIDGE ALERT');
    assert.ok(block.includes('Services.prefs.getBoolPref(PREF_BRIDGE_UPDATE_ALERT, true)'));
    assert.ok(block.includes('Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService)'));
    assert.ok(block.indexOf('try {') >= 0 && block.indexOf('try {') < block.indexOf('service.showAlert(') && block.includes('} catch (e) {'));
    assert.ok(apiSource.includes('const PREF_BRIDGE_UPDATE_ALERT = "extensions.commonpost-mcp.bridgeUpdateAlert";'));
  });

  describe('showBridgeAlert', () => {
    const ALERT = { title: 'T', text: 'X' };
    // modern: a service with showAlert(nsIAlertNotification), as Thunderbird 156; otherwise only showAlertNotification
    function load({ pref, throws = false, modern = true }) {
      const calls = [];
      const warnings = [];
      const service = modern
        ? { showAlert: (n) => { if (throws) throw new Error('no alerts'); calls.push(['alert', ...n.inited]); } }
        : { showAlertNotification: (...args) => { if (throws) throw new Error('no alerts'); calls.push(['alert', ...args]); } };
      const box = {
        PREF_BRIDGE_UPDATE_ALERT: 'extensions.commonpost-mcp.bridgeUpdateAlert',
        Services: { prefs: { getBoolPref: (name, fallback) => { calls.push(['pref', name, fallback]); return pref; } } },
        Cc: {
          '@mozilla.org/alerts-service;1': { getService: () => service },
          '@mozilla.org/alert-notification;1': { createInstance: () => ({ init(...args) { this.inited = args; } }) },
        },
        Ci: { nsIAlertsService: {}, nsIAlertNotification: {} },
        console: { warn: (...args) => warnings.push(args) },
      };
      vm.createContext(box);
      vm.runInContext(`${snippet('BRIDGE ALERT')}\nthis.show = showBridgeAlert;`, box);
      return { show: box.show, calls, warnings };
    }

    it('does nothing when the pref is false', () => {
      const t = load({ pref: false });
      t.show(ALERT);
      assert.deepEqual(t.calls.filter((c) => c[0] === 'alert'), []);
    });

    it('shows the notification when the pref is true', () => {
      const t = load({ pref: true });
      t.show(ALERT);
      assert.deepEqual(t.calls.filter((c) => c[0] === 'alert'), [['alert', 'commonpost-mcp-bridge', '', 'T', 'X']]);
      assert.deepEqual(t.calls[0], ['pref', 'extensions.commonpost-mcp.bridgeUpdateAlert', true]);
    });

    it('uses showAlertNotification where the service has no showAlert', () => {
      const t = load({ pref: true, modern: false });
      t.show(ALERT);
      assert.deepEqual(t.calls.filter((c) => c[0] === 'alert'),
        [['alert', '', 'T', 'X', false, '', null, 'commonpost-mcp-bridge']]);
    });

    it('lets nothing escape when the service throws', () => {
      const t = load({ pref: true, throws: true });
      assert.doesNotThrow(() => t.show(ALERT));
      assert.equal(t.warnings.length, 1);
    });
  });
});

describe('shipped constants', () => {
  it('are versions, grouped in BRIDGE_THRESHOLDS', () => {
    for (const value of [x.MIN_BRIDGE_VERSION, x.CURRENT_BRIDGE_VERSION, x.MODE_MIN_BRIDGE_VERSION, x.BRIDGE_SECURITY_FLOOR]) {
      assert.match(value, /^\d+\.\d+\.\d+$/);
    }
    assert.deepEqual(plain(x.BRIDGE_THRESHOLDS),
      { minBridge: x.MIN_BRIDGE_VERSION, modeMin: x.MODE_MIN_BRIDGE_VERSION, floor: x.BRIDGE_SECURITY_FLOOR, current: x.CURRENT_BRIDGE_VERSION });
  });

  it('recommend the first bridge that waits for saveDraft, and keep the modes at the first bridge that waits for them', () => {
    // 0.13.0 is the first bridge whose isDraftCall counts saveDraft (the long wait); a bridge 0.12 gives up after 30 s
    // while Thunderbird may still save. It gets the notice; nothing is refused.
    assert.equal(x.MIN_BRIDGE_VERSION, '0.13.0');
    assert.equal(x.MODE_MIN_BRIDGE_VERSION, '0.12.0');
    const bridge = require('../mcp-bridge.cjs');
    const saveDraft = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'saveDraft', arguments: {} } };
    assert.equal(bridge.requestOptionsFor(saveDraft).timeoutMs, 180000);
    assert.equal(x.bridgeCompatDecision(info('0.12.0'), '0.13.0', x.BRIDGE_THRESHOLDS), 'warn');
    assert.equal(x.bridgeCompatDecision(info('0.13.0'), '0.13.0', x.BRIDGE_THRESHOLDS), 'ok');
    assert.equal(x.bridgeModeRefusal('replyToMessage', { mode: 'draft' }, info('0.12.0'), '0.13.0', x.BRIDGE_THRESHOLDS,
      { skipReviewBlocked: true, saveDraftEnabled: true }), null);
  });

  it('keep an armed floor at or below the recommended bridge version', () => {
    // Whether the floor is armed is checked against the CHANGELOG by scripts/check-versions.cjs
    if (x.BRIDGE_SECURITY_FLOOR !== '0.0.0') {
      assert.ok(x.compareVersionCores(x.BRIDGE_SECURITY_FLOOR, x.MIN_BRIDGE_VERSION) <= 0);
    }
  });
});
