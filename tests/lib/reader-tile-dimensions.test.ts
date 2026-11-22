import { expect, it } from 'vitest';
import { oversizedTileCandidate } from '../../src/lib/readerTileDimensions';

it('uses encoded pixel dimensions and a strict 100 MiB threshold', () => {
  const bytes = new Uint8Array(24);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x89504e47);
  header.setUint32(16, 5120);
  header.setUint32(20, 5120);
  expect(oversizedTileCandidate(bytes)).toBe(false);
  header.setUint32(20, 5121);
  expect(oversizedTileCandidate(bytes)).toBe(true);
});

it('recognises a large JPEG and rejects truncated markers', () => {
  const bytes = new Uint8Array(24);
  bytes.set([255,216,255,192,0,17,8,16,224,30,0]);
  expect(oversizedTileCandidate(bytes)).toBe(true);
  bytes.fill(255, 2);
  expect(oversizedTileCandidate(bytes)).toBe(false);
});
