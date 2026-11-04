// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
'use strict';

// The bridge as a program: what it does with the lines it reads on stdin and how it decides it was started as the
// program. Each case runs the bridge in a child process, with an add-on stand-in where the line has to be forwarded.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const BRIDGE = path.resolve(__dirname, '..', 'mcp-bridge.cjs');
const TOKEN = 'd'.repeat(64);

async function startAddon(t, answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body);
      requests.push(message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer(message)));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { port: server.address().port, requests };
}

function connectionFile(t, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-stdio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'connection.json');
  fs.writeFileSync(file, JSON.stringify({ port, token: TOKEN, pid: process.pid }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

// A running bridge: `lines()` resolves with the lines it has written once it has exited.
function runBridge(t, file, { stdin, delayReadMs = 0 } = {}) {
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, COMMONPOST_MCP_CONNECTION_FILE: file },
  });
  t.after(() => { child.kill(); });
  let out = '';
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.stdout.setEncoding('utf8');
  if (delayReadMs > 0) {
    child.stdout.pause();
    setTimeout(() => { child.stdout.on('data', (chunk) => { out += chunk; }); child.stdout.resume(); }, delayReadMs);
  } else {
    child.stdout.on('data', (chunk) => { out += chunk; });
  }
  const exited = new Promise((resolve) => { child.on('close', (code) => resolve(code)); });
  if (stdin !== undefined) child.stdin.end(stdin);
  return {
    child,
    finish: async () => ({ code: await exited, lines: out.split('\n').filter(Boolean), stderr: err }),
  };
}

const rpc = (message) => `${JSON.stringify(message)}\n`;

describe('the bridge reading stdin', () => {
  it('ignores blank lines and answers the lines around them, in order', async (t) => {
    const bridge = runBridge(t, '/nonexistent/connection.json', {
      stdin: `\n   \n${rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })}\r\n\t\n${rpc({ jsonrpc: '2.0', id: 2, method: 'ping' })}`,
    });
    const { code, lines } = await bridge.finish();
    assert.equal(code, 0);
    assert.deepEqual(lines.map((l) => JSON.parse(l).id), [1, 2]);
  });

  it('answers a last line that has no newline once stdin ends, then exits', async (t) => {
    const bridge = runBridge(t, '/nonexistent/connection.json', { stdin: JSON.stringify({ jsonrpc: '2.0', id: 'last', method: 'ping' }) });
    const { code, lines } = await bridge.finish();
    assert.equal(code, 0);
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ jsonrpc: '2.0', id: 'last', result: {} }]);
  });

  it('answers a line that is not JSON with a parse error that has no id', async (t) => {
    const bridge = runBridge(t, '/nonexistent/connection.json', { stdin: '{ this is not json\n' });
    const { lines } = await bridge.finish();
    const answer = JSON.parse(lines[0]);
    assert.equal(answer.id, null);
    assert.equal(answer.error.code, -32700);
    assert.match(answer.error.message, /^Bridge error: /);
  });

  it('forwards a message with an id and no method (a client answering the server) to the add-on', async (t) => {
    const addon = await startAddon(t, (message) => ({ jsonrpc: '2.0', id: message.id, result: { echoed: true } }));
    const bridge = runBridge(t, connectionFile(t, addon.port), { stdin: rpc({ jsonrpc: '2.0', id: 'client-answer', result: { roots: [] } }) });
    const { lines } = await bridge.finish();
    assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 'client-answer', result: { echoed: true } });
    assert.equal(addon.requests[0].result.roots.length, 0);
  });

  it('writes an answer larger than the pipe buffer in full when the reader is slow', async (t) => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const addon = await startAddon(t, (message) => ({ jsonrpc: '2.0', id: message.id, result: { tools: [], padding: big } }));
    const bridge = runBridge(t, connectionFile(t, addon.port), {
      stdin: rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + rpc({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      delayReadMs: 400,
    });
    const { code, lines } = await bridge.finish();
    assert.equal(code, 0);
    const answers = lines.map((l) => JSON.parse(l));
    assert.deepEqual(answers.map((a) => a.id).sort(), [1, 2]);
    assert.equal(answers.find((a) => a.id === 1).result.padding.length, big.length);
  });
});

describe('when the bridge starts as the program', () => {
  const load = (script, { cwd } = {}) => spawnSync(process.execPath, ['-e', script], { cwd, encoding: 'utf8', input: '', timeout: 15000 });

  it('starts when a host loads it with argv[1] naming the file, also when the platform is Windows (paths compared in lower case)', () => {
    const script = `
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.argv[1] = ${JSON.stringify(BRIDGE)};
      require(${JSON.stringify(BRIDGE)});
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { jsonrpc: '2.0', id: 1, result: {} });
  });

  it('does not start, and does not fail, when argv[1] names nothing that exists', () => {
    const script = `
      process.argv[1] = ${JSON.stringify(path.join(os.tmpdir(), 'cp-no-such-entry-point.js'))};
      const bridge = require(${JSON.stringify(BRIDGE)});
      process.stdout.write(typeof bridge.startBridge);
    `;
    const result = load(script);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'function');
  });

  it('does not start when argv[1] is empty or missing', () => {
    for (const value of ["''", 'undefined']) {
      const script = `
        process.argv[1] = ${value};
        const bridge = require(${JSON.stringify(BRIDGE)});
        process.stdout.write(typeof bridge.startBridge);
      `;
      const result = load(script);
      assert.equal(result.status, 0, `${value}: ${result.stderr}`);
      assert.equal(result.stdout, 'function', value);
    }
  });
});
