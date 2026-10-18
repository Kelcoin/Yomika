import { useEffect, useRef, useState } from 'react';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { useToast } from './Toast';

const repository = new NativeLibraryRepository();

export function useArchiveReadingProgress(scopeId: string | undefined, archiveId: string | undefined) {
  const { showToast } = useToast();
  const identity = `${scopeId ?? ''}\0${archiveId ?? ''}`;
  const owner = useRef({ identity, busy: false });
  if (owner.current.identity !== identity) owner.current = { identity, busy: false };
  const current = owner.current;
  const [state, setState] = useState({ identity, hasProgress: false, pageIndex: null as number | null, busy: false, ready: false });
  useEffect(() => {
    setState({ identity, hasProgress: false, pageIndex: null, busy: false, ready: false });
    let active = true;
    let request = 0;
    const refresh = () => {
      const token = ++request;
      if (!scopeId || !archiveId) return;
      void repository.loadProgress(scopeId, archiveId).then(result => {
        if (active && token === request) {
          const value = result.ok ? result.value : null;
          setState(previous => ({ identity, ready: true, hasProgress: value !== null, pageIndex: value?.pageIndex ?? null, busy: previous.identity === identity && previous.busy }));
        }
      });
    };
    const invalidate = (event: Event) => {
      const prefix = (event as CustomEvent<{ prefix?: string }>).detail?.prefix;
      if (!prefix || prefix === 'home:' || prefix === 'state:') refresh();
    };
    refresh();
    window.addEventListener('yomika:route-cache-invalidated', invalidate);
    return () => { active = false; window.removeEventListener('yomika:route-cache-invalidated', invalidate); };
  }, [scopeId, archiveId, identity]);
  const clear = async () => {
    if (!scopeId || !archiveId || current.busy) return;
    current.busy = true;
    setState(previous => ({ ...previous, busy: true }));
    const result = await repository.clearReadingProgress(scopeId, archiveId);
    current.busy = false;
    showToast(result.ok ? '已清除阅读进度和历史记录' : result.error.message, result.ok ? 'success' : 'error');
    if (owner.current !== current) return;
    setState(previous => ({ identity, ready: true, hasProgress: result.ok ? false : previous.hasProgress, pageIndex: result.ok ? null : previous.pageIndex, busy: false }));
  };
  return { ready: state.identity === identity && state.ready, hasProgress: state.identity === identity && state.hasProgress, pageIndex: state.identity === identity ? state.pageIndex : null, busy: state.identity === identity && state.busy, clear };
}
