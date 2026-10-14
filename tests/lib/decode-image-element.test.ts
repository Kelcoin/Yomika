import { afterEach, expect, it, vi } from 'vitest';
import { decodeImageElementStrict, setImageDecoderForTests } from '../../src/lib/decodeImage';
afterEach(() => vi.restoreAllMocks());
it('waits for the actual image node decode promise and propagates decode failure', async () => {
  setImageDecoderForTests(undefined);
  const image = document.createElement('img');
  image.src = 'blob:candidate';
  let finish: (() => void) | undefined;
  const decode = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  image.decode = decode;
  let ready = false;
  const pending = decodeImageElementStrict(image).then(() => { ready = true; });
  expect(decode).toHaveBeenCalledOnce();
  image.dispatchEvent(new Event('load'));
  await Promise.resolve();
  expect(ready).toBe(false);
  finish?.(); await pending; expect(ready).toBe(true);
  image.decode = vi.fn(() => Promise.reject(new Error('decode failed')));
  await expect(decodeImageElementStrict(image)).rejects.toThrow('decode failed');
});
it('falls back to actual-node load and error when decode is unavailable', async () => {
  setImageDecoderForTests(undefined);
  const image = document.createElement('img'); image.src = 'blob:legacy';
  const pending = decodeImageElementStrict(image);
  image.dispatchEvent(new Event('load')); await expect(pending).resolves.toBeUndefined();
  const broken = document.createElement('img'); broken.src = 'blob:broken';
  const failure = decodeImageElementStrict(broken);
  broken.dispatchEvent(new Event('error')); await expect(failure).rejects.toThrow('blob:broken');
});
