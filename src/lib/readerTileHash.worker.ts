import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';

self.onmessage = async ({ data }: MessageEvent<{ blob: Blob }>) => {
  try {
    const hash = blake3.create();
    const reader = data.blob.stream().getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
    self.postMessage(bytesToHex(hash.digest()));
  } catch { self.postMessage(null); }
};
