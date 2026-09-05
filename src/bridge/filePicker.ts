type FilePicker = () => Promise<string | null>;
type MultiFilePicker = () => Promise<string[]>;

let testPicker: FilePicker | undefined;
let testMultiPicker: MultiFilePicker | undefined;

export function setFilePickerForTests(picker: FilePicker): void {
  testPicker = picker;
}

export function setArchiveFilesPickerForTests(picker: MultiFilePicker): void {
  testMultiPicker = picker;
}

export function resetFilePickerForTests(): void {
  testPicker = undefined;
  testMultiPicker = undefined;
}

const ARCHIVE_EXTENSIONS = ['zip', 'rar', '7z', 'tar', 'gz', 'cbz', 'cbr', 'cb7', 'pdf'];

export async function pickArchiveFile(): Promise<string | null> {
  if (testPicker) return testPicker();
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: '漫画压缩包', extensions: ARCHIVE_EXTENSIONS }],
  });
  return typeof selected === 'string' ? selected : null;
}

/** Several archives at once, for the upload queue. */
export async function pickArchiveFiles(): Promise<string[]> {
  if (testMultiPicker) return testMultiPicker();
  if (testPicker) {
    const single = await testPicker();
    return single ? [single] : [];
  }
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return [];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: '漫画压缩包', extensions: ARCHIVE_EXTENSIONS }],
  });
  if (Array.isArray(selected)) return selected.filter((entry): entry is string => typeof entry === 'string');
  return typeof selected === 'string' ? [selected] : [];
}
