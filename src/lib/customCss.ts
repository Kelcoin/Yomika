const CUSTOM_CSS_ELEMENT_ID = 'yomika-custom-css';
/** Mirror of the last applied custom CSS. Preferences arrive through IPC, so
 * without this mirror the first frames of every launch painted the default
 * scheme and then flipped — the mirror applies synchronously at import time. */
export const LAST_CUSTOM_CSS_KEY = 'yomika.last-custom-css';

/** 自定义样式走 **adoptedStyleSheets**（CSSOM），不走 `<style>` 元素：Tauri 启动时
 * 给 CSP 的 style-src 注入 nonce，`'unsafe-inline'` 随之失效，运行时创建的
 * `<style>` 会被 CSP 全部拒绝（自定义样式因此整体失效过一次）。构造样式表不是
 * 内联样式，CSP 不检查，且在文档样式中排最后——恰好保证覆盖应用令牌。
 * 回退：环境没有 adoptedStyleSheets（旧 jsdom）时仍走 `<style>` 元素。 */
function applyCustomCssSheet(css: string): boolean {
  if (typeof CSSStyleSheet === 'undefined' || !('replaceSync' in CSSStyleSheet.prototype)) return false;
  if (!('adoptedStyleSheets' in document)) return false;
  const existing = (window as { __yomikaCustomSheet?: CSSStyleSheet }).__yomikaCustomSheet;
  if (existing) {
    existing.replaceSync(css);
    return true;
  }
  if (!css.trim()) return true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  (window as { __yomikaCustomSheet?: CSSStyleSheet }).__yomikaCustomSheet = sheet;
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return true;
}


export function applyCustomCss(css: string) {
  if (typeof document === 'undefined') return;
  try {
    if (window.localStorage.getItem(LAST_CUSTOM_CSS_KEY) !== css) window.localStorage.setItem(LAST_CUSTOM_CSS_KEY, css);
  } catch { /* storage can be unavailable */ }
  if (applyCustomCssSheet(css)) {
    document.getElementById(CUSTOM_CSS_ELEMENT_ID)?.remove();
    return;
  }
  const existing = document.getElementById(CUSTOM_CSS_ELEMENT_ID);
  if (!css.trim()) {
    existing?.remove();
    return;
  }
  const element = existing ?? document.createElement('style');
  element.id = CUSTOM_CSS_ELEMENT_ID;
  element.textContent = css;
  if (!existing) document.head.append(element);
}
