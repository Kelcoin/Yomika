import type { SVGProps } from 'react';
import { Sparkles } from 'lucide-react';

/** 超分开关的两态图标（2026-10-18 用户报 4：「为超分和 dlssnr 图标绘制关闭 / 启用
 *  两种状态，不要单纯只是颜色变化」）。
 *
 *  **启用**＝`Sparkles` 本身（画面正在被增强）；**关闭**＝同一枚星上压一道斜杠。
 *  斜杠用的是 lucide 自己的 off 语汇——`image-off` / `wifi-off` 那类都是同一条
 *  `line`（`x1=2 y1=2 x2=22 y2=22`），所以这里换的是几何，不是同一个形状换颜色。
 *  颜色照旧交给调用点那套 `[aria-pressed='true'] { color: var(--primary) }`（那条
 *  读法见 reader.css 与 design-system 契约）。
 */
export function UpscaleIcon({ enabled = true, ...props }: SVGProps<SVGSVGElement> & { enabled?: boolean }) {
  return (
    <Sparkles aria-hidden="true" {...props}>
      {enabled ? null : <line x1="2" x2="22" y1="2" y2="22" />}
    </Sparkles>
  );
}
