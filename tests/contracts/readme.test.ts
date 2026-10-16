/**
 * README 是新用户看到的第一份东西，也最容易在重构里烂掉：引一张不存在的图、把还没解析
 * 占位色的母版当成 LOGO、或者把已经退役的功能继续写在介绍里，tsc 与 vitest 都不会因此
 * 变红。这一条只钉三件可判定的事：只画派生版 LOGO（不带展示图）、退役的功能不再出现在
 * 介绍里。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 路径先落进变量再交给 `new URL`：直接写字面量时 Vite 会把它当成静态资源改写成一个
// 非 file 的方案，`fileURLToPath` 于是抛 `The URL must be of scheme file`（同
// `tests/contracts/mobile-packaging.test.ts`）。
function pathOf(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

const root = pathOf('../../');
const readme = readFileSync(pathOf('../../README.md'), 'utf8');

describe('README', () => {
  it('draws the derived app icon once and carries no showcase screenshots', () => {
    // `noUncheckedIndexedAccess` 下 `match[1]` 是 `string | undefined`，先把没捕获到的那条滤掉。
    const sources = [...readme.matchAll(/src="([^"]+)"/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    // 2026-10-15 撤掉了全部展示图（用户口径：自动生成的截图不好看，README 不带图）。这条判据
    // 就是那件事的记录：再往 README 里放图必须先改它，不能顺手夹带。
    expect(sources).toEqual(['src-tauri/icons/app-icon.svg']);
    expect(readme).not.toContain('assets/screenshots/');
    expect(readme).not.toContain('<table>');
    expect(existsSync(`${root}${sources[0]}`), `README 引了不存在的图：${sources[0]}`).toBe(true);
  });

  it('shows the derived app icon instead of the master with unresolved colour slots', () => {
    expect(readme).toContain('src-tauri/icons/app-icon.svg');
    expect(readme).not.toContain('assets/yomika-mark.svg');
  });

  it('keeps the retired decensor feature out of the feature list', () => {
    expect(readme).not.toMatch(/去码|decensor|Aletheia/i);
  });
});
