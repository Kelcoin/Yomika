/**
 * 注释规范的防锈检查。
 *
 * 规范正文在 `docs/21-comment-standards.md`（`docs/` 被 gitignore，靠 `git add -f` 入库，
 * 与 `docs/20-cross-platform-ui-logic-standards.md` 一样）。这里只钉**能机械判定**的那几条：
 * 「写为什么」「一处理由只写一处」这类文字性的规矩没法自动判，靠评审。
 *
 * 为什么值得钉：这一轮盘点发现 184 处 CSS 注释和选择器挤在同一行，而契约测试扫的是**原始
 * 文本**——`[^}]*` 这类模式会把行内注释一起卷进去，于是「注释里提到的东西」被当成规则内容
 * 读走。改回同一行不会有人报错，只会让某个条款悄悄失去意义。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');

/** 扫描时跳过的目录：构建产物与依赖，它们不归这份规范管。 */
const SKIP = new Set(['node_modules', 'target', 'dist', 'gen', 'build', 'debug_outputs', 'artifacts']);

/** 递归列出目录下所有指定后缀的文件（返回相对仓库根的路径）。 */
function filesUnder(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) {
        continue;
      }
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(relative(root, child).replaceAll('\\', '/'));
      }
    }
  };
  walk(join(root, directory));
  return found.sort();
}

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

/** 这份检查自己会写出 TODO/FIXME 这几个字，扫自己必然假红。 */
const SELF = 'tests/contracts/comment-standards.test.ts';

describe('comment standards', () => {
  it('leaves no TODO or FIXME marker behind', () => {
    // 全仓盘点是 0 个：不写「以后再说」，要推迟就把「为什么现在不做」写清楚。
    // XXX 不在这里扫：它会撞上占位文本与十六进制里的偶然三连，假红比真红多。
    const marker = /\b(?:TODO|FIXME|HACK)\b/;
    const scanned = [
      ...filesUnder('src', ['.ts', '.tsx']),
      ...filesUnder('src-tauri/src', ['.rs']),
      ...filesUnder('src-tauri/crates', ['.rs']),
      ...filesUnder('src-tauri/worker/src', ['.rs']),
      ...filesUnder('scripts', ['.ps1']),
      ...filesUnder('tests', ['.ts', '.tsx']),
    ].filter((path) => path !== SELF);
    expect(scanned.length).toBeGreaterThan(300);

    const offenders = scanned.filter((path) => marker.test(read(path)));
    expect(offenders, `这些文件里还留着推迟标记：${offenders.join('、')}`).toEqual([]);
  });

  it('never lets a CSS comment share a line with a rule', () => {
    // 契约测试读的是原始文本，行内注释会被卷进规则体；注释也更容易随着代码一起腐烂。
    // 判法：把注释整段抹成空白（保留换行），再逐行比——某一行既有代码又与原文不同，
    // 就说明那一行上既有代码又有注释。注释正文里出现 `/*`（例如写 `dist/assets/*.css`）
    // 不算违规：那一段在注释内部，抹完那一行本来就是空的。
    const offenders: string[] = [];
    for (const path of filesUnder('src/styles', ['.css'])) {
      const source = read(path);
      const blanked = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
      const original = source.split(/\r?\n/);
      blanked.split(/\r?\n/).forEach((line, index) => {
        if (line.trim() !== '' && line !== original[index]) {
          offenders.push(`${path}:${index + 1} 注释与代码同一行`);
        }
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('opens every PowerShell script with a comment header', () => {
    const scripts = filesUnder('scripts', ['.ps1']);
    expect(scripts.length).toBeGreaterThan(40);

    const offenders = scripts.filter((path) => {
      const first = read(path)
        .split(/\r?\n/)
        .find((line) => line.trim() !== '');
      return first === undefined || !(first.trimStart().startsWith('#') || first.trimStart().startsWith('<#'));
    });
    expect(offenders, `这些脚本开头不是注释：${offenders.join('、')}`).toEqual([]);
  });

  it('keeps the file header on the five biggest host modules', () => {
    // 这五个是读宿主代码时最先撞上的入口（每份都上千行）。它们原本都没有文件头，
    // 2026-10-16 补上；盘点时宿主侧还有 18 个文件没有文件头，那些留作后续，不在这里钉。
    const modules = [
      'src-tauri/src/lib.rs',
      'src-tauri/src/inference.rs',
      'src-tauri/src/cache.rs',
      'src-tauri/src/settings.rs',
      'src-tauri/src/commands/library.rs',
    ];
    const offenders = modules.filter((path) => !read(path).split(/\r?\n/).slice(0, 40).some((line) => line.trimStart().startsWith('//!')));
    expect(offenders, `这些模块缺 //! 文件头：${offenders.join('、')}`).toEqual([]);
  });
});
