import { useLayoutEffect, useRef, useState } from 'react';
import { MetadataTagChip } from './MetadataTagChip';

/** Row boundaries use original labels and stay unchanged while translations reveal. */
export function MetadataTagRows({ tags, onDelete }: { tags: string[]; onDelete: (tag: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<string[][]>([tags]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const width = element.clientWidth;
      if (!width) { setRows([tags]); return; }
      const labels = element.querySelectorAll<HTMLElement>('.metadata-tag-row-measure');
      const next: string[][] = [];
      let row: string[] = [];
      let used = 0;
      tags.forEach((tag, index) => {
        const size = (labels[index]?.getBoundingClientRect().width ?? 0) + 40;
        if (row.length && used + size + 6 > width) { next.push(row); row = []; used = 0; }
        used += size + (row.length ? 6 : 0);
        row.push(tag);
      });
      if (row.length) next.push(row);
      setRows(next);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    void document.fonts?.ready.then(measure);
    return () => { active = false; observer?.disconnect(); };
  }, [tags]);
  return <div className="metadata-tag-rows" ref={root}>
    <div className="metadata-tag-measures" aria-hidden="true">{tags.map((tag) => <span className="metadata-tag-row-measure" key={tag}>{tag}</span>)}</div>
    {rows.map((row, index) => <div className="metadata-tag-row" key={index}>{row.map((tag) => <MetadataTagChip key={tag} tag={tag} onDelete={() => onDelete(tag)} />)}</div>)}
  </div>;
}
