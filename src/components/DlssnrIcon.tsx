import type { SVGProps } from 'react';

/** Three image layers crossing a neural detail grid.
 *
 * 两态：**启用**时顶层那一片填实（这一摞真在干活），**关闭**时同一摞只留描边、外加
 * lucide 自己的 off 语汇——一条 `x1=2 y1=2 x2=22 y2=22` 的斜杠（`image-off`/`wifi-off`
 * 那类都是它）。2026-10-18 用户报 4：「为超分和 dlssnr 图标绘制关闭 / 启用两种状态，
 * 不要单纯只是颜色变化」——所以这里换的是几何（实心/描边 + 有没有那道杠），
 * 颜色照旧交给调用点那套 `aria-pressed` 规则。
 *
 * 默认 `enabled`：这颗图标还当「DLSSNR 组件」这类中性图使用（设置里那两行标题），
 * 那些地方没有开关状态可表态，保持原来那枚实心版本。
 */
export function DlssnrIcon({ enabled = true, ...props }: SVGProps<SVGSVGElement> & { enabled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M4 7.5 12 4l8 3.5-8 3.5-8-3.5Z" fill={enabled ? 'currentColor' : 'none'} />
      <path d="m4 12 8 3.5 8-3.5M4 16.5l8 3.5 8-3.5" />
      {enabled ? <path d="M9 7.5h6M12 6v3" /> : <line x1="2" x2="22" y1="2" y2="22" />}
    </svg>
  );
}
