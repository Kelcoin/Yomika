import { useLayoutEffect, useRef, useState } from 'react';
import { translateRawTag } from '../lib/tags';
import { readableInkOnHex } from '../lib/ehMyTags';
import { distributeTagRows } from '../lib/tagWaterfall';

/** Mirrors JHenTai's horizontal tag waterfall, using the actual translated chip widths. */
export function CardTagRows({ tags, rowCount, className, colorFor }: {
  tags: string[];
  rowCount: number;
  className: string;
  colorFor?: ((tag: string) => string | undefined) | undefined;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState<{ tags: string[]; widths: number[] }>();
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
      setMeasured((previous) => previous?.tags === tags && previous.widths.every((width, index) => width === widths[index])
        ? previous : { tags, widths });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    void document.fonts?.ready.then(measure);
    return () => { active = false; observer?.disconnect(); };
  }, [tags, labelKey]);
  const widths = measured?.tags === tags ? measured.widths : tags.map(() => 1);
  return <span className={`${className} card-tag-waterfall`} ref={root}>
    <span className="card-tag-measures" aria-hidden="true">
      {labels.map((label, index) => <span className="metadata-chip card-tag-measure" key={index}>{label}</span>)}
    </span>
    {distributeTagRows(widths, rowCount).map((row, index) => <span className="archive-row-tag-line" key={index}>
      {row.map((tagIndex) => {
        const tag = tags[tagIndex]!;
        const color = colorFor?.(tag);
        return <span className="metadata-chip" key={tagIndex} style={color ? { background: color, color: readableInkOnHex(color) } : undefined}>{labels[tagIndex]}</span>;
      })}
    </span>)}
  </span>;
}
