"use strict";
// Packs test/fixtures/mail/<Folder>/*.eml into <mailDir>/<Folder> mbox files (bytes kept as is).
// Usage: node test/bench/pack-mbox.cjs <fixturesDir> <mailDir>
const fs = require("node:fs");
const path = require("node:path");

function toMboxEntry(eml) {
  const text = eml.toString("latin1").replace(/\r\n/g, "\n");
  const escaped = text.replace(/^(>*From )/gm, ">$1");
  return Buffer.from(`From - Mon Mar  2 00:00:00 2026\n${escaped}${escaped.endsWith("\n") ? "" : "\n"}\n`, "latin1");
}

function packFolders(fixturesDir, mailDir) {
  const counts = {};
  fs.mkdirSync(mailDir, { recursive: true });
  for (const entry of fs.readdirSync(fixturesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = fs.readdirSync(path.join(fixturesDir, entry.name)).filter(f => f.endsWith(".eml")).sort();
    const parts = files.map(f => toMboxEntry(fs.readFileSync(path.join(fixturesDir, entry.name, f))));
    fs.writeFileSync(path.join(mailDir, entry.name), Buffer.concat(parts));
    counts[entry.name] = files.length;
  }
  return counts;
}

module.exports = { packFolders, toMboxEntry };

if (require.main === module) {
  const [fixturesDir, mailDir] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(packFolders(fixturesDir, mailDir))}\n`);
}
