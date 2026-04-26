import { deflateRawSync } from 'node:zlib';

/**
 * RFC 0002 PR-3 — minimal ZIP writer (deflate-only, no streaming).
 *
 * We deliberately don't pull in `archiver` / `jszip` for one feature: the
 * file count is small (≤ 10 JSON entries + a README), the content is
 * text, and deflate is in `node:zlib` already. This implementation
 * produces a fully spec-compliant ZIP that opens in macOS Finder, Windows
 * Explorer, and `unzip` on every Linux distro we care about.
 *
 * Layout written:
 *
 *   [LFH][file 1 data]
 *   [LFH][file 2 data]
 *   ...
 *   [CDH 1]
 *   [CDH 2]
 *   ...
 *   [EOCD]
 *
 * Spec reference: APPNOTE.TXT 6.3.3 (PKWARE).
 */

interface ZipEntry {
  name: string;
  body: Buffer;
}

export function makeZip(entries: readonly ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  const writtenAt: number[] = [];

  for (const entry of entries) {
    const utf8Name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.body);
    const uncompressedSize = entry.body.length;
    const compressed = deflateRawSync(entry.body);
    const compressedSize = compressed.length;
    // DOS time/date — not strictly required for compatibility, fixed
    // value keeps zips byte-stable across runs (good for content hashing
    // / golden snapshots in tests).
    const dosTime = 0;
    const dosDate = (2026 - 1980) << 9; // Jan 1 of arbitrary year

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // general purpose bit flag (UTF-8)
    lfh.writeUInt16LE(8, 8); // compression method = deflate
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressedSize, 18);
    lfh.writeUInt32LE(uncompressedSize, 22);
    lfh.writeUInt16LE(utf8Name.length, 26);
    lfh.writeUInt16LE(0, 28); // extra field length
    localChunks.push(lfh, utf8Name, compressed);
    writtenAt.push(offset);
    offset += 30 + utf8Name.length + compressedSize;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8); // gp flag (UTF-8)
    cdh.writeUInt16LE(8, 10); // method
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compressedSize, 20);
    cdh.writeUInt32LE(uncompressedSize, 24);
    cdh.writeUInt16LE(utf8Name.length, 28);
    cdh.writeUInt16LE(0, 30); // extra field length
    cdh.writeUInt16LE(0, 32); // file comment length
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal file attrs
    cdh.writeUInt32LE(0, 38); // external file attrs
    cdh.writeUInt32LE(writtenAt[writtenAt.length - 1]!, 42); // local header offset
    centralChunks.push(cdh, utf8Name);
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralChunks);
  const centralSize = centralBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk where central dir starts
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

// ─── CRC-32 (zlib polynomial) ──────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}
