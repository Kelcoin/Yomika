/** 懒加载用的共享 IntersectionObserver：一个页面里可能同时挂上千张
 * 缩略图（详情页缩略图墙、去重成员卡），每张自己 new 一个 observer 的
 * 内存与回调开销跟着页数走；这里按 rootMargin 分桶，全页面共用。 */
type Callback = () => void;

const buckets = new Map<string, {
  observer: IntersectionObserver;
  callbacks: Map<Element, Callback>;
}>();

function ensure(rootMargin: string): IntersectionObserver | undefined {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  let bucket = buckets.get(rootMargin);
  if (!bucket) {
    const observer = new IntersectionObserver((seen) => {
      for (const entry of seen) {
        if (!entry.isIntersecting) continue;
        const callback = bucket!.callbacks.get(entry.target);
        if (!callback) continue;
        bucket!.observer.unobserve(entry.target);
        bucket!.callbacks.delete(entry.target);
        callback();
      }
    }, { rootMargin });
    bucket = { observer, callbacks: new Map() };
    buckets.set(rootMargin, bucket);
  }
  return bucket.observer;
}

/** 触发一次就自动退订。返回退订函数；环境没有 IntersectionObserver 时
 * （测试、老内核）立即执行并返回空函数。 */
export function observeOnce(node: Element, onIntersect: Callback, rootMargin = '300px'): () => void {
  const observer = ensure(rootMargin);
  if (!observer) {
    onIntersect();
    return () => {};
  }
  const bucket = buckets.get(rootMargin)!;
  bucket.callbacks.set(node, onIntersect);
  observer.observe(node);
  return () => {
    observer.unobserve(node);
    bucket.callbacks.delete(node);
  };
}
