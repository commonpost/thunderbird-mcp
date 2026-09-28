"use strict";
// Minimal Marionette client for the test bench: chrome-context scripts only.
// Protocol: "<len>:<json>" frames; commands [0, id, name, params], replies [1, id, error, result].
const net = require("node:net");

class Marionette {
  constructor(port, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  connect(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Marionette connect timed out")); }, timeoutMs);
      let hello = true;
      socket.on("data", chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (let msg; (msg = this.readFrame());) {
          if (hello) {
            hello = false;
            clearTimeout(timer);
            resolve(msg);
            continue;
          }
          const [, id, error, result] = msg;
          const p = this.pending.get(id);
          if (!p) continue;
          this.pending.delete(id);
          if (error) p.reject(Object.assign(new Error(`${error.error}: ${error.message}`), { stack: error.stacktrace || "" }));
          else p.resolve(result);
        }
      });
      socket.on("error", err => { clearTimeout(timer); reject(err); for (const p of this.pending.values()) p.reject(err); });
      socket.on("close", () => { for (const p of this.pending.values()) p.reject(new Error("Marionette connection closed")); this.pending.clear(); });
      this.socket = socket;
    });
  }

  readFrame() {
    const colon = this.buffer.indexOf(0x3a);
    if (colon < 0) return null;
    const len = Number(this.buffer.subarray(0, colon).toString());
    if (this.buffer.length < colon + 1 + len) return null;
    const json = this.buffer.subarray(colon + 1, colon + 1 + len).toString("utf8");
    this.buffer = this.buffer.subarray(colon + 1 + len);
    return JSON.parse(json);
  }

  send(name, params = {}) {
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify([0, id, name, params]), "utf8");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${body.length}:`);
      this.socket.write(body);
    });
  }

  async start(scriptTimeoutMs = 120000) {
    await this.connect();
    await this.send("WebDriver:NewSession", { capabilities: {} });
    await this.send("Marionette:SetContext", { value: "chrome" });
    await this.send("WebDriver:SetTimeouts", { script: scriptTimeoutMs });
    return this;
  }

  // Runs `source` as an async function body in the chrome window; `args` is available as `args`.
  async exec(source, args = {}) {
    const script = `return (async (args) => {\n${source}\n})(arguments[0]);`;
    const res = await this.send("WebDriver:ExecuteScript", { script, args: [args], newSandbox: false });
    return res && Object.prototype.hasOwnProperty.call(res, "value") ? res.value : res;
  }

  async quit() {
    try { await this.send("Marionette:Quit", { flags: ["eForceQuit"] }); } catch { /* process exits */ }
    this.close();
  }

  close() {
    try { this.socket.destroy(); } catch { /* already closed */ }
  }
}

module.exports = { Marionette };

// CLI: node test/bench/marionette.cjs <port> <script-file | -e source>
if (require.main === module) {
  const fs = require("node:fs");
  const [port, mode, arg] = process.argv.slice(2);
  const source = mode === "-e" ? arg : fs.readFileSync(mode, "utf8");
  (async () => {
    const m = await new Marionette(Number(port)).start();
    try {
      const value = await m.exec(source);
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    } finally {
      m.close();
    }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
