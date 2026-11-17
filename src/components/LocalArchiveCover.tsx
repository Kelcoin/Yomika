import { FileArchive } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';

const repository = new NativeLibraryRepository();
// Small native-generated JPEGs only; concurrent list/detail consumers share work.
const covers = new Map<string, Promise<string | undefined>>();
export function useLocalArchiveCover(path: string, revision: string) {
  const key = `${path}\0${revision}`;
  const [state, setState] = useState<{ key: string; cover?: string | undefined; loading: boolean }>({ key, loading: true });
  useEffect(() => {
    let alive = true;
    let request = covers.get(key);
    if (!request) {
      request = repository.loadLocalArchiveCover(path).then(result => result.ok ? result.value : undefined);
      covers.set(key, request);
      if (covers.size > 64) covers.delete(covers.keys().next().value!);
    }
    setState({ key, loading: true });
    void request.then(cover => {
      if (!cover) covers.delete(key);
      if (alive) setState({ key, cover, loading: false });
    });
    return () => { alive = false; };
  }, [path, key]);
  return state.key === key ? state : { loading: true, cover: undefined };
}

export function LocalArchiveCover({ path, revision }: { path: string; revision: string }) {
  const { cover, loading } = useLocalArchiveCover(path, revision);
  return <div className={`archive-thumb-card-media${loading ? ' is-skeleton' : ''}${!cover ? ' is-local-placeholder' : ''}`} aria-hidden="true">
    {cover ? <img src={cover} alt="" decoding="async" /> : !loading && <FileArchive />}
  </div>;
}
