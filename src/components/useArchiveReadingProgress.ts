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
  const [state, setState] = useState({ identity, hasProgress: false, busy: false });
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = () => {
      const token = ++request;
      if (!scopeId || !archiveId) return;
      void repository.loadProgress(scopeId, archiveId).then(result => {
        if (active && token === request && result.ok) {
          setState(previous => ({ identity, hasProgress: result.value !== null, busy: previous.identity === identity && previous.busy }));
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
    setState(previous => ({ identity, hasProgress: result.ok ? false : previous.hasProgress, busy: false }));
  };
  return { hasProgress: state.identity === identity && state.hasProgress, busy: state.identity === identity && state.busy, clear };
}
