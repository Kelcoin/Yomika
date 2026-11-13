import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { translateRawTag } from '../lib/tags';
import { MetadataTagChip } from './MetadataTagChip';

/** One editable tag's two widths, measured from real rendered labels. */
export interface MetadataTagSizes {
  originalWidth: number;
  translatedWidth: number;
}

/** Rows wrap on the wider of a tag's two labels — original and translation —
 * so a row fits whichever label the chip is showing at the moment. The chips
 * themselves rest at their translation's width and morph to the original's on
 * hover/press, pushing their row neighbours; both widths stay inside the row
 * the wrap chose, because the wrap reserved the larger of the two. */
export function MetadataTagRows({ tags, onDelete }: { tags: string[]; onDelete: (tag: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ rows: string[][]; widths: Map<string, MetadataTagSizes> }>({ rows: [tags], widths: new Map() });
  const translatedTags = useMemo(() => tags.map(translateRawTag), [tags]);
  const translatedKey = JSON.stringify(translatedTags);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const width = element.clientWidth;
      if (!width) { setLayout({ rows: [tags], widths: new Map() }); return; }
      const originals = element.querySelectorAll<HTMLElement>('.metadata-tag-measures .is-original-measure');
      const translations = element.querySelectorAll<HTMLElement>('.metadata-tag-measures .is-translated-measure');
      const widths = new Map<string, MetadataTagSizes>();
      const next: string[][] = [];
      let row: string[] = [];
      let used = 0;
      tags.forEach((tag, index) => {
        // 每枚 chip 除标签之外还有固定的一圈：左内边距 8、右内边距 2、删除键 22、边框 2
        // ——量出来的标签宽度加上这 34 就是它在行里占的宽（`.metadata-tag-reveal` 那条
        // `+ 10px` 必须跟着这里一起改）。
        const originalWidth = originals[index]?.getBoundingClientRect().width ?? 0;
        const translatedWidth = translations[index]?.getBoundingClientRect().width ?? 0;
        widths.set(tag, { originalWidth, translatedWidth });
        // The wrap reserves whichever label is wider, so revealing the other
        // label never overflows the row; within the row the chips still shove
        // each other aside as the width animates.
        const size = Math.max(originalWidth, translatedWidth) + 34;
        if (row.length && used + size + 6 > width) { next.push(row); row = []; used = 0; }
        used += size + (row.length ? 6 : 0);
        row.push(tag);
      });
      if (row.length) next.push(row);
      setLayout((previous) => previous.rows.length === next.length
        && previous.rows.every((existing, index) => existing.length === next[index]!.length && existing.every((tag, tagIndex) => tag === next[index]![tagIndex]))
        ? previous : { rows: next, widths });
    };
    measure();
    let frame = 0;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
    });
    observer?.observe(element);
    void document.fonts?.ready.then(measure);
    return () => { active = false; observer?.disconnect(); cancelAnimationFrame(frame); };
  }, [tags, translatedKey]);
  return <div className="metadata-tag-rows" ref={root}>
    <div className="metadata-tag-measures" aria-hidden="true">{tags.map((tag, index) => (
      <span key={`${tag}-${index}`}>
        <span className="metadata-tag-row-measure is-original-measure">{tag}</span>
        <span className="metadata-tag-row-measure is-translated-measure">{translatedTags[index]}</span>
      </span>
    ))}</div>
    {layout.rows.map((row, index) => <div className="metadata-tag-row" key={index}>{row.map((tag) => <MetadataTagChip key={tag} tag={tag} sizes={layout.widths.get(tag)} onDelete={() => onDelete(tag)} />)}</div>)}
  </div>;
}
