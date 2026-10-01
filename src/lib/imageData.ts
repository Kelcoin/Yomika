const MIME_SIGNATURES: Array<{ mime: string; matches: (bytes: Uint8Array) => boolean }> = [
  { mime: 'image/jpeg', matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: 'image/png', matches: (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
  { mime: 'image/gif', matches: (bytes) => bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 },
  { mime: 'image/webp', matches: (bytes) => bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 },
];

export function detectImageMime(bytes: Uint8Array): string {
  return MIME_SIGNATURES.find(({ matches }) => matches(bytes))?.mime ?? 'image/jpeg';
}
