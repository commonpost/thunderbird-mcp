'use strict';

// The bridge waits longer than Thunderbird's own 120 s send timeout for tools
// that can send mail directly, and says so when that wait runs out.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const {
  forwardFailureResponse,
  isDirectSendCall,
  requestOptionsFor,
  requestTimeouts,
  tryRequest,
} = require('../mcp-bridge.cjs');

const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

describe('direct-send timeout selection', () => {
  it('outlasts the 120 s send timeout of Thunderbird and leaves the default at 30 s', () => {
    assert.equal(requestTimeouts.REQUEST_TIMEOUT, 30000);
    assert.equal(requestTimeouts.DIRECT_SEND_TIMEOUT, 180000);
    assert.ok(requestTimeouts.DIRECT_SEND_TIMEOUT > 120000);
  });

  it('outlasts every wait of the add-on on the way to a send or a saved draft, added up', () => {
    // A reply or a forward can go through all of them one after the other: the folder summary, the original
    // message, its quote, then the send or the save. A bridge that gives up first reports a failure for a
    // message that may still go out, or for a draft that is still saved.
    const api = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'extension', 'mcp_server', 'api.js'), 'utf8');
    const ms = (name) => {
      const found = [...api.matchAll(new RegExp(`const ${name} = (\\d+);`, 'g'))];
      assert.equal(found.length, 1, `${name}: ${found.length} definitions`);
      return Number(found[0][1]);
    };
    const before = ms('FOLDER_SUMMARY_REBUILD_TIMEOUT_MS') + ms('MIME_LOAD_TIMEOUT_MS') + ms('QUOTE_TIMEOUT_MS');
    const last = Math.max(ms('SEND_TIMEOUT_MS'), ms('DRAFT_SAVE_TIMEOUT_MS'));
    assert.equal(before + last, 175000);
    assert.ok(requestTimeouts.DIRECT_SEND_TIMEOUT > before + last, `${requestTimeouts.DIRECT_SEND_TIMEOUT} <= ${before + last}`);
  });

  it('uses 180 s for sendMail, replyToMessage and forwardMessage with skipReview', () => {
    for (const name of ['sendMail', 'replyToMessage', 'forwardMessage']) {
      const message = call(name, { skipReview: true });
      assert.equal(isDirectSendCall(message), true, name);
      assert.deepEqual(requestOptionsFor(message), { timeoutMs: 180000, directSend: true });
    }
  });

  it('uses 180 s for replyToMessage and forwardMessage with mode send', () => {
    for (const name of ['replyToMessage', 'forwardMessage']) {
      for (const args of [{ mode: 'send' }, { mode: 'send', skipReview: false }]) {
        const message = call(name, args);
        assert.equal(isDirectSendCall(message), true, `${name} ${JSON.stringify(args)}`);
        assert.deepEqual(requestOptionsFor(message), { timeoutMs: 180000, directSend: true });
      }
    }
  });

  it('classifies the mode cautiously: trimmed and lower-cased, so a spelling the extension refuses still counts as a send', () => {
    // The extension rejects "SEND" through its enum; the bridge only decides how long to wait and what to tell, and
    // missing a send would cost the 180 s wait, the silence about versions and the "outcome unknown" error
    for (const mode of ['send', 'SEND', 'Send', ' send ', '\tSEND\n']) {
      for (const name of ['replyToMessage', 'forwardMessage']) {
        const message = call(name, { mode });
        assert.equal(isDirectSendCall(message), true, `${name} ${JSON.stringify(mode)}`);
        assert.deepEqual(requestOptionsFor(message), { timeoutMs: 180000, directSend: true });
      }
    }
    for (const mode of ['sendx', 'se nd', '', 'window', 'draft', 1, true, ['send'], null, {}]) {
      assert.equal(isDirectSendCall(call('replyToMessage', { mode })), false, JSON.stringify(mode));
    }
  });

  it('does not change what is sent to the extension', () => {
    const message = call('replyToMessage', { mode: ' SEND ', to: 'a@example.com' });
    const before = JSON.stringify(message);
    isDirectSendCall(message);
    requestOptionsFor(message);
    assert.equal(JSON.stringify(message), before);
  });

  it('treats any truthy skipReview as a possible direct send, like the extension does', () => {
    assert.equal(isDirectSendCall(call('sendMail', { skipReview: 'false' })), true);
  });

  it('keeps 30 s when the message cannot send directly', () => {
    const plain = { timeoutMs: 30000, directSend: false };
    for (const message of [
      call('sendMail', {}),
      call('sendMail', { skipReview: false }),
      call('sendMail', undefined),
      call('replyToMessage', { skipReview: 0 }),
      call('forwardMessage', { mode: 'window' }),
      call('searchMessages', { mode: 'send' }),
      call('searchMessages', { skipReview: true }),
      call('createEvent', { skipReview: true }),
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call' },
      null,
    ]) {
      assert.equal(isDirectSendCall(message), false, JSON.stringify(message));
      assert.deepEqual(requestOptionsFor(message), plain, JSON.stringify(message));
    }
  });
});

