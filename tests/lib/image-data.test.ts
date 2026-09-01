import { describe, expect, it } from 'vitest';

import { bytesToImageDataUrl, detectImageMime } from '../../src/lib/imageData';

describe('image data URLs', () => {
  it('detects image MIME signatures for Blob URLs', () => {
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
  });
  it('preserves PNG responses instead of forcing JPEG', () => {
    const value = bytesToImageDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer);
    expect(value).toMatch(/^data:image\/png;base64,/);
  });

  it('falls back to JPEG for legacy or unknown thumbnail bytes', () => {
    const value = bytesToImageDataUrl(new Uint8Array([1, 2, 3]).buffer);
    expect(value).toMatch(/^data:image\/jpeg;base64,/);
  });
});
