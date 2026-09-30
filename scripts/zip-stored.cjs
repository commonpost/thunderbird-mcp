'use strict';

/**
 * Deterministic ZIP writer shared by the reproducible build scripts
 * (build-xpi-reproducible.cjs, build-mcpb-reproducible.cjs).
 *
 * Entries are STORED (no compression), with a fixed DOS time of 1980-01-01 00:00, no extra fields, no comments
 * and fixed attributes, so the bytes depend only on the names and contents given, in the order given.
 */

// ---- CRC-32 (IEEE) -------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- deterministic ZIP (stored) -------------------------------------------
const DOS_TIME = 0;          // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(10, 4);          // version needed: 1.0 (stored)
    lh.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
    lh.writeUInt16LE(0, 8);           // method: stored
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(10, 4);          // version made by: MS-DOS, 1.0
    ch.writeUInt16LE(10, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attrs
    ch.writeUInt32LE(0, 38);          // external attrs
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, eocd]);
}

module.exports = { crc32, buildZip };
