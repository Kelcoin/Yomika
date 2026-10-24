import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ArchiveThumbMeta } from '../../src/components/ArchiveThumbnailCard';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/shell.css';

// Count real browser layout reads, without substituting fabricated dimensions.
let reads = 0;
const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')!;
Object.defineProperty(Element.prototype, 'scrollWidth', {
  configurable: true,
  get() {
    if (this.parentElement?.classList.contains('archive-thumb-card-meta')) reads++;
    return descriptor.get!.call(this);
  },
});
const root = createRoot(document.querySelector('#root')!);
function render() {
  flushSync(() => root.render(<>
    <button onClick={run}>测量</button>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10,90px)', gap: 4 }}>
      {Array.from({ length: 60 }, (_, i) => <ArchiveThumbMeta key={i}>
        <span>59/235 页</span><span>2026-10-12</span>
      </ArchiveThumbMeta>)}
    </div>
  </>));
}
function run() {
  const results = [];
  for (let round = 0; round < 7; round++) {
    reads = 0;
    const start = performance.now();
    for (let i = 0; i < 10; i++) render();
    results.push({ ms: performance.now() - start, reads });
  }
  // Discard two warm-up rounds. Compare all five samples, not the best one.
  document.querySelector('#report')!.textContent = JSON.stringify(results.slice(2));
}
render();
