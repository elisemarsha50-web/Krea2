(function (root) {
  'use strict';
  function splitPrompts(text, batch = true) {
    const normalized = String(text).replace(/\r\n?/g, '\n').trim();
    return normalized ? (batch ? normalized.split(/\n[\t ]*\n(?:[\t ]*\n)*/).map(s => s.trim()).filter(Boolean) : [normalized]) : [];
  }
  const table = Uint32Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
  function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) crc = table[(crc ^ b) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
  async function zipImages(items) {
    if (!items.length) throw new Error('Выберите изображения для скачивания.');
    if (items.reduce((n, item) => n + item.blob.size, 0) > 1500000000) throw new Error('Архив слишком большой. Выберите меньше изображений.');
    const chunks = [], central = []; let offset = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i], extension = {'image/jpeg':'jpg','image/webp':'webp'}[item.blob.type] || 'png';
      const name = new TextEncoder().encode(`krea-${String(i + 1).padStart(3, '0')}-seed-${item.seed}.${extension}`);
      const crc = crc32(new Uint8Array(await item.blob.arrayBuffer())), size = item.blob.size;
      const header = new Uint8Array(30 + name.length), local = new DataView(header.buffer);
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x800, true); local.setUint16(12, 0x21, true);
      local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, name.length, true); header.set(name, 30);
      const entry = new Uint8Array(46 + name.length), dir = new DataView(entry.buffer);
      dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x800, true); dir.setUint16(14, 0x21, true);
      dir.setUint32(16, crc, true); dir.setUint32(20, size, true); dir.setUint32(24, size, true); dir.setUint16(28, name.length, true); dir.setUint32(42, offset, true); entry.set(name, 46);
      chunks.push(header, item.blob); central.push(entry); offset += header.length + size;
    }
    const length = central.reduce((n, b) => n + b.length, 0), trailer = new Uint8Array(22), end = new DataView(trailer.buffer);
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, items.length, true); end.setUint16(10, items.length, true); end.setUint32(12, length, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, trailer], {type:'application/zip'});
  }
  const api = Object.freeze({splitPrompts, crc32, zipImages});
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KreaUtils = api;
})(typeof globalThis === 'object' ? globalThis : this);
