/** Read only format headers. WebView can density-correct naturalWidth/Height. */
export function oversizedTileCandidate(b: Uint8Array): boolean {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const large = (w: number, h: number) => w * h > 100 * 1024 * 1024 / 4;
  if (b.length < 24) return false;
  if (v.getUint32(0) === 0x89504e47) return large(v.getUint32(16), v.getUint32(20));
  if (v.getUint32(8) === 0x57454250) {
    const kind = v.getUint32(12);
    if (kind === 0x56503858 && b.length >= 30) return !(b[20]! & 2) && large(1 + (v.getUint32(23,true) >>> 8), 1 + (v.getUint32(26,true) >>> 8));
    if (kind === 0x56503820 && b.length >= 30) return large(v.getUint16(26,true) & 0x3fff, v.getUint16(28,true) & 0x3fff);
    if (kind === 0x5650384c && b.length >= 25) { const dims = v.getUint32(21,true); return large(1 + (dims & 0x3fff), 1 + ((dims >>> 14) & 0x3fff)); }
    return false;
  }
  if (v.getUint16(0) !== 0xffd8) return false;
  for (let i = 2; i + 9 < b.length && b[i] === 0xff;) {
    while (b[i] === 0xff) i++;
    const marker = b[i++]!;
    if (marker === 0xda || marker === 0xd9 || i + 7 > b.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker)) return large(v.getUint16(i+3),v.getUint16(i+5));
    const size = v.getUint16(i); if (size < 2) return false;
    i += size;
  }
  return false;
}
