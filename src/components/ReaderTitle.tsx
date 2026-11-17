import { useSingleLineTitle } from './ArchiveDetailSections';

const READER_TITLE_SIZES = ['var(--reader-title-size)', 'var(--text-lg)', 'var(--text-md)', 'var(--text-sm)'] as const;

/** Fits whenever the toolbar mounts, including after automatic hiding. */
export function ReaderTitle({ title }: { title: string }) {
  const ref = useSingleLineTitle(title, READER_TITLE_SIZES);
  return <strong ref={ref}>{title}</strong>;
}
