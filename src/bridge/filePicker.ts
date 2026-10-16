type FilePicker = () => Promise<string | null>;
type MultiFilePicker = () => Promise<string[]>;
type SavePicker = (defaultName: string) => Promise<string | null>;

let testPicker: FilePicker | undefined;
let testMultiPicker: MultiFilePicker | undefined;
let testDirectoryPicker: FilePicker | undefined;
let testSavePicker: SavePicker | undefined;
let testModelPicker: FilePicker | undefined;
let testTextFilePicker: FilePicker | undefined;

export function setModelPickerForTests(picker: FilePicker): void {
  testModelPicker = picker;
}

export function setFilePickerForTests(picker: FilePicker): void {
  testPicker = picker;
}

export function setTextFilePickerForTests(picker: FilePicker): void {
  testTextFilePicker = picker;
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
  testModelPicker = undefined;
  testTextFilePicker = undefined;
}

/** 导出用：让用户挑一个保存位置，取消返回 null。 */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (testSavePicker) return testSavePicker(defaultName);
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const selected = await save({ defaultPath: defaultName });
  return typeof selected === 'string' ? selected : null;
}

/** 一份文本文件（导入导出）。不给扩展名过滤：导出的 JSON、旧的导出、别处的文本都应
 *  当能选中——认不认得出内容由导入那一步说。 */
export async function pickTextFile(): Promise<string | null> {
  if (testTextFilePicker) return testTextFilePicker();
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ multiple: false, directory: false });
  return typeof selected === 'string' ? selected : null;
}

/** 选一个目录：装那种大到不能当字节递过来的东西——DLSSNR 的 NGX 片段一个就 158 MB。 */
export async function pickDirectory(): Promise<string | null> {
  if (testDirectoryPicker) return testDirectoryPicker();
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ multiple: false, directory: true });
  return typeof selected === 'string' ? selected : null;
}

const ARCHIVE_EXTENSIONS = ['zip', 'rar', '7z', 'tar', 'gz', 'cbz', 'cbr', 'cb7', 'pdf'];

const MODEL_EXTENSIONS = ['zip', 'onnx', 'dll'];

export async function pickModelFile(): Promise<string | null> {
  if (testModelPicker) return testModelPicker();
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: '模型（zip / onnx / dll）', extensions: MODEL_EXTENSIONS }],
  });
  return typeof selected === 'string' ? selected : null;
}

const DLL_EXTENSIONS = ['dll'];

/** DLSSNR 的 `nvngx_dlssnr.dll`：从用户手上的那份变体里选一个。 */
export async function pickDllFile(): Promise<string | null> {
  if (testModelPicker) return testModelPicker();
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'DLSS 特性 DLL', extensions: DLL_EXTENSIONS }],
  });
  return typeof selected === 'string' ? selected : null;
}

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
