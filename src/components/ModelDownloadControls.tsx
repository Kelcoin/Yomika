import { Download, RefreshCw } from 'lucide-react';
import { CardProgressBar } from './CardProgressBar';

/** 模型下载那一对控件：行尾的下载按钮与它下面贴边的那条进度条。
 *
 * 抽成独立模块是因为两个菜单都要用它们：模型菜单（超分/去码）与 DLSSNR 的组件菜单。
 * 它们原先长在 `SettingsWorkspace.tsx` 里，而 `SettingsWorkspace` 又要 import
 * `DlssnrSettingsGroup`——后者回头 import 前者的这两个槽就成环了（运行时没问题，
 * 但依赖方向是错的：控件不该挂在工作区上）。 */

/** A model coming down: the backend reports bytes done out of a total, and falls
 * back to an indeterminate bar when the source does not announce a length.
 *
 * 槽是**常驻挂载**的，用 `is-open` 开关，而不是条件渲染：卸载的节点没有过渡可放，
 * 「消失」就只能是啪一下不见。
 *
 * 画的条就是档案卡那一条：同一个 `CardProgressBar`（同一次量法、同一套 CSS）。
 * 这一层只负责定位与开/关——`position: absolute` 让它不参与行布局，行高由按钮自己
 * （`min-height: 44px`）决定，开不开下载都一样。
 *
 * 只画一条轨道，右边不写百分比：数字每隔几帧跳一次，比条本身还吵，而条的长短已经把
 * 话说完了。后端没报 total 时走不定量扫光条。 */
export function ModelDownloadSlot({ open, label, progress }: { open: boolean; label: string; progress?: { completed: number; total?: number | undefined } | undefined }) {
  const percent = progress?.total ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : undefined;
  return (
    <div className={`model-download-slot${open ? ' is-open' : ''}`} aria-hidden={!open}>
      <CardProgressBar
        percent={percent ?? 0}
        indeterminate={percent === undefined}
        cornerAware
        label={`${label}下载进度`}
      />
    </div>
  );
}

/** 下载一颗尚未安装的模型，或者更新一颗已经过时的。
 *
 * 同一个动作有两个入口：菜单里挂在它自己那一项上，行上挂在行右侧。以前只有菜单里
 * 那一个，于是「下载」这件事必须先打开二级菜单才做得到；而进度条画在设置项上、
 * 也就是菜单那层遮罩的后面，点完下载根本看不到。 */
export function ModelDownloadButton({ option, installed, outdated, pending, className, onDownload }: {
  option: { value: string; label: string };
  installed: boolean;
  /** 已装，但盘上那份比目录里的版本旧：同一个动作，按钮改叫更新。 */
  outdated?: boolean | undefined;
  pending: boolean;
  className: string;
  onDownload: () => void;
}) {
  // Nothing to offer when the model is already installed and current, and nothing to offer for
  // an empty id either: the upscale row exists before any catalog has answered.
  if ((installed && !outdated) || !option.value) return null;
  return (
    <button
      className={className}
      type="button"
      aria-label={`${outdated ? '更新' : '下载'}${option.label}`}
      title={outdated ? '更新模型' : '下载模型'}
      disabled={pending}
      // 它只在二级菜单里出现：不冒泡，否则点下载会顺手把菜单关掉，进度条刚出现就没了。
      onClick={(event) => { event.stopPropagation(); onDownload(); }}
    >{outdated ? <RefreshCw aria-hidden="true" /> : <Download aria-hidden="true" />}</button>
  );
}
