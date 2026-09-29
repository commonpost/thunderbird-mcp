/**
 * Compose decisions: mode resolution, reply recipients, References and body layout (nsMsgCompose.cpp ports).
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
this.api = { resolveComposeMode, computeReplyRecipients, switchIdentityRecipients, buildReplyReferences,
  buildCitePrefix, divWrappedHtml, citeText, removePlaintextTag, stripDocumentTags, replaceFileURLs, frameSignature, frameImageSignature,
  userBodyHtml, wrapHtmlDocument, layoutComposeHtml, layoutComposeText, removeQueryPart, tagEmbeddedObjects, serializerMetaCharset, plainEditorHtml };`, sandbox);
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

describe('cite line and quote (QuotingOutputStreamListener, InternetCiter)', () => {
  const strings = { authorWrote: '#1 wrote:', onDateAuthorWrote: 'On #2 #3, #1 wrote:', authorWroteOnDate: '#1 wrote on #2 #3:', originalMessage: '-------- Original Message --------' };
  const parts = { date: '3/12/26', time: '12:00 PM', author: 'Hana $& Eta' };

  it('picks the template by reply_header_type and fills the first placeholders', () => {
    assert.equal(api.buildCitePrefix(0, strings, parts), '-------- Original Message --------');
    assert.equal(api.buildCitePrefix(1, strings, parts), 'Hana $& Eta wrote:');
    assert.equal(api.buildCitePrefix(2, strings, parts), 'On 3/12/26 12:00 PM, Hana $& Eta wrote:');
    assert.equal(api.buildCitePrefix(3, strings, parts), 'Hana $& Eta wrote on 3/12/26 12:00 PM:');
    assert.equal(api.buildCitePrefix(1, { ...strings, authorWrote: '#1 and #1' }, parts), 'Hana $& Eta and #1');
  });

  it('an empty template falls back to the original-message delimiter', () => {
    assert.equal(api.buildCitePrefix(1, { ...strings, authorWrote: '' }, parts), '\n\n-------- Original Message --------\n');
  });

  it('wraps the cite line in a div, one <br> per line', () => {
    assert.equal(api.divWrappedHtml('On <x>, A wrote:', 'moz-cite-prefix'), '<div class="moz-cite-prefix">On &lt;x&gt;, A wrote:<br></div>');
    assert.equal(api.divWrappedHtml('\n\nX\n', 'moz-cite-prefix'), '<div class="moz-cite-prefix"><br><br>X<br></div>');
  });

  it('cites every line, without a space between quote markers', () => {
    assert.equal(api.citeText('a\n>b\n\nc\n'), '> a\n>>b\n> \n> c\n');
    assert.equal(api.citeText('a\n\n'), '> a\n> \n');
    assert.equal(api.citeText(''), '');
  });

  it('renames plaintext tags and strips document tags', () => {
    assert.equal(api.removePlaintextTag('<PLAINTEXT>x</plaintext>'), '<x-plaintext>x</x-plaintext>');
    assert.equal(api.stripDocumentTags('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head><BODY class="x"><p>a</p></body></html>'),
      '<meta charset="UTF-8"><p>a</p>');
  });
});

describe('ReplaceFileURLs', () => {
  it('replaces quoted and bare file URLs, keeps the ones it cannot read', () => {
    const toData = url => { if (url.includes('missing')) throw new Error('no'); return `data:x;${url.slice(7)}`; };
    assert.equal(api.replaceFileURLs('<img src="file:///a.png"> <img src=file:///b.png> file:///missing.png end', toData),
      '<img src="data:x;/a.png"> <img src=data:x;/b.png> file:///missing.png end');
  });
});

describe('TagEmbeddedObjects and the saved document', () => {
  it('cuts the query part like MsgRemoveQueryPart', () => {
    assert.equal(api.removeQueryPart('/Inbox?number=5&part=1.2'), '/Inbox');
    assert.equal(api.removeQueryPart('/fetch>UID>/INBOX>7/;section=2?part=1.2'), '/fetch>UID>/INBOX>7');
  });

  it('tags links and images that are not parts of the original', () => {
    const safe = url => url.startsWith('mailbox:///Inbox');
    assert.equal(api.tagEmbeddedObjects('<p><a href="https://x.test/?a=1&amp;b=2">x</a><img src=\'mailbox:///Inbox?number=5&amp;part=1.2\'><img src="https://x.test/i.png"/></p>', safe),
      '<p><a href="https://x.test/?a=1&amp;b=2" moz-do-not-send="true">x</a><img src=\'mailbox:///Inbox?number=5&amp;part=1.2\'><img src="https://x.test/i.png" moz-do-not-send="true"/></p>');
    assert.equal(api.tagEmbeddedObjects('<a name="top" title="a>b">t</a><abbr>x</abbr><A HREF=x moz-do-not-send="false">y</A>', () => false),
      '<a name="top" title="a>b" moz-do-not-send="true">t</a><abbr>x</abbr><A HREF=x moz-do-not-send="true">y</A>');
  });

  it('writes the UTF-8 charset into content-type metas', () => {
    assert.equal(api.serializerMetaCharset('<META HTTP-EQUIV="Content-Type" content="text/html; "><meta name="x" content="y">'),
      '<meta http-equiv="content-type" content="text/html; charset=UTF-8"><meta name="x" content="y">');
  });
});

describe('signature (ProcessSignature)', () => {
  const o = { composeHtml: true, replyOnTop: 0, sigBottom: true, quoted: true, suppressSigSep: false, paragraphMode: false, wrapLength: 72 };

  it('frames text and HTML signatures in HTML compose, with the separator', () => {
    assert.equal(api.frameSignature({ data: 'Bench\nUser', htmlSig: false }, o), '<br><pre class="moz-signature" cols=72>-- \nBench\nUser</pre>');
    assert.equal(api.frameSignature({ data: 'Bench <b>User</b>', htmlSig: true }, { ...o, paragraphMode: true }), '<div class="moz-signature">-- <br>Bench <b>User</b></div>');
  });

  it('drops the separator above a quote, when suppressed, or when the text has one', () => {
    const top = { ...o, replyOnTop: 1, sigBottom: false };
    assert.equal(api.frameSignature({ data: 'S', htmlSig: true }, top), '<br><div class="moz-signature">S</div>');
    assert.equal(api.frameSignature({ data: 'S', htmlSig: true }, { ...top, quoted: false }), '<br><div class="moz-signature">-- <br>S</div>');
    assert.equal(api.frameSignature({ data: 'S', htmlSig: true }, { ...o, suppressSigSep: true }), '<br><div class="moz-signature">S</div>');
    assert.equal(api.frameSignature({ data: '-- \nS', htmlSig: false }, { ...o, composeHtml: false }), '-- \nS\n');
    assert.equal(api.frameSignature({ data: 'A\n-- \nS', htmlSig: false }, { ...o, composeHtml: false }), 'A\n-- \nS\n');
  });

  it('plain compose: newline-terminated text, a blank line above a quote instead of the separator', () => {
    const plainO = { ...o, composeHtml: false };
    assert.equal(api.frameSignature({ data: 'Bench\r\nUser', htmlSig: false }, plainO), '-- \nBench\nUser\n');
    assert.equal(api.frameSignature({ data: 'Bench\nUser', htmlSig: false }, { ...plainO, replyOnTop: 1, sigBottom: false }), '\nBench\nUser\n');
    assert.equal(api.frameSignature({ data: '', htmlSig: false }, plainO), '');
  });

  it('image signature', () => {
    assert.equal(api.frameImageSignature('data:image/png;base64,AA', { ...o, paragraphMode: true }),
      "<div class=\"moz-signature\">-- <br><img src='data:image/png;base64,AA' border=0></div>");
  });
});

describe('compose body layout (ConvertAndLoadComposeWindow)', () => {
  const prefix = 'On 3/12/26 12:00 PM, Hana Eta wrote:';
  const cite = `<div class="moz-cite-prefix">${prefix}<br></div><blockquote type="cite" cite="mid:m@x">Q</blockquote>`;
  const reply = { prefix, quote: 'Q', citeRef: 'mid:m@x' };
  const prefs = (replyOnTop, sigBottom, paragraphMode, sigAboveQuote = false) => ({ replyOnTop, sigBottom, paragraphMode, sigAboveQuote });

  it('user text as typed at the caret', () => {
    assert.equal(api.userBodyHtml('a <b>\nc', false, false), 'a &lt;b&gt;<br>c');
    assert.equal(api.userBodyHtml('', false, true), '<p><br></p>');
    assert.equal(api.userBodyHtml('<html><body><p>x</p></body></html>', true, true), '<p>x</p>');
  });

  it('HTML reply below the quote (reply_on_top 0, also 2)', () => {
    const user = '<p><br></p>';
    assert.equal(api.layoutComposeHtml('reply', { ...reply, user }, prefs(0, true, true)), `${cite}<p><br></p>`);
    assert.equal(api.layoutComposeHtml('reply', { ...reply, user: 'Hi', signature: 'S' }, prefs(2, true, false)), `${cite}Hi<br>S`);
  });

  it('HTML reply above the quote: breaks and signature position', () => {
    // Without paragraph mode the editor's padding <br> stays at the end
    assert.equal(api.layoutComposeHtml('reply', { ...reply, user: 'Hi', signature: 'S' }, prefs(1, true, false)), `Hi<br><br>${cite}S<br>`);
    assert.equal(api.layoutComposeHtml('reply', { ...reply, user: 'Hi', signature: 'S' }, prefs(1, false, false, true)), `HiS<br>${cite}<br>`);
    assert.equal(api.layoutComposeHtml('reply', { ...reply, user: '<p>Hi</p>', signature: 'S' }, prefs(1, false, true, true)), `<p>Hi</p>S${cite}`);
  });

  it('HTML reply without a quote keeps the caret on top; new message', () => {
    const sig = '<br><div class="moz-signature">S</div>';
    assert.equal(api.layoutComposeHtml('reply', { prefix, user: 'Hi', signature: 'S' }, prefs(0, true, false)),
      `Hi<div class="moz-cite-prefix">${prefix}<br></div>S`);
    assert.equal(api.layoutComposeHtml('new', { user: 'Hi', signature: 'S' }, prefs(1, false, false)), 'HiS');
    // Typed text drops a <br> that only ended its line before a block
    assert.equal(api.layoutComposeHtml('new', { user: 'Hi', signature: sig }, prefs(0, true, false)), 'Hi<div class="moz-signature">S</div>');
    assert.equal(api.layoutComposeHtml('new', { user: '', signature: sig }, prefs(0, true, false)), sig);
  });

  const plainText = hunks => hunks.map(h => h.text).join('');

  it('plain hunks: the quote goes in as a quotation, the rest is typed', () => {
    const hunks = api.layoutComposeText('reply', { prefix, quote: 'q', user: 'Hi', signature: '-- \nS\n' }, prefs(0, true));
    assert.deepEqual(JSON.parse(JSON.stringify(hunks)), [{ text: `${prefix}\n` }, { text: '> q\n', quotes: true }, { text: 'Hi' }, { text: '\n\n-- \nS\n' }]);
  });

  it('plain editor document: InsertTextWithQuotations hunks, typed ">" lines stay text', () => {
    const span = '<span _moz_quote="true" style="white-space: pre-wrap; display: block; width: 98vw;">';
    const body = html => html.match(/<body style="([^"]*)">(.*)<\/body>/s).slice(1);
    assert.deepEqual(body(api.plainEditorHtml([{ text: 'On x:\n' }, { text: '> a\n>\n> b <c>\n', quotes: true }, { text: '>me\n-- \nS' }], 72)),
      ['font-family: -moz-fixed; white-space: pre-wrap; width: 72ch;', `On x:<br>${span}&gt; a<br>&gt;<br>&gt; b &lt;c&gt;<br></span>&gt;me<br>-- <br>S`]);
    // Blank lines inside a quotation stay in it, after it they are typed text
    assert.deepEqual(body(api.plainEditorHtml([{ text: 'Top\n> a\n\n> b\n\n\nEnd', quotes: true }], 0)),
      ['white-space: pre-wrap;', `Top<br>${span}&gt; a<br><br>&gt; b<br></span><br><br>End`]);
    assert.equal(body(api.plainEditorHtml([{ text: '> x', quotes: true }], 72))[1], `${span}&gt; x</span>`);
  });

  it('plain reply: bottom, top with the signature above the quote; new message', () => {
    assert.equal(plainText(api.layoutComposeText('reply', { prefix, quote: 'a\nb\n', user: 'Hi' }, prefs(0, true))), `${prefix}\n> a\n> b\nHi\n`);
    assert.equal(plainText(api.layoutComposeText('reply', { prefix, quote: 'q', user: '', signature: '\nBench\nUser\n' }, prefs(1, false, false, true))),
      `\n\nBench\nUser\n\n${prefix}\n> q\n`);
    assert.equal(plainText(api.layoutComposeText('reply', { prefix, quote: 'q', user: 'Hi', signature: '-- \nS\n' }, prefs(1, true))), `Hi\n\n${prefix}\n> q\n\n-- \nS\n`);
    assert.equal(plainText(api.layoutComposeText('new', { user: 'Hi', signature: '-- \nS\n' }, prefs(0, true))), 'Hi\n-- \nS\n');
  });

  it('wraps the body in a UTF-8 document', () => {
    assert.equal(api.wrapHtmlDocument('x'), '<html><head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body>x</body></html>');
  });
});
