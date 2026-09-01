import '@testing-library/jest-dom/vitest';

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  disconnect(): void {}
  observe(target: Element): void {
    const size = { blockSize: 600, inlineSize: 800 } as ResizeObserverSize;
    this.callback([{
      borderBoxSize: [size],
      contentBoxSize: [size],
      contentRect: { bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0, toJSON: () => ({}) },
      devicePixelContentBoxSize: [size],
      target,
    }], this);
  }
  unobserve(): void {}
}

window.ResizeObserver = TestResizeObserver;

let blobUrlSequence = 0;
if (!URL.createObjectURL) URL.createObjectURL = () => `blob:test-${blobUrlSequence++}`;
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => undefined;
