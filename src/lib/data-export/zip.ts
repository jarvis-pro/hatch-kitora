import { deflateRawSync } from 'node:zlib';

/**
 * RFC 0002 PR-3 — 最小 ZIP 写入器（仅 deflate，无流）。
 *
 * 我们故意不为一个功能引入 `archiver` / `jszip`：文件数很小
 * （≤ 10 个 JSON 条目 + README），内容是文本，deflate 已在
 * `node:zlib` 中。此实现产生完全符合规范的 ZIP，
 * 在 macOS Finder、Windows 资源管理器和我们关心的每个
 * Linux 发行版上的 `unzip` 中打开。
 *
 * 布局已写入：
 *
 *   [LFH][file 1 data]
 *   [LFH][file 2 data]
 *   ...
 *   [CDH 1]
 *   [CDH 2]
 *   ...
 *   [EOCD]
 *
 * 规范参考：APPNOTE.TXT 6.3.3 (PKWARE)。
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
    // DOS 时间/日期 — 对兼容性来说不是严格必需的，
    // 固定值使 zip 在运行中保持字节稳定
    // （对内容散列/测试中的黄金快照有好处）。
    const dosTime = 0;
    const dosDate = (2026 - 1980) << 9; // 任意年份的 1 月 1 日

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    lfh.writeUInt16LE(20, 4); // 需要的版本
    lfh.writeUInt16LE(0x0800, 6); // 通用目标位标志 (UTF-8)
    lfh.writeUInt16LE(8, 8); // 压缩方法 = deflate
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressedSize, 18);
    lfh.writeUInt32LE(uncompressedSize, 22);
    lfh.writeUInt16LE(utf8Name.length, 26);
    lfh.writeUInt16LE(0, 28); // 额外字段长度
    localChunks.push(lfh, utf8Name, compressed);
    writtenAt.push(offset);
    offset += 30 + utf8Name.length + compressedSize;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
    cdh.writeUInt16LE(20, 4); // 由以下版本制作
    cdh.writeUInt16LE(20, 6); // 需要的版本
    cdh.writeUInt16LE(0x0800, 8); // gp flag (UTF-8)
    cdh.writeUInt16LE(8, 10); // 方法
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compressedSize, 20);
    cdh.writeUInt32LE(uncompressedSize, 24);
    cdh.writeUInt16LE(utf8Name.length, 28);
    cdh.writeUInt16LE(0, 30); // 额外字段长度
    cdh.writeUInt16LE(0, 32); // 文件注释长度
    cdh.writeUInt16LE(0, 34); // 磁盘号开始
    cdh.writeUInt16LE(0, 36); // 内部文件属性
    cdh.writeUInt32LE(0, 38); // 外部文件属性
    cdh.writeUInt32LE(writtenAt[writtenAt.length - 1]!, 42); // 本地头偏移
    centralChunks.push(cdh, utf8Name);
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralChunks);
  const centralSize = centralBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(0, 4); // 磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录开始的磁盘
  eocd.writeUInt16LE(entries.length, 8); // 该磁盘上的条目
  eocd.writeUInt16LE(entries.length, 10); // 总条目
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

// ─── CRC-32 (zlib 多项式) ──────────────────────────────────────────────

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
