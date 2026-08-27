type FilePicker = () => Promise<string | null>;

let testPicker: FilePicker | undefined;

export function setFilePickerForTests(picker: FilePicker): void {
  testPicker = picker;
}

export function resetFilePickerForTests(): void {
  testPicker = undefined;
}

export async function pickArchiveFile(): Promise<string | null> {
  if (testPicker) return testPicker();
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: '漫画压缩包', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'cbz', 'cbr', 'cb7'] }],
  });
  return typeof selected === 'string' ? selected : null;
}
