'use strict';

// The bridge waits longer than Thunderbird's own 120 s send timeout for tools
// that can send mail directly, and says so when that wait runs out.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  isDirectSendCall,
  requestOptionsFor,
  requestTimeouts,
  tryRequest,
} = require('../mcp-bridge.cjs');

const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

describe('direct-send timeout selection', () => {
  it('outlasts the 120 s send timeout of Thunderbird and leaves the default at 30 s', () => {
    assert.equal(requestTimeouts.REQUEST_TIMEOUT, 30000);
    assert.equal(requestTimeouts.DIRECT_SEND_TIMEOUT, 150000);
    assert.ok(requestTimeouts.DIRECT_SEND_TIMEOUT > 120000);
  });

  it('uses 150 s for sendMail, replyToMessage and forwardMessage with skipReview', () => {
    for (const name of ['sendMail', 'replyToMessage', 'forwardMessage']) {
      const message = call(name, { skipReview: true });
      assert.equal(isDirectSendCall(message), true, name);
      assert.deepEqual(requestOptionsFor(message), { timeoutMs: 150000, directSend: true });
    }
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
