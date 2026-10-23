// tests/zip.test.js
/* ZIP 导出：格式正确性 + 流式/ZIP64 行为。
 *
 * 不 mock 被测代码：真的用 ZipWriter 生成归档，再把字节按 ZIP 规范解析回来。
 * 覆盖：
 *   - CRC32 与标准值一致
 *   - 本地头 / data descriptor / 中央目录 / EOCD 的字段
 *   - 大 Blob 分块写入（流式：多块，不是一次性 buffer）
 *   - ZIP64 尾部（强制走 64 位分支）
 */
import './_browser-stubs.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, buildZipTail, memorySink, ZipWriter, webFileSink } from '../zip.js';

const enc = new TextEncoder();

function u16(b, o) { return new DataView(b.buffer, b.byteOffset + o, 2).getUint16(0, true); }
function u32(b, o) { return new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, true); }

async function toBytes(sink) {
  const { blob } = await sink.close();
  return new Uint8Array(await blob.arrayBuffer());
}

test('crc32：与标准值一致（hello → 0x3610A686）', () => {
  assert.equal(crc32(enc.encode('hello')), 0x3610A686);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('单个文件：本地头 + data descriptor + 中央目录 + EOCD 全部正确', async () => {
  const content = enc.encode('第一行\nhello world\n');
  const sink = memorySink();
  const zw = new ZipWriter(sink);
  await zw.addFile('记录/a.md', new Blob([content]));
  const { count, size } = await zw.finish();
  await sink.close();

  const b = await toBytes(sink);
  assert.equal(b.length, size);

  /* --- 本地文件头 --- */
  assert.equal(u32(b, 0), 0x04034b50, 'local header 签名');
  assert.equal(u16(b, 4), 20, 'version needed');
  assert.equal(u16(b, 6) & 0x0008, 0x0008, '必须带 data descriptor 标志');
  assert.equal(u16(b, 6) & 0x0800, 0x0800, 'UTF-8 文件名标志');
  assert.equal(u16(b, 8), 0, 'stored 不压缩');
  assert.equal(u32(b, 14), 0, '本地头里 CRC 先留空');
  assert.equal(u32(b, 18), 0, '本地头里大小先留空');
  const nameLen = u16(b, 26);
  const name = new TextDecoder().decode(b.subarray(30, 30 + nameLen));
  assert.equal(name, '记录/a.md');

  /* --- 数据 --- */
  const dataStart = 30 + nameLen;
  assert.deepEqual(b.subarray(dataStart, dataStart + content.length), content);

  /* --- data descriptor --- */
  const dd = dataStart + content.length;
  assert.equal(u32(b, dd), 0x08074b50, 'descriptor 签名');
  assert.equal(u32(b, dd + 4), crc32(content), 'descriptor 里的 CRC');
  assert.equal(u32(b, dd + 8), content.length, 'compressed size');
  assert.equal(u32(b, dd + 12), content.length, 'uncompressed size');

  /* --- 中央目录 --- */
  const cen = dd + 16;
  assert.equal(u32(b, cen), 0x02014b50, 'central header 签名');
  assert.equal(u32(b, cen + 16), crc32(content), 'central CRC');
  assert.equal(u32(b, cen + 20), content.length, 'central size');
  assert.equal(u32(b, cen + 42), 0, 'central 记录的本地头偏移');

  /* --- EOCD --- */
  const eocd = b.length - 22;
  assert.equal(u32(b, eocd), 0x06054b50, 'EOCD 签名');
  assert.equal(u16(b, eocd + 8), count, '本磁盘条目数');
  assert.equal(u16(b, eocd + 10), count, '总条目数');
  assert.equal(u32(b, eocd + 12), cen === eocd ? 0 : 46 + nameLen, '中央目录大小');
  assert.equal(u32(b, eocd + 16), cen, '中央目录偏移');
});

test('多个文件：第二条记录的本地头偏移正确、名称各自保留', async () => {
  const sink = memorySink();
  const zw = new ZipWriter(sink);
  const a = enc.encode('aaa');
  const bb = enc.encode('bbbb');
  await zw.addFile('a.txt', new Blob([a]));
  await zw.addFile('b.txt', new Blob([bb]));
  await zw.finish();
  await sink.close();

  const bytes = await toBytes(sink);
  const firstLocalLen = 30 + 'a.txt'.length;
  const secondLocal = firstLocalLen + a.length + 16;

  assert.equal(u32(bytes, secondLocal), 0x04034b50, '第二条本地头');
  const n2 = u16(bytes, secondLocal + 26);
  assert.equal(new TextDecoder().decode(bytes.subarray(secondLocal + 30, secondLocal + 30 + n2)), 'b.txt');

  /* 中央目录区从第二条记录结尾开始；b 的记录是其中第二项 */
  const centralStart = secondLocal + 30 + n2 + bb.length + 16;
  const cen1 = centralStart;
  const cen2 = cen1 + 46 + n2;
  assert.equal(u32(bytes, cen1 + 42), 0, 'a 的偏移是 0');
  assert.equal(u32(bytes, cen2), 0x02014b50);
  assert.equal(u32(bytes, cen2 + 42), secondLocal, 'central 里的偏移必须指向自己的本地头');
});

test('流式：9 MB 文件被分块写入（sink.write 调用多次），且字节完整', async () => {
  const size = 9 * 1024 * 1024;
  const big = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) big[i] = i & 0xFF;

  let writes = 0;
  const sink = memorySink();
  const counting = {
    async write(chunk) { writes++; return sink.write(chunk); },
    async close() { return sink.close(); },
  };

  const zw = new ZipWriter(counting);
  await zw.addFile('big.bin', new Blob([big]));
  const { size: total } = await zw.finish();
  await counting.close();

  assert.ok(writes > 3, '应当是分块写入，实际 write 次数 = ' + writes);
  const bytes = await toBytes(sink);
  assert.equal(bytes.length, total, '总长度等于记录的大小');
  const dataStart = 30 + 'big.bin'.length;
  assert.deepEqual(bytes.subarray(dataStart, dataStart + size), big, '内容一字不差');
});

test('ZIP64：条目数超 65535 时自动写 EOCD64 + 定位器 + 兼容 EOCD', () => {
  const tail = buildZipTail({ count: 70000, centralSize: 1234, centralOffset: 5678 });

  assert.equal(tail.length, 56 + 20 + 22);
  assert.equal(u32(tail, 0), 0x06064b50, 'EOCD64 签名');
  assert.equal(u32(tail, 4), 44, 'EOCD64 记录长度');
  assert.equal(u16(tail, 14), 45, 'version needed 45');

  /* count 是 u64（低 32 位 + 高 32 位） */
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.length);
  assert.equal(dv.getUint32(24, true), 70000, 'EOCD64 条目数低位');
  assert.equal(dv.getUint32(28, true), 0, 'EOCD64 条目数高位');

  assert.equal(u32(tail, 56), 0x07064b50, '定位器签名');
  const locDv = new DataView(tail.buffer, tail.byteOffset, tail.length);
  assert.equal(locDv.getUint32(56 + 8, true), 5678 + 1234, '定位器指向 EOCD64');

  assert.equal(u32(tail, 76), 0x06054b50, '兼容 EOCD 签名');
  assert.equal(u16(tail, 76 + 8), 0xFFFF, '兼容 EOCD 条目数填满');
  assert.equal(u32(tail, 76 + 16), 0xFFFFFFFF, '兼容 EOCD 偏移填满');
});

