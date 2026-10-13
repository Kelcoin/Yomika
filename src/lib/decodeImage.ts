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

/** 同 `decodeImage`，但**不吞失败**：加载不出来就 reject。
 *
 * 用在「换上去的那一版必须真的能显示」的地方——算出来的产物就是一例：宿主给的取图地址
 * 一旦打不开（scheme 形状不对、租借过期、文件被清），宽松版会当作「可以换」，页面就被
 * 换成一张破图，用户看到的是图片消失，日志里一个字都没有（2026-10-13 的真机现场）。
 */
export function decodeImageStrict(url: string): Promise<void> {
  if (testDecoder) return testDecoder(url);
  if (typeof Image === 'undefined') return Promise.resolve();
  const image = new Image();
  image.decoding = 'async';
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`图片加载不出来：${url}`));
    image.src = url;
  });
}