describe('draft timeout selection', () => {
  it('waits 180 s for replyToMessage and forwardMessage with mode draft, as for a direct send, but not as a send', () => {
    for (const name of ['replyToMessage', 'forwardMessage']) {
      for (const mode of ['draft', 'DRAFT', ' draft ']) {
        const message = call(name, { mode });
        assert.equal(isDirectSendCall(message), false, `${name} ${mode}`);
        assert.deepEqual(requestOptionsFor(message), { timeoutMs: 180000, directSend: false, draft: true }, `${name} ${mode}`);
      }
    }
  });

  it('counts a call that may also send as a send, not as a draft', () => {
    const message = call('replyToMessage', { mode: 'draft', skipReview: true });
    assert.deepEqual(requestOptionsFor(message), { timeoutMs: 180000, directSend: true });
  });

  it('waits 180 s for saveDraft, whatever its arguments: Thunderbird can take 120 s to save it', () => {
    for (const args of [{}, undefined, { to: 'a@example.com', subject: 's', body: 'b' }, { mode: 'window' }, { skipReview: true }]) {
      const message = call('saveDraft', args);
      assert.equal(isDirectSendCall(message), false, JSON.stringify(args));
      assert.deepEqual(requestOptionsFor(message), { timeoutMs: 180000, directSend: false, draft: true }, JSON.stringify(args));
    }
  });

  it('keeps 30 s for the other tools and modes', () => {
    const plain = { timeoutMs: 30000, directSend: false };
    for (const message of [
      call('replyToMessage', { mode: 'window' }),
      call('replyToMessage', {}),
      call('sendMail', { mode: 'draft' }),
      call('searchMessages', { mode: 'draft' }),
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { name: 'saveDraft' } },
    ]) {
      assert.deepEqual(requestOptionsFor(message), plain, JSON.stringify(message));
    }
  });

  it('says in the failure response that the draft may still appear, once', () => {
    const error = new Error('Request to Thunderbird timed out after 180 s while saving a draft. The draft may still appear in the Drafts folder later: check it before retrying, otherwise a second draft may be created.');
    for (const message of [call('replyToMessage', { mode: 'draft' }), call('saveDraft', { subject: 's' })]) {
      const text = JSON.parse(forwardFailureResponse(message, error).result.content[0].text).error;
      assert.equal(text, error.message);
      assert.ok(!/may still complete/.test(text));
    }
  });
});

