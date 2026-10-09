import { useEffect, useRef, useState } from 'react';

/** 卡片底边那条进度条的量法：轨道的实测宽度 + 「半径 + 直边」的绝对长度填充。
 *
 * 抽出来是因为这条横条现在有两处用户：档案卡的阅读进度（缩略图卡与宽行列表卡）
 * 与设置行里的模型下载。两处的落点、圆角与填充几何必须一模一样——各写一份，
 * 迟早会走样成用户报的那种「下载条游离在那一行之外」：轨道自己带圆头、填充写百分比，
 * 于是它既不跟着行的圆角走，也没和档案卡那条共用同一套量法。
 *
 * 为什么必须是绝对长度而不是百分比：`transition: width` 要插值就得两次数值不同，
 * 而百分比的计算值在列宽变化时一模一样（打开详情会把档案库挤窄），CSS 过渡直接跳过。
 * 还没量到就先按百分比画，首帧不会空着。
 *
 * `cornerAware`（宽行卡与设置行）只算两段圆角之间的直边：从 x = 0 起算的话，1% 在
 * 862px 的行上约 8.6px，整段落在 12px 的圆角弧里，被 `overflow: hidden` 裁成一条
 * 楔形，最底那 0.5px 完全没有填充（用户说的「1% 时看不出进度」）。画满时前端已经
 * 顶到边缘，不再需要让位给圆角——`is-complete` 把圆头收成直角。 */
export function cardProgressWidth(percent: number, trackWidth: number, cornerAware: boolean): string {
  const straight = cornerAware && percent > 0 && percent < 100;
  if (trackWidth > 0) {
    return straight
      ? `calc(var(--radius-card) + (${trackWidth}px - 2 * var(--radius-card)) * ${percent / 100})`
      : `${(percent / 100) * trackWidth}px`;
  }
  return straight
    ? `calc(var(--radius-card) + (100% - 2 * var(--radius-card)) * ${percent / 100})`
    : `${percent}%`;
}

/** 同一条横条的两处用户都走这里。
 *
 * 轨道的宽度由组件自己量（`ResizeObserver`）：填充要写成绝对长度才插得动，
 * 而绝对长度得先知道轨道多宽。观察的是轨道**自己**，所以容器一变就重新量一次，
 * 不会留下「槽宽更新了、内容还是旧值」的陈旧读数。
 *
 * `indeterminate`：源没报总长时用扫光条（宽度交给 CSS，见 base.css 那条）。 */
export function CardProgressBar({ percent, label, cornerAware = false, indeterminate = false, className = '' }: {
  percent: number;
  label: string;
  cornerAware?: boolean;
  indeterminate?: boolean;
  className?: string;
}) {
  const trackRef = useRef<HTMLSpanElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  useEffect(() => {
    const element = trackRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setTrackWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const complete = percent >= 100;
  const modifier = `${complete && !indeterminate ? ' is-complete' : ''}${indeterminate ? ' is-indeterminate' : ''}${className ? ` ${className}` : ''}`;
  return <span
    ref={trackRef}
    className={`archive-card-progress${modifier}`}
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    {...(indeterminate ? {} : { 'aria-valuenow': percent })}
  >
    <span className="archive-card-progress-fill" style={indeterminate ? undefined : { width: cardProgressWidth(percent, trackWidth, cornerAware) }} />
  </span>;
}
