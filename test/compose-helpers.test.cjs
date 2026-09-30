/**
 * Compose decisions: mode resolution, reply recipients and References (nsMsgCompose.cpp ports).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const apiSource = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');
const start = apiSource.indexOf('// BEGIN COMPOSE HELPERS');
const end = apiSource.indexOf('// END COMPOSE HELPERS', start);
assert.ok(start >= 0 && end > start, 'COMPOSE HELPERS markers missing');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${apiSource.slice(start, end)}
this.api = { resolveComposeMode, composeModeRefusal, DIRECT_SEND_BLOCKED_ERROR, DRAFT_TOOL_DISABLED_ERROR, computeReplyRecipients, switchIdentityRecipients, buildReplyReferences };`, sandbox);
const api = sandbox.api;

describe('resolveComposeMode', () => {
  it('uses an explicit mode and maps legacy skipReview to send', () => {
    assert.equal(api.resolveComposeMode(undefined, undefined), 'window');
    assert.equal(api.resolveComposeMode(undefined, true), 'send');
    assert.equal(api.resolveComposeMode(undefined, false), 'window');
    assert.equal(api.resolveComposeMode('draft', true), 'draft');
    assert.equal(api.resolveComposeMode('window', true), 'window');
    assert.equal(api.resolveComposeMode('bogus', undefined), 'window');
  });

  it('only the send mode needs the skipReview gate', () => {
    for (const mode of ['window', 'draft']) assert.notEqual(api.resolveComposeMode(mode, true), 'send');
  });
});

describe('composeModeRefusal (the skipReview block)', () => {
  it('refuses a direct send while the block is on, whichever way it was asked for', () => {
    // mode send, and the legacy skipReview alone, both resolve to send
    for (const [mode, skipReview] of [['send', false], ['send', true], [undefined, true]]) {
      const composeMode = api.resolveComposeMode(mode, skipReview);
      assert.equal(api.composeModeRefusal(composeMode, { skipReviewBlocked: true, saveDraftEnabled: true }), api.DIRECT_SEND_BLOCKED_ERROR, `${mode} ${skipReview}`);
      assert.equal(api.composeModeRefusal(composeMode, { skipReviewBlocked: false, saveDraftEnabled: true }), null, `${mode} ${skipReview}`);
    }
  });

  it('never refuses a draft or a window on account of the block, even next to skipReview: true', () => {
    for (const [mode, skipReview] of [['draft', true], ['draft', false], ['window', true], [undefined, false]]) {
      const composeMode = api.resolveComposeMode(mode, skipReview);
      assert.equal(api.composeModeRefusal(composeMode, { skipReviewBlocked: true, saveDraftEnabled: true }), null, `${mode} ${skipReview}`);
    }
  });
});

describe('composeModeRefusal (the saveDraft tool)', () => {
  it('mode draft needs saveDraft enabled, whatever the block of skipReview says', () => {
    for (const skipReviewBlocked of [true, false]) {
      assert.equal(api.composeModeRefusal('draft', { skipReviewBlocked, saveDraftEnabled: false }), api.DRAFT_TOOL_DISABLED_ERROR);
      assert.equal(api.composeModeRefusal('draft', { skipReviewBlocked, saveDraftEnabled: true }), null);
    }
    assert.match(api.DRAFT_TOOL_DISABLED_ERROR, /saveDraft tool, which is disabled/);
  });

  it('a disabled saveDraft does not touch the other modes', () => {
    assert.equal(api.composeModeRefusal('window', { skipReviewBlocked: true, saveDraftEnabled: false }), null);
    assert.equal(api.composeModeRefusal('send', { skipReviewBlocked: false, saveDraftEnabled: false }), null);
    // and a blocked send is still refused for its own reason
    assert.equal(api.composeModeRefusal('send', { skipReviewBlocked: true, saveDraftEnabled: false }), api.DIRECT_SEND_BLOCKED_ERROR);
  });
});

describe('computeReplyRecipients (nsMsgCompose.cpp OnStopRequest)', () => {
  // "Name <a@x>, b@y" -> [{ name, email }]
  const mb = header => String(header || '').split(',').map(s => s.trim()).filter(Boolean).map(part => {
    const m = part.match(/^(.*?)\s*<([^>]+)>$/);
    return m ? { name: m[1], email: m[2] } : { name: '', email: part };
  });
  const emails = list => list.map(m => m.email).join(', ');
  const ctx = (extra = {}) => ({ ownEmails: ['me@home.test', 'alias@home.test'], senderEmail: 'me@home.test', overrideListReplyTo: true, ...extra });
  const run = (original, replyAll, extra) => {
    const parsed = {};
    for (const [key, value] of Object.entries(original)) parsed[key] = key === 'listPost' ? value : mb(value);
    const r = api.computeReplyRecipients(parsed, ctx(extra), replyAll);
    return { to: emails(r.to), cc: emails(r.cc), bcc: emails(r.bcc), replyTo: emails(r.replyTo), from: emails(r.from), self: r.replyToSelf };
  };
  const base = { from: 'Alice <alice@acme.test>', to: 'Me <me@home.test>, Bob <bob@acme.test>', cc: 'Carol <carol@other.test>, alias@home.test, BOB@acme.test' };

  const cases = [
    ['reply goes to From', base, false, {}, { to: 'alice@acme.test', cc: '', self: false }],
    ['reply prefers Reply-To and drops the sender identity from it',
      { ...base, replyTo: 'support@acme.test, me@home.test' }, false, {}, { to: 'support@acme.test' }],
    ['Mail-Reply-To beats Reply-To', { ...base, replyTo: 'support@acme.test', mailReplyTo: 'private@acme.test' }, false, {}, { to: 'private@acme.test' }],
    ['Reply-To munged to the list: reply to From',
      { ...base, replyTo: 'List <list@lists.test>', listPost: 'list@lists.test' }, false, {}, { to: 'alice@acme.test' }],
    ['list munging kept when mail.override_list_reply_to is off',
      { ...base, replyTo: 'list@lists.test', listPost: 'list@lists.test' }, false, { overrideListReplyTo: false }, { to: 'list@lists.test' }],
    ['reply all: From + To in To, Cc in Cc; only the sending identity is removed, other identities stay',
      base, true, {}, { to: 'alice@acme.test, bob@acme.test', cc: 'carol@other.test, alias@home.test' }],
    ['reply all with Reply-To puts Reply-To first',
      { ...base, replyTo: 'support@acme.test' }, true, {}, { to: 'support@acme.test, bob@acme.test' }],
    ['reply all with a munged list adds From after the list',
      { from: 'Leo <leo@k.test>', to: 'devs@lists.test', cc: 'me@home.test', replyTo: 'devs@lists.test', listPost: 'devs@lists.test' }, true, {},
      { to: 'devs@lists.test, leo@k.test', cc: '' }],
    ['reply all with Mail-Followup-To: To = MFT without me, original Cc dropped',
      { ...base, mailFollowupTo: 'team@lists.test, me@home.test, alice@acme.test' }, true, {}, { to: 'team@lists.test, alice@acme.test', cc: '' }],
    ['reply to own message goes to its recipients from the same author',
      { from: 'Me <me@home.test>', to: 'mike@l.test', cc: 'nina@l.test' }, false, {}, { to: 'mike@l.test', cc: '', from: 'me@home.test', self: true }],
    ['reply all to own message keeps To and Cc',
      { from: 'Me <me@home.test>', to: 'mike@l.test', cc: 'nina@l.test' }, true, {}, { to: 'mike@l.test', cc: 'nina@l.test', self: true }],
    ['From me To me without Bcc is a normal reply (generated mail with Reply-To)',
      { from: 'me@home.test', to: 'me@home.test', replyTo: 'customer@mu.test' }, false, {}, { to: 'customer@mu.test', self: false }],
    ['From me To me with Bcc stays a reply to self',
      { from: 'me@home.test', to: 'me@home.test', bcc: 'x@y.test', replyTo: 'customer@mu.test' }, false, {}, { to: 'me@home.test', self: true }],
    ['own address in Cc makes it a normal reply', { from: 'me@home.test', to: 'mike@l.test', cc: 'alias@home.test' }, false, {}, { to: 'me@home.test', self: false }],
    ['reply to self in reply all takes the original Bcc',
      { from: 'me@home.test', to: 'mike@l.test', bcc: 'boss@home.test' }, true, {}, { to: 'mike@l.test', bcc: 'boss@home.test', self: true }],
    ['plain reply keeps identity auto Cc / Bcc / Reply-To untouched',
      base, false, { autoCc: mb('boss@home.test, alice@acme.test'), autoBcc: mb('archive@home.test'), identityReplyTo: mb('desk@home.test') },
      { to: 'alice@acme.test', cc: 'boss@home.test, alice@acme.test', bcc: 'archive@home.test', replyTo: 'desk@home.test' }],
    ['reply all merges auto Cc first and removes To / own addresses from it',
      base, true, { autoCc: mb('boss@home.test, alice@acme.test') },
      { to: 'alice@acme.test, bob@acme.test', cc: 'boss@home.test, carol@other.test, alias@home.test' }],
    ['auto Cc to self keeps me in Cc',
      base, true, { autoCc: mb('me@home.test') }, { cc: 'me@home.test, carol@other.test, alias@home.test' }],
    ['auto Bcc already in Cc or To is dropped',
      base, true, { autoBcc: mb('carol@other.test, bob@acme.test, archive@home.test') }, { bcc: 'archive@home.test' }],
    ['reply to self uses the original Reply-To instead of the identity one',
      { from: 'me@home.test', to: 'mike@l.test', replyTo: 'team@home.test' }, false, { identityReplyTo: mb('desk@home.test') }, { replyTo: 'team@home.test' }],
  ];

  for (const [name, original, replyAll, extra, expected] of cases) {
    it(name, () => {
      const got = run(original, replyAll, extra);
      for (const [key, value] of Object.entries(expected)) assert.equal(got[key], value, `${key}: ${JSON.stringify(got)}`);
    });
  }
});

describe('switchIdentityRecipients (LoadIdentity)', () => {
  const mb = header => String(header || '').split(',').map(s => s.trim()).filter(Boolean).map(part => {
    const m = part.match(/^(.*?)\s*<([^>]+)>$/);
    return m ? { name: m[1], email: m[2] } : { name: '', email: part };
  });
  const emails = list => list.map(m => m.email).join(', ');
  const run = (fields, prev, next) => {
    const out = api.switchIdentityRecipients(
      { to: mb(fields.to), cc: mb(fields.cc), bcc: mb(fields.bcc), replyTo: mb(fields.replyTo) },
      { replyTo: '', cc: '', bcc: '', ...prev }, { replyTo: '', cc: '', bcc: '', ...next }, mb);
    return { to: emails(out.to), cc: emails(out.cc), bcc: emails(out.bcc), replyTo: emails(out.replyTo) };
  };

  it('swaps Reply-To, auto Cc and auto Bcc', () => {
    assert.deepEqual(
      run({ to: 'a@x.test', cc: 'old@me.test, c@x.test', bcc: 'oldb@me.test', replyTo: 'Old <desk@me.test>' },
        { replyTo: 'Old <desk@me.test>', cc: 'old@me.test', bcc: 'oldb@me.test' },
        { replyTo: 'New <team@me.test>', cc: 'boss@me.test', bcc: 'arch@me.test' }),
      { to: 'a@x.test', cc: 'c@x.test, boss@me.test', bcc: 'arch@me.test', replyTo: 'team@me.test' });
  });

  it('adds auto Cc / Bcc only for addresses not already in To / Cc (checked before the old ones go)', () => {
    assert.deepEqual(
      run({ to: 'a@x.test', cc: 'old@me.test', bcc: 'c@x.test' }, { cc: 'old@me.test' }, { cc: 'a@x.test, old@me.test, boss@me.test', bcc: 'c@x.test, boss@me.test, z@me.test' }),
      { to: 'a@x.test', cc: 'boss@me.test', bcc: 'c@x.test, z@me.test', replyTo: '' });
  });

  it('removes only the first exact match and leaves unchanged settings alone', () => {
    assert.deepEqual(
      run({ to: 'a@x.test', cc: 'Boss <boss@me.test>, boss@me.test', replyTo: 'desk@me.test' }, { cc: 'Boss <boss@me.test>', replyTo: 'desk@me.test' }, { replyTo: 'desk@me.test' }),
      { to: 'a@x.test', cc: 'boss@me.test', bcc: '', replyTo: 'desk@me.test' });
  });
});

describe('buildReplyReferences', () => {
  it('appends the original id to its chain', () => {
    assert.equal(api.buildReplyReferences(['root@x', '<mid@x>'], 'orig@x'), '<root@x> <mid@x> <orig@x>');
    assert.equal(api.buildReplyReferences([], '<orig@x>'), '<orig@x>');
    assert.equal(api.buildReplyReferences(['orig@x'], 'orig@x'), '<orig@x>');
    assert.equal(api.buildReplyReferences(['a@x', 'orig@x', 'b@x'], 'orig@x'), '<a@x> <b@x> <orig@x>');
  });

  it('adds nothing for an original without Message-ID', () => {
    assert.equal(api.buildReplyReferences(['<a@x>'], ''), '<a@x>');
    assert.equal(api.buildReplyReferences(null, ''), '');
  });

  it('keeps a long chain whole: Thunderbird trims it when it writes the message', () => {
    const chain = Array.from({ length: 60 }, (_, i) => `id${i}-${'x'.repeat(20)}@example.com`);
    const refs = api.buildReplyReferences(chain, 'orig@example.com');
    assert.equal(refs, [...chain, 'orig@example.com'].map(id => `<${id}>`).join(' '));
  });
});
