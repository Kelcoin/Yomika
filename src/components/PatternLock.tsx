import { useId, useRef, useState, type ReactNode } from 'react';
import { appendPatternPoint } from '../lib/patternLock';

/** One pointer owns a gesture; cancellation never submits a partial credential. */
export function PatternLock({ label, hideLabel = false, disabled = false, onComplete, primaryAction }: { label: string; hideLabel?: boolean; disabled?: boolean; onComplete: (pattern: string) => void; primaryAction?: ReactNode }) {
  const id = useId();
  const [points, setPoints] = useState<number[]>([]);
  const [error, setError] = useState('');
  const drawing = useRef<number>();
  const selected = useRef<number[]>([]);
  const add = (point: number) => {
    const next = appendPatternPoint(selected.current, point);
    if (next === selected.current) return;
    selected.current = next; setPoints(next); setError(''); onComplete('');
  };
  const reset = () => { selected.current = []; setPoints([]); drawing.current = undefined; };
  const finish = () => {
    drawing.current = undefined;
    if (selected.current.length < 4) { setError('请至少连接 4 个点'); onComplete(''); }
    else onComplete(selected.current.join(''));
  };
  const hit = (element: HTMLElement, x: number, y: number) => {
    const rect = element.getBoundingClientRect();
    for (let point = 0; point < 9; point++) {
      const px = rect.left + rect.width * ((point % 3 + .5) / 3);
      const py = rect.top + rect.height * ((Math.floor(point / 3) + .5) / 3);
      if (Math.hypot(x - px, y - py) <= Math.min(rect.width, rect.height) * .115) { add(point); break; }
    }
  };
  return <div className="pattern-lock">
    <span id={id} className={hideLabel ? 'sr-only' : undefined}>{label}</span>
    <div className="pattern-lock-grid" role="group" aria-labelledby={id} aria-disabled={disabled}
      onPointerDown={(event) => {
        if (disabled || drawing.current !== undefined || event.button !== 0) return;
        event.preventDefault(); reset(); onComplete(''); drawing.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        hit(event.currentTarget, event.clientX, event.clientY);
      }}
      onPointerMove={(event) => { if (drawing.current === event.pointerId) hit(event.currentTarget, event.clientX, event.clientY); }}
      onPointerUp={(event) => { if (drawing.current === event.pointerId) { hit(event.currentTarget, event.clientX, event.clientY); finish(); event.currentTarget.releasePointerCapture?.(event.pointerId); } }}
      onPointerCancel={(event) => { if (drawing.current === event.pointerId) { reset(); onComplete(''); } }}
      onLostPointerCapture={() => { if (drawing.current !== undefined) { reset(); onComplete(''); } }}>
      <svg viewBox="0 0 300 300" aria-hidden="true"><polyline points={points.map((point) => `${point % 3 * 100 + 50},${Math.floor(point / 3) * 100 + 50}`).join(' ')} /></svg>
      {Array.from({ length: 9 }, (_, point) => <button key={point} type="button" disabled={disabled} aria-label={`${label}：点 ${point + 1}`} aria-pressed={points.includes(point)}
        onClick={(event) => { if (event.detail === 0) { add(point); if (selected.current.length >= 4) onComplete(selected.current.join('')); } }}><span /></button>)}
    </div>
    <div className="pattern-lock-actions"><button type="button" className="secondary-action" disabled={disabled || points.length === 0} onClick={() => { reset(); onComplete(''); setError(''); }}>清除</button>{primaryAction}</div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
