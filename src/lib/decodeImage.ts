/** 图片「先解码，再换上去」。
 *
 * 浏览器在 `<img>` 换 `src` 的那一帧会先把旧图扔掉：旧图 → 空 → 新图。阅读器的底色是深的，
 * 中间那一帧空档就是用户看到的**黑闪**（原图 → 黑 → 超分/去码后的图）。这里把新图解好再
 * 交出去，设 `src` 时它是从解码缓存里直接画的，中间没有空档。
 *
 * 解不开（老 WebView 没有 `decode()`、图片坏掉、URL 已经失效）就当它「可以换」：宁可闪一下，
 * 也不要因为一次失败把那一页永远停在旧图上。
 */

type Decoder = (url: string) => Promise<void>;

let testDecoder: Decoder | undefined;

/** 测试用：jsdom 不解码图片，`decode()` 也就不会 resolve——换成可控的一步。 */
export function setImageDecoderForTests(decoder: Decoder | undefined): void {
  testDecoder = decoder;
}

export function decodeImage(url: string): Promise<void> {
  if (testDecoder) return testDecoder(url);
  if (typeof Image === 'undefined') return Promise.resolve();
  const image = new Image();
  // 与 `.reader-page` 上那条一致：解码交给解码线程，别占主线程。
  image.decoding = 'async';
  image.src = url;
  if (typeof image.decode !== 'function') {
    return new Promise((resolve) => {
      image.onload = () => resolve();
      image.onerror = () => resolve();
    });
  }
  return image.decode().catch(() => undefined);
}