describe('timeout error', () => {
  function silentServer() {
    return new Promise((resolve) => {
      const server = http.createServer(() => { /* never answers */ });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  it('says the outcome is unknown and to check Sent/Outbox for a direct send', async () => {
    const server = await silentServer();
    try {
      await assert.rejects(
        tryRequest('127.0.0.1', '{}', server.address().port, 'a'.repeat(64), { timeoutMs: 50, directSend: true }),
        (err) => /timed out after 0\.05 s/.test(err.message)
          && /UNKNOWN/.test(err.message)
          && /Sent/.test(err.message)
          && /Outbox/.test(err.message)
          && /before retrying/.test(err.message)
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('says the draft may still appear, and not that a message may have been sent, for a draft', async () => {
    const server = await silentServer();
    try {
      await assert.rejects(
        tryRequest('127.0.0.1', '{}', server.address().port, 'a'.repeat(64), { timeoutMs: 50, directSend: false, draft: true }),
        (err) => /timed out after 0\.05 s while saving a draft/.test(err.message)
          && /may still appear in the Drafts folder later/.test(err.message)
          && /before retrying/.test(err.message)
          && !/UNKNOWN|Outbox/.test(err.message)
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('keeps the plain message for every other call', async () => {
    const server = await silentServer();
    try {
      await assert.rejects(
        tryRequest('127.0.0.1', '{}', server.address().port, 'a'.repeat(64), { timeoutMs: 50, directSend: false }),
        { message: 'Request to Thunderbird timed out' }
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('connection lost during a direct send', () => {
  const TOKEN = 'a'.repeat(64);
  const direct = { timeoutMs: 5000, directSend: true };
  const plain = { timeoutMs: 5000, directSend: false };

  function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  function isUnknownOutcome(err) {
    return /UNKNOWN/.test(err.message)
      && /Sent folder and the Outbox/.test(err.message)
      && /before retrying/.test(err.message);
  }

  // Answers with the given status line and headers, then cuts the connection.
  function rawServer(onRequest) {
    return listen(net.createServer((socket) => {
      socket.on('error', () => {});
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk.toString('latin1');
        if (received.includes('\r\n\r\n') && received.endsWith('}')) onRequest(socket);
      });
    }));
  }

  it('reports an unknown outcome when the socket is closed after the request was written', async () => {
    const server = await rawServer((socket) => socket.destroy());
    try {
      await assert.rejects(
        tryRequest('127.0.0.1', '{"a":1}', server.address().port, TOKEN, direct),
        (err) => isUnknownOutcome(err) && /lost/.test(err.message) && err.cause instanceof Error
      );
    } finally {
      server.close();
    }
  });

  it('reports an unknown outcome when the connection drops in the middle of the response', async () => {
    const server = await rawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"jsonrpc":');
      setTimeout(() => socket.destroy(), 20);
    });
    try {
      await assert.rejects(
        tryRequest('127.0.0.1', '{"a":1}', server.address().port, TOKEN, direct),
        (err) => isUnknownOutcome(err) && err.cause instanceof Error
      );
    } finally {
      server.close();
    }
  });

  it('does not change the error of a call that is not a direct send', async () => {
    const server = await rawServer((socket) => socket.destroy());
    try {
      await assert.rejects(
        tryRequest('127.0.0.1', '{"a":1}', server.address().port, TOKEN, plain),
        (err) => !isUnknownOutcome(err) && /socket hang up|ECONNRESET/.test(`${err.code} ${err.message}`)
      );
    } finally {
      server.close();
    }
  });

  it('keeps the connection-refused error unchanged, so it stays retryable', async () => {
    const probe = await listen(net.createServer());
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    await assert.rejects(
      tryRequest('127.0.0.1', '{}', port, TOKEN, direct),
      (err) => err.code === 'ECONNREFUSED' && !isUnknownOutcome(err)
    );
  });

  it('keeps the 403 error unchanged, and a complete answer still resolves', async () => {
    const forbidden = await listen(http.createServer((req, res) => { res.statusCode = 403; res.end('no'); }));
    try {
      await assert.rejects(
        tryRequest('127.0.0.1', '{}', forbidden.address().port, TOKEN, direct),
        (err) => err.statusCode === 403 && !isUnknownOutcome(err)
      );
    } finally {
      forbidden.close();
    }
    const ok = await listen(http.createServer((req, res) => { res.end('{"jsonrpc":"2.0","id":1,"result":{}}'); }));
    try {
      assert.deepEqual(
        await tryRequest('127.0.0.1', '{}', ok.address().port, TOKEN, direct),
        { jsonrpc: '2.0', id: 1, result: {} }
      );
    } finally {
      ok.close();
    }
  });
});

describe('tool result for a failed forward', () => {
  async function timeoutFrom(message) {
    const server = await new Promise((resolve) => {
      const s = http.createServer(() => { /* never answers */ });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const options = { ...requestOptionsFor(message), timeoutMs: 50 };
      return await tryRequest('127.0.0.1', '{}', server.address().port, 'a'.repeat(64), options).then(
        () => assert.fail('expected a timeout'), (err) => err);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }
  const errorText = (response) => JSON.parse(response.result.content[0].text).error;

  it('adds that the operation may still complete to an ordinary timeout', async () => {
    const message = call('searchMessages', { query: 'x' });
    const response = forwardFailureResponse(message, await timeoutFrom(message));
    assert.equal(response.id, 1);
    assert.equal(response.result.isError, true);
    assert.equal(errorText(response), 'Request to Thunderbird timed out. The operation may still complete in Thunderbird.');
  });

  it('keeps only the outcome-unknown advice for a direct send', async () => {
    const message = call('sendMail', { skipReview: true });
    const text = errorText(forwardFailureResponse(message, await timeoutFrom(message)));
    assert.match(text, /outcome is UNKNOWN/);
    assert.doesNotMatch(text, /may still complete/);
  });

  it('passes other failures through unchanged', () => {
    const response = forwardFailureResponse(call('sendMail', {}), new Error('Connection failed: connect ECONNREFUSED'));
    assert.equal(errorText(response), 'Connection failed: connect ECONNREFUSED');
  });
});
