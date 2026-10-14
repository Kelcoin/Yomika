import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const repositories = resolve(root, 'src/repositories');

/** 图片字节**不许**走 JSON 信封。
 *
 * 2026-09-21 的两条验收里，「阅读模式的加载动画卡顿」量出来的根因就是这条路：
 * `cache_read_image` 把整张图当 `z.array(z.number())` 传，一页 1.5MB 的 JPEG 就是
 * 上百万个数字过 IPC + 逐个校验，命中缓存时每次在主线程上留下一个 200–280ms 的 long
 * task（阅读器一次开三页＝加载圈一顿一顿的；冷读走的是二进制，所以只有"缓存里已经有页"
 * 的日常路径卡）。凡是载体是图片字节的命令，一律 `invokeBinaryCommand` + Rust 端
 * `tauri::ipc::Response`；未命中用空体表示，类型由字节自己认（`detectImageMime`）。
 *
 * 这条守住的是"不会再长回来"：没人会记得这个数字，但谁都看得懂这个测试为什么在。 */
describe('image bytes never travel as JSON', () => {
  const sources = readdirSync(repositories).filter((name) => name.endsWith('.ts'));

  it('keeps no byte-array schema in the repositories', () => {
    const offenders: string[] = [];
    for (const name of sources) {
      const text = readFileSync(resolve(repositories, name), 'utf8');
      for (const line of text.split('\n')) {
        // `z.array(z.number().int().min(0).max(255))` 就是"一串字节"的写法。
        if (/z\.array\(z\.number\(\)\.int\(\)\.min\(0\)\.max\(255\)\)/.test(line)) offenders.push(`${name}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sends every command that carries image bytes as a binary body', () => {
    // 命令名 → 它必须出现在 invokeBinaryCommand 里。少一个就说明那条路的字节又走了 JSON。
    // 超分这一版在 8-g② 从这里消失了：它现在整条由 compute 产出，字节走的是
    // 产物的租借（`compute_artifact_acquire` 回的是本地 URL），不再有「宿主编码后回一张图」
    // 的命令。剩下的这几道门还是老样子——载体是字节，就必须是二进制体。
    const byteCommands = ['cache_read_image', 'load_reader_page', 'load_archive_thumbnail', 'load_archive_page_thumbnail', 'dlssnr_apply_page', 'remote_compute_process'];
    const all = sources.map((name) => readFileSync(resolve(repositories, name), 'utf8')).join('\n');
    for (const command of byteCommands) {
      expect(all, command).toContain(`invokeBinaryCommand('${command}'`);
    }
    // 反方向也不要：`Array.from(bytes)` 是把字节摊成数组的另一个写法（发送侧）。
    expect(all).not.toMatch(/Array\.from\(\s*\w*\.?bytes\s*\)/);
  });
});