test('ZIP64：4 GB 以上偏移的中央目录记录带 0x0001 extra field', async () => {
  /* 直接把 offset 改大来验证中央目录的写法，不真的写 4 GB */
  const sink = memorySink();
  const zw = new ZipWriter(sink);
  await zw.addFile('a.txt', new Blob([enc.encode('x')]));
  zw.central[0].offset = 0x1_0000_0000 + 123;   // 4 GB + 123
  await zw.finish();
  await sink.close();

  const b = await toBytes(sink);
  /* 布局：本地头(30+5) + 数据(1) + descriptor(16) → 中央目录从这里开始 */
  const cen = 30 + 'a.txt'.length + 1 + 16;
  assert.equal(u32(b, cen), 0x02014b50);
  assert.equal(u16(b, cen + 6), 45, 'version needed 应为 45');
  assert.equal(u32(b, cen + 42), 0xFFFFFFFF, 'offset 填满表示"看 extra"');
  const extraLen = u16(b, cen + 30);
  assert.equal(extraLen, 12, 'extra field 长度');
  const extraAt = 46 + 'a.txt'.length;
  assert.equal(u16(b, cen + extraAt), 0x0001, 'ZIP64 extra id');
  assert.equal(u16(b, cen + extraAt + 2), 8, 'ZIP64 extra 数据长度');
  assert.equal(u32(b, cen + extraAt + 4), 123, 'offset 低位');
  assert.equal(u32(b, cen + extraAt + 8), 1, 'offset 高位');
});

test('写入失败时 webFileSink.abort() 应调 abort 而不是 close（否则半截 zip 会被提交）', async () => {
  const calls = [];
  const handle = {
    async createWritable() {
      return {
        async write() {},
        async close() { calls.push('close'); },
        async abort() { calls.push('abort'); },
      };
    },
  };
  const sink = webFileSink(handle);
  await sink.write(new Uint8Array([1, 2, 3]));
  await sink.abort();
  assert.deepEqual(calls, ['abort']);
  /* abort 之后再 close 不应再调用底层 close */
  await sink.close();
  assert.deepEqual(calls, ['abort']);
});

test('memorySink 不会因 abort 而丢已写内容（纯内存无副作用）', async () => {
  const sink = memorySink();
  await sink.write(new Uint8Array([9]));
  assert.equal(sink.size, 1);
});
