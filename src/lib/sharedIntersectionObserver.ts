/** 懒加载用的共享 IntersectionObserver：一个页面里可能同时挂上千张
 * 缩略图（详情页缩略图墙、去重成员卡），每张自己 new 一个 observer 的
 * 内存与回调开销跟着页数走；这里按 (root, rootMargin) 分桶，全页面共用。
 *
 * root 必须是目标的滚动容器：root=null（视口）时，内层滚动容器会把
 * 视口外的部分裁剪出相交区，rootMargin 多大都不生效——元素得真滚进
 * 视口才触发。observeOnceInScroll 自动找最近的可滚动祖先当 root，
 * 让「提前 N 像素开始加载」真的成立。 */

type Callback = () => void;

interface Bucket {
  observer: IntersectionObserver;
  callbacks: Map<Element, Callback>;
}

const viewportBuckets = new Map<string, Bucket>();
const scrolledBuckets = new WeakMap<Element, Map<string, Bucket>>();

function ensureBucket(map: Map<string, Bucket>, root: Element | null, rootMargin: string): Bucket {
  let bucket = map.get(rootMargin);
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
    }, { root, rootMargin });
    bucket = { observer, callbacks: new Map() };
    map.set(rootMargin, bucket);
  }
  return bucket;
}

/** 触发一次就自动退订。返回退订函数；环境没有 IntersectionObserver 时
 * （测试、老内核）立即执行并返回空函数。 */
export function observeOnce(node: Element, onIntersect: Callback, rootMargin = '300px', root: Element | null = null): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onIntersect();
    return () => {};
  }
  const bucket = root
    ? ensureBucket(scrolledBuckets.get(root) ?? (() => {
        const map = new Map<string, Bucket>();
        scrolledBuckets.set(root, map);
        return map;
      })(), root, rootMargin)
    : ensureBucket(viewportBuckets, null, rootMargin);
  bucket.callbacks.set(node, onIntersect);
  bucket.observer.observe(node);
  return () => {
    bucket.observer.unobserve(node);
    bucket.callbacks.delete(node);
  };
}

/** 以最近的可滚动祖先为 root 的 observeOnce：rootMargin 从那个滚动口的
 * 边缘起算，「提前加载」才真的发生在滚动到达之前。找不到就退回视口。 */
export function observeOnceInScroll(node: Element, onIntersect: Callback, rootMargin = '300px'): () => void {
  let ancestor = node.parentElement;
  while (ancestor) {
    const style = getComputedStyle(ancestor);
    if (/(auto|scroll)/.test(style.overflowY)) {
      return observeOnce(node, onIntersect, rootMargin, ancestor);
    }
    ancestor = ancestor.parentElement;
  }
  return observeOnce(node, onIntersect, rootMargin);
}
