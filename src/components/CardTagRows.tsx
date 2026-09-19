import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pickCardTags } from '../lib/archiveCardPresentation';
import { normalizeMyTagKey } from '../lib/ehMyTags';
import { translateRawTag } from '../lib/tags';
import { readableInkOnHex } from '../lib/ehMyTags';
import { distributeTagRows } from '../lib/tagWaterfall';
import { useEhMyTags } from './useEhMyTags';

/** Mirrors JHenTai's horizontal tag waterfall, using the actual translated chip
 * widths. With `fill` the rows pack top-down and the overflow is dropped, so a
 * card's tag slot is full rather than evenly spread; the caller keeps the tag
 * list generous and lets the measurement decide how many actually fit. */
export interface CardTagLeadingChip { label: string; tone?: string; }

/** 卡片上的标签从挑选到染色只有这一条路：命名空间优先级、隐藏的记账命名空间、
 * watched 的席位和上限都在 `pickCardTags` 里，颜色取自同一个账户的 My Tags 预设。
 * 档案库的宽行、缩略卡片和本地档案页都渲染这一个组件——各写一遍，正是标签顺序、
 * 显示范围和「我的标签」在本地档案页失效的原因。 */
export function ArchiveCardTags({ tags, limit, rowCount, className, fill = false }: {
  tags: readonly string[] | undefined;
  limit: number;
  rowCount: number;
  className: string;
  fill?: boolean | undefined;
}) {
  const myTags = useEhMyTags();
  const myTagKeys = useMemo(() => new Set(myTags.priority), [myTags.priority]);
  const picked = useMemo(() => pickCardTags(tags ?? [], limit, myTagKeys), [tags, limit, myTagKeys]);
  const colorFor = useCallback((tag: string) => myTags.colors.get(normalizeMyTagKey(tag)), [myTags.colors]);
  return <CardTagRows tags={picked} rowCount={rowCount} className={className} colorFor={colorFor} fill={fill} />;
}

export function CardTagRows({ tags, rowCount, className, colorFor, fill = false, leading = [] }: {
  tags: string[];
  rowCount: number;
  className: string;
  colorFor?: ((tag: string) => string | undefined) | undefined;
  fill?: boolean | undefined;
  /** 排在最前面的固定胶囊（渣翻/无修正这类判定）：和标签一起参与行排布，
   * 所以它们既优先显示，也不会单独占一整行。 */
  leading?: readonly CardTagLeadingChip[] | undefined;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState<{ tags: string[]; widths: number[]; containerWidth: number }>();
  // 翻译与序列化只在标签集合变化时重算：搜索框每敲一键，档案库会重渲染
  // 所有可见卡片，这里不挡一下就是每卡 × 每键的重复工作。
  const labels = useMemo(
    () => [...leading.map((chip) => chip.label), ...tags.map(translateRawTag)],
    [leading, tags],
  );
  // 判定胶囊按同样的类名渲染与测量，宽窄、字重才和实际显示一致。
  const chipClass = (index: number) => index < leading.length
    ? `metadata-chip dedup-signal-chip ${leading[index]?.tone ?? ''}`.trim()
    : 'metadata-chip';
  const labelKey = useMemo(() => JSON.stringify(labels), [labels]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const widths = [...element.querySelectorAll<HTMLElement>('.card-tag-measure')]
        .map((chip) => chip.getBoundingClientRect().width);
      // In fill mode the span stretches to the slot (inline width 100%), so its
      // own clientWidth is the row capacity. Shrink-wrapped, it would measure
      // itself — and a resizeObserver on it would never fire when the CARD
      // changes size, because a shrink-wrapped span does not.
      const containerWidth = fill ? element.clientWidth : 0;
      setMeasured((previous) => previous?.tags === tags
        && previous.widths.every((width, index) => width === widths[index])
        && previous.containerWidth === containerWidth
        ? previous : { tags, widths, containerWidth });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    void document.fonts?.ready.then(measure);
    return () => { active = false; observer?.disconnect(); };
  }, [tags, labelKey, fill]);
  // 测量层的顺序与 labels 一致（判定胶囊在前），所以宽度表也按 labels 兜底。
  const widths = measured?.tags === tags ? measured.widths : labels.map(() => 1);
  const containerWidth = measured?.tags === tags ? measured.containerWidth : 0;
  const rows = fill
    ? distributeTagRows(widths, rowCount, { containerWidth })
    : distributeTagRows(widths, rowCount);
  return <span className={`${className} card-tag-waterfall`} style={fill ? { width: '100%' } : undefined} ref={root}>
    <span className="card-tag-measures" aria-hidden="true">
      {labels.map((label, index) => <span className={`${chipClass(index)} card-tag-measure`} key={index}>{label}</span>)}
    </span>
    {rows.map((row, index) => <span className="archive-row-tag-line" key={index}>
      {row.map((tagIndex) => {
        const tag = tags[tagIndex - leading.length];
        const color = tag === undefined ? undefined : colorFor?.(tag);
        return <span className={chipClass(tagIndex)} key={tagIndex} style={color ? { background: color, color: readableInkOnHex(color) } : undefined}>{labels[tagIndex]}</span>;
      })}
    </span>)}
  </span>;
}
