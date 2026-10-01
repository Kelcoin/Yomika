import { describe, expect, it } from 'vitest';

import { detectImageMime } from '../../src/lib/imageData';

describe('image MIME sniffing', () => {
  it('detects image MIME signatures for Blob URLs', () => {
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
  });
  it('preserves PNG responses instead of forcing JPEG', () => {
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
  });

  it('falls back to JPEG for legacy or unknown thumbnail bytes', () => {
    expect(detectImageMime(new Uint8Array([1, 2, 3]))).toBe('image/jpeg');
  });
});
