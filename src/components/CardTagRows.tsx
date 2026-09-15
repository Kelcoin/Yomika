import { useLayoutEffect, useRef, useState } from 'react';
import { translateRawTag } from '../lib/tags';
import { readableInkOnHex } from '../lib/ehMyTags';
import { distributeTagRows } from '../lib/tagWaterfall';

/** Mirrors JHenTai's horizontal tag waterfall, using the actual translated chip
 * widths. With `fill` the rows pack top-down and the overflow is dropped, so a
 * card's tag slot is full rather than evenly spread; the caller keeps the tag
 * list generous and lets the measurement decide how many actually fit. */
export function CardTagRows({ tags, rowCount, className, colorFor, fill = false }: {
  tags: string[];
  rowCount: number;
  className: string;
  colorFor?: ((tag: string) => string | undefined) | undefined;
  fill?: boolean | undefined;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState<{ tags: string[]; widths: number[]; containerWidth: number }>();
  const labels = tags.map(translateRawTag);
  const labelKey = JSON.stringify(labels);
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
  const widths = measured?.tags === tags ? measured.widths : tags.map(() => 1);
  const containerWidth = measured?.tags === tags ? measured.containerWidth : 0;
  const rows = fill
    ? distributeTagRows(widths, rowCount, { containerWidth })
    : distributeTagRows(widths, rowCount);
  return <span className={`${className} card-tag-waterfall`} style={fill ? { width: '100%' } : undefined} ref={root}>
    <span className="card-tag-measures" aria-hidden="true">
      {labels.map((label, index) => <span className="metadata-chip card-tag-measure" key={index}>{label}</span>)}
    </span>
    {rows.map((row, index) => <span className="archive-row-tag-line" key={index}>
      {row.map((tagIndex) => {
        const tag = tags[tagIndex]!;
        const color = colorFor?.(tag);
        return <span className="metadata-chip" key={tagIndex} style={color ? { background: color, color: readableInkOnHex(color) } : undefined}>{labels[tagIndex]}</span>;
      })}
    </span>)}
  </span>;
}
