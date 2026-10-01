'use strict';

// The bridge starts when it is the program, and when a host such as the
// built-in Node.js of Claude Desktop sets process.argv[1] to it and loads it
// with import(); a require() does not start it.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BRIDGE = path.resolve(__dirname, '..', 'mcp-bridge.cjs');
const VERSION = /^const BRIDGE_VERSION = '([^']*)';$/m.exec(fs.readFileSync(BRIDGE, 'utf8'))[1];
const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
}) + '\n';

let dir;
let copyDir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-host-'));
  copyDir = path.join(dir, 'copy');
  fs.mkdirSync(path.join(copyDir, 'sub'), { recursive: true });
  fs.copyFileSync(BRIDGE, path.join(copyDir, 'mcp-bridge.cjs'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Writes a host script like nodeHost; argvEntry is what it puts in argv[1].
function writeHost(name, entry, argvEntry) {
  const file = path.join(dir, name);
  const lines = [`import { pathToFileURL } from 'node:url';`];
  if (argvEntry !== null) {
    lines.push(`process.argv = ['node', ${JSON.stringify(argvEntry)}];`);
  }
  lines.push(`await import(pathToFileURL(${JSON.stringify(entry)}).toString());`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// Runs node with args, feeds stdin and returns stdout once the process ends
// or after waitMs (then it is killed and exited is false).
function run(args, stdin, waitMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let exited = false;
    let timer;
    const finish = () => {
      clearTimeout(timer);
      resolve({ out, exited });
    };
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) {
        child.kill();
      }
    });
    child.on('close', () => {
      exited = true;
      finish();
    });
    timer = setTimeout(() => {
      child.kill();
    }, waitMs);
    child.stdin.on('error', () => {});
    child.stdin.write(stdin);
    if (!stdin.includes('"id":0') || args[0] === '-e') {
      child.stdin.end();
    }
  });
}

function assertInitialized(out) {
  const response = JSON.parse(out.split('\n').find((l) => l.trim()));
  assert.equal(response.id, 0);
  assert.equal(response.result.serverInfo.name, 'commonpost-mcp');
  assert.equal(response.result.serverInfo.version, VERSION);
}

describe('bridge entry point under a host script', () => {
  it('answers initialize when a host sets argv[1] and loads it with import()', async () => {
    const host = writeHost('host.mjs', BRIDGE, BRIDGE);
    const { out } = await run([host], INIT, 4000);
    assertInitialized(out);
  });

  it('recognises a copy named with mixed separators or ".." after resolution', async () => {
    const copy = path.join(copyDir, 'mcp-bridge.cjs');
    const odd = [copyDir, 'sub', '..', '.', 'mcp-bridge.cjs'].join('/').replace(/\/sub\//, path.sep + 'sub' + path.sep);
    const host = writeHost('host-odd.mjs', copy, odd);
    const { out } = await run([host], INIT, 4000);
    assertInitialized(out);
  });

  it('does not start on a plain require()', async () => {
    const { out, exited } = await run(['-e', `require(${JSON.stringify(BRIDGE)})`], INIT, 4000);
    assert.equal(out, '');
    assert.equal(exited, true);
  });

  it('does not start when a host imports it without rewriting argv', async () => {
    const host = writeHost('host-plain.mjs', BRIDGE, null);
    const { out, exited } = await run([host], INIT, 3000);
    assert.equal(out, '');
    assert.equal(exited, true);
  });
});
