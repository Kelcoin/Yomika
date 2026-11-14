
import { invokeCommand, VoidResponseSchema } from './invoke';

/** Text export goes through the native clipboard: the webview's own API makes
 * WebView2 ask the user for clipboard permission on every write, while the OS
 * board writes without any prompt. The webview API is only the fallback for the
 * browser preview, where no native backend exists to answer. */
export async function writeClipboardText(text: string): Promise<void> {
  const viaNative = await invokeCommand('write_clipboard_text', { text }, VoidResponseSchema);
  if (viaNative.ok) return;
  await navigator.clipboard.writeText(text);
}
