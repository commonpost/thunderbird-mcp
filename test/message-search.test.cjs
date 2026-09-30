/**
 * Message search helpers: query parser, matcher, compact rows, grouping, envelope, body paging.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const apiSource = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');
const start = apiSource.indexOf('// BEGIN MESSAGE SEARCH HELPERS');
const end = apiSource.indexOf('// END MESSAGE SEARCH HELPERS', start);
assert.ok(start >= 0 && end > start, 'MESSAGE SEARCH HELPERS markers missing');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${apiSource.slice(start, end)}
this.api = { parseSearchQuery, matchSearchTerms, glodaSearchTerms, compactSearchRow, rowsToTable, listResultAsTable,
  threadSubjectKey, counterpartEmails, threadPeople, threadKeysOf, conversationMembers, groupSearchRows, buildSearchPage, legacySearchPage, pageTextField, pageMessageBody, SEARCH_PREVIEW_CHARS,
  DEFAULT_SEARCH_RESULTS, DEFAULT_GET_MESSAGE_BODY_CHARS, MAX_BODY_CHARS };`, sandbox);
const api = sandbox.api;
const plain = v => JSON.parse(JSON.stringify(v));

describe('glodaSearchTerms (T5)', () => {
  const terms = q => plain(api.glodaSearchTerms(q));

  it('splits like GlodaMsgSearcher and reports the terms its query leaves out', () => {
    assert.deepEqual(terms('счет на оплату'), { kept: ['счет', 'оплату'], dropped: ['на'] });
    assert.deepEqual(terms('"to be"  or "not to be" x'), { kept: ['to be', 'not to be'], dropped: ['or', 'x'] });
    assert.deepEqual(terms('"unclosed ab'), { kept: ['unclosed'], dropped: ['ab'] });
    assert.deepEqual(terms('ab NEAR/3 cd'), { kept: ['NEAR/3'], dropped: ['ab', 'cd'] });
  });

  it('keeps one or two CJK characters', () => {
    assert.deepEqual(terms('中 日本 a中'), { kept: ['中', '日本'], dropped: ['a中'] });
  });
});

describe('parseSearchQuery', () => {
  const parse = q => plain(api.parseSearchQuery(q));

  it('keeps the legacy single leading operator meaning', () => {
    assert.deepEqual(parse('from:Alice Smith'), {
      terms: [{ field: 'author', value: 'alice' }, { field: 'author', value: 'smith' }], failed: false,
    });
    assert.deepEqual(parse('subject: quarterly report').terms.map(t => t.field), ['subject', 'subject']);
  });

  it('applies each operator to its own value when several are given', () => {
    assert.deepEqual(parse('from:alice subject:invoice budget').terms, [
      { field: 'author', value: 'alice' },
      { field: 'subject', value: 'invoice' },
      { field: null, value: 'budget' },
    ]);
  });

  it('supports quoted phrases and participant', () => {
    assert.deepEqual(parse('participant:@acme.test subject:"invoice 42"').terms, [
      { field: 'participant', value: '@acme.test' },
      { field: 'subject', value: 'invoice 42' },
    ]);
    assert.deepEqual(parse('"project x" to:bob').terms, [
      { field: null, value: 'project x' },
      { field: 'recipients', value: 'bob' },
    ]);
  });

  it('takes the next word for "op: value" when several operators are used', () => {
    assert.deepEqual(parse('from: alice to: bob').terms, [
      { field: 'author', value: 'alice' },
      { field: 'recipients', value: 'bob' },
    ]);
  });

  it('treats unknown operators and urls as plain words', () => {
    assert.deepEqual(parse('https://example.org ticket:42').terms, [
      { field: null, value: 'https://example.org' },
      { field: null, value: 'ticket:42' },
    ]);
  });

  it('flags whitespace and bare operators as failed, empty as match-all', () => {
    assert.deepEqual(parse(''), { terms: [], failed: false });
    assert.equal(parse('   ').failed, true);
    assert.equal(parse('from:').failed, true);
    assert.equal(parse('from: to:').failed, true);
    assert.equal(parse('subject:""').failed, true);
  });
});

describe('matchSearchTerms', () => {
  const fields = {
    subject: 're: invoice 42', author: 'alice <alice@acme.test>', recipients: 'me@home.test',
    ccList: 'carol@other.test', bccList: 'boss@acme.test', preview: 'please find attached',
  };
  const match = q => api.matchSearchTerms(api.parseSearchQuery(q).terms, fields);

  it('matches participant against from, to, cc and bcc', () => {
    assert.equal(match('participant:@acme.test'), true);
    assert.equal(match('participant:carol'), true);
    assert.equal(match('participant:boss@'), true);
    assert.equal(match('participant:nobody'), false);
  });

  it('matches "@domain" as the domain suffix of each address, comma = OR', () => {
    const decoy = { ...fields, author: 'oscar <oscar@acme.test.evil>', bccList: '' };
    assert.equal(api.matchSearchTerms(api.parseSearchQuery('participant:@acme.test').terms, decoy), false);
    assert.equal(api.matchSearchTerms(api.parseSearchQuery('participant:acme.test').terms, decoy), true);
    assert.equal(match('participant:@acme.test'), true);
    assert.equal(match('participant:@sub.acme.test'), false);
    assert.equal(match('participant:@nowhere.test,@other.test'), true);
    assert.equal(match('participant:@nowhere.test, @other.test'), true);
    assert.equal(match('participant:@nowhere.test,@none.test'), false);
    assert.deepEqual(plain(api.parseSearchQuery('participant:@a.test, @b.test subject:x').terms), [
      { field: 'participant', value: '@a.test,@b.test' }, { field: 'subject', value: 'x' },
    ]);
  });

  it('ANDs all terms and scopes operators to their field', () => {
    assert.equal(match('from:alice subject:invoice'), true);
    assert.equal(match('from:alice subject:budget'), false);
    assert.equal(match('to:alice'), false);
    assert.equal(match('attached invoice'), true);
  });

  it('does not search bcc for bare words', () => {
    assert.equal(match('boss'), false);
  });
});

describe('compactSearchRow and rowsToTable', () => {
  const row = {
    id: 'a@x', threadId: 7, subject: 'Hi', author: 'A', recipients: 'B', ccList: '', date: '2026-01-01T00:00:00.000Z',
    folder: 'Inbox', folderPath: 'imap://u@h/INBOX', read: true, flagged: false, tags: [], _dateTs: 1,
    preview: 'x'.repeat(300),
  };

  it('drops internal, empty and redundant fields and trims the preview', () => {
    const c = plain(api.compactSearchRow(row));
    assert.deepEqual(Object.keys(c).sort(), ['author', 'date', 'folderPath', 'id', 'preview', 'read', 'recipients', 'subject']);
    assert.equal(c.preview.length, api.SEARCH_PREVIEW_CHARS + 3);
    assert.equal(api.compactSearchRow({ ...row, flagged: true }).flagged, true);
    assert.equal(api.compactSearchRow({ ...row, read: false }).read, false);
  });

  it('puts known columns first and fills gaps with null', () => {
    const t = plain(api.rowsToTable([{ subject: 's', id: '1', zeta: 1 }, { id: '2', folderPath: 'f' }]));
    assert.deepEqual(t.columns, ['id', 'folderPath', 'subject', 'zeta']);
    assert.deepEqual(t.rows, [['1', null, 's', 1], ['2', 'f', null, null]]);
  });
});

describe('listResultAsTable', () => {
  it('converts plain arrays only when asked', () => {
    const events = [{ id: 'e1', title: 'Standup', location: '' }, { id: 'e2', title: 'Review', location: 'Room 1' }];
    assert.equal(api.listResultAsTable(events, 'objects'), events);
    assert.deepEqual(plain(api.listResultAsTable(events, 'table')), {
      columns: ['id', 'location', 'title'], rows: [['e1', null, 'Standup'], ['e2', 'Room 1', 'Review']],
    });
    assert.deepEqual(plain(api.listResultAsTable({ error: 'x' }, 'table')), { error: 'x' });
  });
});

describe('groupSearchRows', () => {
  const rows = [
    { id: '1', author: 'Alice <alice@acme.test>', subject: 'Plan', date: 'd1', folderPath: 'f', read: true, _dateTs: 1, _threadKey: 'root' },
    { id: '2', author: 'Bob <bob@acme.test>', subject: 'Re: Plan', date: 'd2', folderPath: 'f', read: false, _dateTs: 2, _threadKey: 'root' },
    { id: '3', author: 'ALICE@acme.test', subject: 'Other', date: 'd3', folderPath: 's', read: false, _dateTs: 3, _threadKey: '3' },
  ];

  it('groups by sender email case-insensitively, newest first', () => {
    const g = plain(api.groupSearchRows(rows, 'sender', 'desc'));
    assert.equal(g.length, 2);
    assert.deepEqual(
      { sender: g[0].sender, count: g[0].count, unread: g[0].unread, firstDate: g[0].firstDate, lastDate: g[0].lastDate, latestId: g[0].latestId, latestFolderPath: g[0].latestFolderPath },
      { sender: 'ALICE@acme.test', count: 2, unread: 1, firstDate: 'd1', lastDate: 'd3', latestId: '3', latestFolderPath: 's' },
    );
    assert.equal(g[1].sender, 'Bob <bob@acme.test>');
  });

  it('groups by thread key with the first subject and last author', () => {
    const g = plain(api.groupSearchRows(rows, 'thread', 'asc'));
    assert.equal(g.length, 2);
    assert.equal(g[0].subject, 'Plan');
    assert.equal(g[0].lastAuthor, 'Bob <bob@acme.test>');
    assert.equal(g[0].count, 2);
    assert.equal(g[1].latestId, '3');
  });

  it('points latestId at the newest message that is not a draft', () => {
    const withDraft = [...rows.slice(0, 2), { id: 'd', author: 'Me <me@x>', subject: 'Re: Plan', date: 'd9', folderPath: 'drafts', read: true, _dateTs: 9, _threadKey: 'root', _draft: true }];
    const [g] = plain(api.groupSearchRows(withDraft, 'thread', 'desc'));
    assert.equal(g.count, 3);
    assert.equal(g.drafts, 1);
    assert.equal(g.latestId, '2');
    const [only] = plain(api.groupSearchRows([withDraft[2]], 'thread', 'desc'));
    assert.equal(only.latestId, 'd');
    assert.equal(plain(api.groupSearchRows(rows, 'thread', 'desc'))[0].drafts, undefined);
  });
});

describe('subject linking', () => {
  it('strips reply, forward and auto-reply prefixes', () => {
    assert.equal(api.threadSubjectKey('Re: Fwd: RE[2]: Quarterly  plan'), 'quarterly plan');
    assert.equal(api.threadSubjectKey('Ответ: Отв: Пересл: Счет на оплату'), 'счет на оплату');
    assert.equal(api.threadSubjectKey('Автоматический ответ: Архитектурный запрос'), 'архитектурный запрос');
    assert.equal(api.threadSubjectKey('Report: Q3'), 'report: q3');
  });

  it('reads at most 1000 characters of a subject, so thousands of prefixes stay cheap', () => {
    const started = Date.now();
    assert.equal(api.threadSubjectKey(`${'Re: '.repeat(20000)}Quarterly plan`), '');
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
    assert.equal(api.threadSubjectKey(`Re: ${'x'.repeat(5000)}`), 'x'.repeat(996));
    assert.equal(api.threadSubjectKey(`Re: ${'x'.repeat(5000)}`), api.threadSubjectKey(`Re: ${'x'.repeat(6000)}`));
  });

  it('ignores subjects too short to identify a conversation', () => {
    assert.equal(api.threadSubjectKey('Re: Hi'), '');
    assert.equal(api.threadSubjectKey(''), '');
  });

  it('lists counterparts without own addresses', () => {
    const own = new Set(['me@home.test']);
    const fields = { author: 'Me <me@home.test>', recipients: '"Doe, J" <J.Doe@X.test>, a@y.test', ccList: '=?utf-8?B?0JE=?= <b@y.test>', bccList: '' };
    assert.deepEqual([...api.counterpartEmails(fields, own)], ['j.doe@x.test', 'a@y.test', 'b@y.test']);
  });

  it('finds addresses as before, in linear time on long runs a sender can write', () => {
    const none = new Set();
    const emails = fields => [...api.counterpartEmails({ author: '', recipients: '', ccList: '', bccList: '', ...fields }, none)];
    assert.deepEqual(emails({ recipients: '@x.test, x@, a@b@c.test, (u@v.test); <w@z.test>' }), ['a@b@c.test', 'u@v.test', 'w@z.test']);
    const long = 'a'.repeat(200000);
    const started = Date.now();
    assert.deepEqual(emails({ author: long, recipients: `${long}@x.test`, ccList: '<'.repeat(200000) }), [`${long}@x.test`]);
    const [group] = plain(api.groupSearchRows([{ id: '1', author: '<'.repeat(200000), subject: 's', date: 'd', folderPath: 'f', read: true, _dateTs: 1 }], 'sender', 'desc'));
    assert.equal(group.count, 1);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
    const bySender = rows => plain(api.groupSearchRows(rows.map((author, i) => ({ id: String(i), author, subject: 's', date: 'd', folderPath: 'f', read: true, _dateTs: i })), 'sender', 'asc')).map(g => g.count);
    assert.deepEqual(bySender(['Ann <ANN@x.test>', 'ann@x.test', '<> Ann <ann@x.test>', 'Bob <<bob@x.test>']), [3, 1]);
  });

  it('takes the author as the key person, for own mail the addressees', () => {
    const own = new Set(['me@bench.test']);
    const people = fields => { const p = api.threadPeople(fields, own); return { key: plain(p.key), all: [...p.all] }; };
    assert.deepEqual(people({ author: 'Erin <erin@e.test>', recipients: 'me@bench.test', ccList: 'pat@s.test' }), { key: ['erin@e.test'], all: ['erin@e.test', 'pat@s.test'] });
    assert.deepEqual(people({ author: 'me@bench.test', recipients: 'Carol <carol@g.test>', ccList: 'pat@s.test' }).key, ['carol@g.test']);
    assert.deepEqual(people({ author: 'me@bench.test', recipients: 'me@bench.test', ccList: 'pat@s.test' }).key, ['pat@s.test']);
  });
});

// The conversation fixtures of test/fixtures/mail as scan items.
const OWN = new Set(['me@bench.test']);
const MAIL = [
  ['chain1@alpha.test', [], '2026-03-02T09:00', 'Project kickoff', 'alice@alpha.test', 'me@bench.test'],
  ['chain2@bench.test', ['chain1@alpha.test'], '2026-03-02T10:00', 'Re: Project kickoff', 'me@bench.test', 'alice@alpha.test'],
  ['chain3@alpha.test', ['chain1@alpha.test', 'chain2@bench.test'], '2026-03-02T11:00', 'Re: Project kickoff', 'alice@alpha.test', 'me@bench.test', 'bob@alpha.test'],
  ['chain4@bench.test', ['chain1@alpha.test', 'chain2@bench.test', 'chain3@alpha.test'], '2026-03-02T15:00', 'Re: Project kickoff', 'me@bench.test', 'alice@alpha.test, bob@alpha.test'],
  ['chain5@alpha.test', ['chain4@bench.test'], '2026-03-03T10:00', 'Kickoff dates', 'bob@alpha.test', 'me@bench.test'],
  ['noref1@gamma.test', [], '2026-03-04T09:00', 'Invoice question', 'carol@gamma.test', 'me@bench.test'],
  ['noref2@bench.test', [], '2026-03-04T12:00', 'Re: Invoice question', 'me@bench.test', 'carol@gamma.test'],
  ['noref3@gamma.test', [], '2026-03-05T08:00', 'Re: Invoice question', 'carol@gamma.test', 'me@bench.test'],
  ['outreach-a@bench.test', [], '2026-03-06T09:00', 'Partnership proposal', 'me@bench.test', 'dan@delta.test', 'partner@shared.test'],
  ['outreach-b@bench.test', [], '2026-03-06T09:05', 'Partnership proposal', 'me@bench.test', 'erin@epsilon.test', 'partner@shared.test'],
  ['outreach-a-reply@delta.test', ['outreach-a@bench.test'], '2026-03-07T10:00', 'Re: Partnership proposal', 'dan@delta.test', 'me@bench.test', 'partner@shared.test'],
  ['outreach-b-reply@epsilon.test', [], '2026-03-07T11:00', 'Re: Partnership proposal', 'erin@epsilon.test', 'me@bench.test', 'partner@shared.test'],
  ['notify1@service.test', [], '2026-03-09T06:00', 'Your weekly report', 'noreply@service.test', 'me@bench.test'],
  ['notify2@service.test', [], '2026-03-16T06:00', 'Your weekly report', 'noreply@service.test', 'me@bench.test'],
  ['notify3@service.test', [], '2026-03-23T06:00', 'Your weekly report', 'noreply@service.test', 'me@bench.test'],
].map(([id, refs, date, subject, author, recipients, ccList = '']) => ({
  id, refs, dateTs: Date.parse(`${date}Z`) * 1000, subjectKey: api.threadSubjectKey(subject), hasRe: /^Re: /.test(subject),
  fields: { author, recipients, ccList },
}));

function membersOf(items, seedId) {
  const members = api.conversationMembers(items, items.findIndex(m => m.id === seedId), i => api.threadPeople(items[i].fields, OWN));
  return Object.fromEntries([...members].map(([i, how]) => [items[i].id, how]));
}

// Deterministic permutations: identity, reversed, and interleavings.
function orders(list) {
  const out = [list, [...list].reverse()];
  for (const step of [2, 3, 4, 7]) out.push(list.map((_, i) => list[(i * step) % list.length]).filter((v, i, a) => a.indexOf(v) === i));
  return out.filter(o => o.length === list.length);
}

describe('conversations (T1, T2)', () => {
  it('threadOf is the same for any order of the scanned messages', () => {
    const expected = membersOf(MAIL, 'chain5@alpha.test');
    assert.deepEqual(Object.keys(expected).sort(), ['chain1@alpha.test', 'chain2@bench.test', 'chain3@alpha.test', 'chain4@bench.test', 'chain5@alpha.test']);
    for (const order of orders(MAIL)) {
      for (const seed of Object.keys(expected)) assert.deepEqual(membersOf(order, seed), expected, seed);
    }
  });

  it('a reply without References joins by subject only with Re: and its author among the participants', () => {
    assert.deepEqual(membersOf(MAIL, 'noref1@gamma.test'), { 'noref1@gamma.test': 'references', 'noref2@bench.test': 'subject', 'noref3@gamma.test': 'subject' });
    assert.deepEqual(membersOf(MAIL, 'noref3@gamma.test'), { 'noref1@gamma.test': 'subject', 'noref2@bench.test': 'subject', 'noref3@gamma.test': 'references' });
    // The shared Cc is in both outreach mails; the reply's author only in one
    assert.deepEqual(membersOf(MAIL, 'outreach-b@bench.test'), { 'outreach-b@bench.test': 'references', 'outreach-b-reply@epsilon.test': 'subject' });
    assert.deepEqual(membersOf(MAIL, 'outreach-a@bench.test'), { 'outreach-a@bench.test': 'references', 'outreach-a-reply@delta.test': 'references' });
    assert.deepEqual(membersOf(MAIL, 'notify2@service.test'), { 'notify2@service.test': 'references' });
    for (const order of orders(MAIL)) assert.deepEqual(membersOf(order, 'outreach-b-reply@epsilon.test'), membersOf(MAIL, 'outreach-b-reply@epsilon.test'));
  });

  it('a copy of a message in another folder is the same message', () => {
    const copy = { ...MAIL[6] };
    const items = [...MAIL, copy];
    assert.deepEqual(Object.keys(membersOf(items, 'noref1@gamma.test')).sort(), ['noref1@gamma.test', 'noref2@bench.test', 'noref3@gamma.test']);
    const members = api.conversationMembers(items, 5, i => api.threadPeople(items[i].fields, OWN));
    assert.equal(members.get(items.length - 1), 'subject');
  });

  it('groupBy thread uses the same rules', () => {
    const groups = items => {
      const keys = api.threadKeysOf(items, i => api.threadPeople(items[i].fields, OWN));
      const byKey = new Map();
      items.forEach((m, i) => byKey.set(keys[i], [...(byKey.get(keys[i]) || []), m.id.split('@')[0]]));
      return [...byKey.values()].map(g => g.sort().join(' ')).sort();
    };
    const expected = ['chain1 chain2 chain3 chain4 chain5', 'noref1 noref2 noref3', 'notify1', 'notify2', 'notify3', 'outreach-a outreach-a-reply', 'outreach-b outreach-b-reply'];
    for (const order of orders(MAIL)) assert.deepEqual(groups(order), expected);
  });

  it('links many replies with one subject without rescanning earlier ones', () => {
    const n = 20000;
    const items = Array.from({ length: n }, (_, i) => ({ id: `<r${i}@bench.test>`, refs: [], dateTs: i, subjectKey: 'report', hasRe: i > 0 }));
    const peopleOf = i => ({ key: [`p${i % 2 ? i : 0}@x.test`], all: new Set([`p${i % 2 ? i : 0}@x.test`]) });
    const started = Date.now();
    const keys = api.threadKeysOf(items, peopleOf);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    assert.equal(keys[2], keys[0]);
    assert.notEqual(keys[1], keys[0]);
    assert.equal(api.conversationMembers(items, 4, peopleOf).size, n / 2);
  });
});

describe('legacySearchPage (format "legacy")', () => {
  const row = i => ({
    id: `m${i}`, subject: `Re: s${i}`, author: 'A <a@x.test>', recipients: 'me@x.test', ccList: '', date: '2026-03-01T00:00:00.000Z',
    folderPath: 'mailbox://x/Inbox', read: true, flagged: false, tags: [], preview: 'p'.repeat(300),
    _dateTs: i, _threadId: 7, _folderName: 'Inbox', _legacySubject: `s${i}`,
  });
  const rows = Array.from({ length: 3 }, (_, i) => row(i));

  it('returns a plain array of full rows without offset', () => {
    const page = plain(api.legacySearchPage(rows, { limit: 2 }));
    assert.equal(page.length, 2);
    assert.deepEqual(page[0], {
      id: 'm0', threadId: 7, subject: 's0', author: 'A <a@x.test>', recipients: 'me@x.test', ccList: '', date: '2026-03-01T00:00:00.000Z',
      folder: 'Inbox', folderPath: 'mailbox://x/Inbox', read: true, flagged: false, tags: [], preview: 'p'.repeat(300),
    });
  });

  it('returns the envelope when offset is passed, and keeps dupLocations and linkedBy', () => {
    const page = plain(api.legacySearchPage([{ ...row(0), dupLocations: ['mailbox://x/Sent'], linkedBy: 'subject' }, row(1)], { offset: 0, limit: 1, incomplete: true }));
    assert.deepEqual(Object.keys(page), ['messages', 'totalMatches', 'offset', 'limit', 'hasMore', 'incomplete']);
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.messages[0].dupLocations, ['mailbox://x/Sent']);
    assert.equal(page.messages[0].linkedBy, 'subject');
    assert.equal(plain(api.legacySearchPage(rows, { offset: 2, limit: 5 })).messages[0].id, 'm2');
  });
});

describe('buildSearchPage', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: String(i), subject: `s${i}`, folder: 'Inbox', _dateTs: i }));

  it('always returns the envelope with compact rows', () => {
    const p = plain(api.buildSearchPage(rows, { limit: 2 }));
    assert.deepEqual(p, { messages: [{ id: '0', subject: 's0' }, { id: '1', subject: 's1' }], totalMatches: 5, offset: 0, limit: 2, hasMore: true });
    const last = plain(api.buildSearchPage(rows, { offset: 4, limit: 2, incomplete: true }));
    assert.equal(last.hasMore, false);
    assert.equal(last.incomplete, true);
    assert.equal(last.messages.length, 1);
  });

  it('renders a table and names groups', () => {
    const t = plain(api.buildSearchPage(rows, { limit: 2, format: 'table' }));
    assert.deepEqual(t.messages.columns, ['id', 'subject']);
    const g = plain(api.buildSearchPage(rows, { limit: 2, key: 'groups' }));
    assert.equal(g.totalGroups, 5);
    assert.equal(g.groups.length, 2);
  });

  it('defaults search pages to 20 rows', () => {
    assert.equal(api.DEFAULT_SEARCH_RESULTS, 20);
  });
});

describe('body paging', () => {
  it('leaves short bodies untouched', () => {
    const r = plain(api.pageMessageBody({ id: '1', body: 'short' }, 0, undefined, 100));
    assert.deepEqual(r, { id: '1', body: 'short' });
  });

  it('pages a long body with nextBodyOffset', () => {
    const body = 'a'.repeat(25);
    const first = plain(api.pageMessageBody({ body }, 0, 10, 100));
    assert.deepEqual(first, { body: 'a'.repeat(10), bodyTotalChars: 25, bodyTruncated: true, nextBodyOffset: 10 });
    const last = plain(api.pageMessageBody({ body }, 20, 10, 100));
    assert.deepEqual(last, { body: 'a'.repeat(5), bodyTotalChars: 25, bodyOffset: 20 });
  });

  it('pages rawSource and passes errors through', () => {
    const r = plain(api.pageMessageBody({ rawSource: 'x'.repeat(30) }, 0, 10, 100));
    assert.equal(r.rawSource.length, 10);
    assert.equal(r.nextBodyOffset, 10);
    assert.deepEqual(plain(api.pageMessageBody({ error: 'nope' }, 0, 1, 1)), { error: 'nope' });
  });

  it('uses the default and clamps to MAX_BODY_CHARS', () => {
    const body = 'b'.repeat(api.MAX_BODY_CHARS + 10);
    assert.equal(api.pageMessageBody({ body }, 0, undefined, 50).body.length, 50);
    assert.equal(api.pageMessageBody({ body }, 0, api.MAX_BODY_CHARS * 2, 50).body.length, api.MAX_BODY_CHARS);
  });

  it('keeps base64 rawSource pages on 4-character groups', () => {
    const rawSource = Buffer.from('x'.repeat(100)).toString('base64');
    const first = plain(api.pageMessageBody({ rawSource, rawEncoding: 'base64' }, 0, 10, 100));
    assert.equal(first.rawSource.length, 8);
    assert.equal(first.nextBodyOffset, 8);
    const next = plain(api.pageMessageBody({ rawSource, rawEncoding: 'base64' }, 10, 3, 100));
    assert.equal(next.bodyOffset, 8);
    assert.equal(next.rawSource.length, 4);
    let joined = '';
    for (let offset = 0; offset !== undefined;) {
      const page = plain(api.pageMessageBody({ rawSource, rawEncoding: 'base64' }, offset, 30, 100));
      joined += Buffer.from(page.rawSource, 'base64').toString();
      offset = page.nextBodyOffset;
    }
    assert.equal(joined, 'x'.repeat(100));
  });

  it('does not split a surrogate pair', () => {
    const r = api.pageMessageBody({ body: 'abc\u{1F600}def' }, 0, 4, 100);
    assert.equal(r.body, 'abc');
    assert.equal(r.nextBodyOffset, 3);
  });
});
