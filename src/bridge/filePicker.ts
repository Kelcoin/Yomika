type FilePicker = () => Promise<string | null>;
type MultiFilePicker = () => Promise<string[]>;
type SavePicker = (defaultName: string) => Promise<string | null>;

let testPicker: FilePicker | undefined;
let testMultiPicker: MultiFilePicker | undefined;
let testDirectoryPicker: FilePicker | undefined;
let testSavePicker: SavePicker | undefined;

export function setFilePickerForTests(picker: FilePicker): void {
  testPicker = picker;
}

export function setArchiveFilesPickerForTests(picker: MultiFilePicker): void {
  testMultiPicker = picker;
}

export function setDirectoryPickerForTests(picker: FilePicker): void {
  testDirectoryPicker = picker;
}

export function setSavePickerForTests(picker: SavePicker): void {
  testSavePicker = picker;
}

export function resetFilePickerForTests(): void {
  testPicker = undefined;
  testMultiPicker = undefined;
  testDirectoryPicker = undefined;
  testSavePicker = undefined;
}

/** 导出用：让用户挑一个保存位置，取消返回 null。 */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (testSavePicker) return testSavePicker(defaultName);
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const selected = await save({ defaultPath: defaultName });
  return typeof selected === 'string' ? selected : null;
}

/** A directory, for installing a model bundle that is far too large to hand over
 * as bytes — the de-censoring bundle is 337 MB. */
export async function pickDirectory(): Promise<string | null> {
  if (testDirectoryPicker) return testDirectoryPicker();
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ multiple: false, directory: true });
  return typeof selected === 'string' ? selected : null;
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
