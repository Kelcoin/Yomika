import { useEffect, useRef, useState } from 'react';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { useToast } from './Toast';

const repository = new NativeLibraryRepository();

export function useArchiveReadingProgress(scopeId: string | undefined, archiveId: string | undefined, metadata?: unknown) {
  const { showToast } = useToast();
  const identity = `${scopeId ?? ''}\0${archiveId ?? ''}`;
  const owner = useRef({ identity, busy: false });
  if (owner.current.identity !== identity) owner.current = { identity, busy: false };
  const current = owner.current;
  const [reload, setReload] = useState(0);
  const [state, setState] = useState({ identity, metadata, hasProgress: false, completed: false, pageIndex: null as number | null, busy: false, ready: false, error: undefined as string | undefined });
  useEffect(() => {
    setState(previous => previous.identity === identity && previous.metadata === metadata ? { ...previous, error: undefined }
      : { identity, metadata, hasProgress: false, completed: false, pageIndex: null, busy: false, ready: false, error: undefined });
    let active = true;
    let request = 0;
    const refresh = () => {
      const token = ++request;
      if (!scopeId || !archiveId) return;
      void repository.loadProgress(scopeId, archiveId).then(result => {
        if (active && token === request) {
          if (!result.ok) { setState(previous => ({ ...previous, error: result.error.message })); return; }
          const value = result.value;
          setState(previous => ({ identity, metadata, ready: true, error: undefined, hasProgress: value !== null, completed: value !== null && value.pageCount > 0 && value.pageIndex >= value.pageCount - 1, pageIndex: value?.pageIndex ?? null, busy: previous.identity === identity && previous.busy }));
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
  // Loading metadata may hydrate a missing local record from LANraragi.
  }, [scopeId, archiveId, identity, metadata, reload]);
  const clear = async () => {
    if (!scopeId || !archiveId || current.busy) return;
    current.busy = true;
    setState(previous => ({ ...previous, busy: true }));
    const result = await repository.clearReadingProgress(scopeId, archiveId);
    current.busy = false;
    showToast(result.ok ? '已清除阅读进度和历史记录' : result.error.message, result.ok ? 'success' : 'error');
    if (owner.current !== current) return;
    setState(previous => ({ identity, metadata, ready: result.ok || previous.ready, error: undefined, hasProgress: result.ok ? false : previous.hasProgress, completed: result.ok ? false : previous.completed, pageIndex: result.ok ? null : previous.pageIndex, busy: false }));
  };
  return { completed: state.identity === identity && state.completed, ready: state.identity === identity && state.metadata === metadata && state.ready, error: state.identity === identity && state.metadata === metadata ? state.error : undefined, retry: () => setReload(value => value + 1), hasProgress: state.identity === identity && state.hasProgress, pageIndex: state.identity === identity ? state.pageIndex : null, busy: state.identity === identity && state.busy, clear };
}
