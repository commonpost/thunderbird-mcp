/**
 * What an agent benchmark found: answers that left the caller without what it needed to go on.
 * Empty search hint, recipients without an address, the path of a renamed folder.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');
function snippet(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `marker missing: ${name}`);
  return source.slice(start, end);
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${snippet('MESSAGE SEARCH HELPERS')}\n${snippet('COMPOSE HELPERS')}
this.api = { parseSearchQuery, emptySearchHint, withEmptySearchHint, recipientsWithoutAddress, withRecipientWarning };`, sandbox);
const api = sandbox.api;
const plain = v => JSON.parse(JSON.stringify(v));

describe('empty search hint', () => {
  it('says that one leading operator took every word', () => {
    const parsed = api.parseSearchQuery('from:Carol training room budget');
    assert.equal(parsed.allInOperator, 'from');
    assert.equal(parsed.terms.length, 4);
    const hint = api.emptySearchHint(parsed);
    assert.match(hint, /all 4 words were searched in from: only/);
    assert.match(hint, /"other words from:value"/);
  });

  it('says that every word must match as written', () => {
    const hint = api.emptySearchHint(api.parseSearchQuery('card expiring'));
    assert.match(hint, /Every word must match as written/);
    assert.equal(api.parseSearchQuery('card expiring').allInOperator, undefined);
    assert.equal(api.parseSearchQuery('budget from:carol').allInOperator, undefined);
  });

  it('has nothing to say about no word or one word', () => {
    assert.equal(api.emptySearchHint(api.parseSearchQuery('')), null);
    assert.equal(api.emptySearchHint(api.parseSearchQuery('invoice')), null);
    assert.equal(api.emptySearchHint(api.parseSearchQuery('from:carol')), null);
    assert.equal(api.emptySearchHint(null), null);
  });

  it('is added to an empty envelope or count only', () => {
    const parsed = api.parseSearchQuery('card expiring');
    const empty = { messages: [], totalMatches: 0, offset: 0, limit: 20, hasMore: false };
    assert.equal(typeof api.withEmptySearchHint(empty, parsed).hint, 'string');
    assert.deepEqual(plain(api.withEmptySearchHint(empty, parsed).messages), []);
    assert.equal(typeof api.withEmptySearchHint({ count: 0 }, parsed).hint, 'string');
    const found = { messages: [{ id: 'a' }], totalMatches: 1, offset: 0, limit: 20, hasMore: false };
    assert.equal(api.withEmptySearchHint(found, parsed), found);
    assert.equal(api.withEmptySearchHint({ count: 3 }, parsed).hint, undefined);
    const error = { error: 'Folder not found: x' };
    assert.equal(api.withEmptySearchHint(error, parsed), error);
    const legacy = [];
    assert.equal(api.withEmptySearchHint(legacy, parsed), legacy);
    assert.equal(api.withEmptySearchHint(empty, api.parseSearchQuery('invoice')), empty);
  });

  it('is what the header search returns through', () => {
    assert.match(source, /return withEmptySearchHint\(finishSearch\(rows, args, prepared, incomplete\), parsedQuery\);/);
  });
});

describe('recipients without an address', () => {
  it('finds an entry that is only a name', () => {
    assert.deepEqual(plain(api.recipientsWithoutAddress('Frank Osei')), ['Frank Osei']);
    assert.deepEqual(plain(api.recipientsWithoutAddress('a@example.org, Frank Osei', undefined, 'Erin; b@example.org')), ['Frank Osei', 'Erin']);
  });

  it('accepts addresses in every usual form', () => {
    assert.deepEqual(plain(api.recipientsWithoutAddress('a@example.org', 'Frank Osei <frank@ledger.example>', '"Osei, Frank" <frank@ledger.example>')), []);
    assert.deepEqual(plain(api.recipientsWithoutAddress('', undefined, null, 42)), []);
    assert.deepEqual(plain(api.recipientsWithoutAddress('a@example.org, , b@example.org,')), []);
  });

  it('bounds what it reports', () => {
    const many = api.recipientsWithoutAddress(Array.from({ length: 30 }, (_, i) => `name${i}`).join(', '));
    assert.equal(many.length, 5);
    const long = api.recipientsWithoutAddress('x'.repeat(5000));
    assert.equal(long[0].length, 83);
  });

  it('stays fast on a long header', () => {
    const t = Date.now();
    api.recipientsWithoutAddress(`${'"'.repeat(100001)}${'<'.repeat(100000)}${','.repeat(100000)}`);
    assert.ok(Date.now() - t < 1000);
  });

  it('adds a warning to a result that succeeded, and the likely cause to an error', () => {
    const ok = { success: true, message: 'Forward draft saved' };
    const warned = api.withRecipientWarning(ok, 'Frank Osei', undefined, undefined);
    assert.equal(warned.success, true);
    assert.match(warned.warning, /No e-mail address in: "Frank Osei"\./);
    assert.match(warned.warning, /searchContacts, then searchMessages/);
    assert.equal(api.withRecipientWarning(ok, 'frank@ledger.example', undefined, undefined), ok);
    const error = { error: 'Send failed (status: 0x80004005)' };
    assert.match(api.withRecipientWarning(error, 'Frank Osei').error, /^Send failed \(status: 0x80004005\) No e-mail address in: "Frank Osei"\./);
    assert.equal(api.withRecipientWarning(error, 'Frank Osei').warning, undefined);
    assert.equal(api.withRecipientWarning(error, 'frank@ledger.example'), error);
    assert.match(api.withRecipientWarning({ success: true, warning: 'Earlier note.' }, 'Frank Osei').warning, /^Earlier note\. No e-mail address in/);
  });

  it('covers the four compose tools, draft edits included', () => {
    const cases = source.slice(source.indexOf('case "sendMail":'), source.indexOf('case "getRecentMessages":'));
    assert.equal((cases.match(/return withRecipientWarning\(await /g) || []).length, 5);
    assert.equal((cases.match(/return await /g) || []).length, 0);
  });
});

describe('renameFolder', () => {
  it('returns the new path next to the old one', () => {
    const body = source.slice(source.indexOf('function renameFolder('), source.indexOf('function deleteFolder('));
    assert.match(body, /const parent = folder\.parent;\s+folder\.rename\(newName, null\);/);
    assert.match(body, /oldPath: folderPath,\s+path: newPath,/);
    assert.match(body, /Its URI changed: use \$\{newPath\} from now on\./);
  });
});
