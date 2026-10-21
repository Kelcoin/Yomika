import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 去码（Aletheia-Lens 修补）这一档在 2026-10-14 整条下线：宿主、worker、算力核心、协议、
 * 前端与脚本里的入口全部删掉，只留下 README/轮次文档里的历史叙述。
 *
 * 为什么要有这么一份「扫文本」的判据：删除是最容易「看起来做完」的一类改动——命令没了、
 * 测试绿了，可某个枚举里还留着一个再也不会被产出的 kind，某个脚本还在跑一条已经不存在的
 * 套件，某个枚举分支还在等一个永远不会来的授权。这些残留不会让任何一条**现有**用例转红，
 * 只会在下一次有人照着旧名字找代码时被误导。
 *
 * 判据的牙：把任意一个 `decensor` 记号写回 `src/` 或 `src-tauri/` 下的任意一个源文件，
 * 这份用例立刻转红（变异脚本 debug_outputs/mobile-round/mutations/decensor-retired.ps1）。
 */

// vitest 从仓库根跑（`RUN v4.1.11 E:/Document/GitHub/Yomika`），而 `import.meta.url` 在这里
// 不一定是 file: 方案（转译之后就吃过一次 `The URL must be of scheme file`），直接用 cwd。
const root = process.cwd();

/** 只认源码文本；构建产物、依赖、随包模型与二进制资源都不在扫描范围里。 */
const SKIP_DIRS = new Set([
  '.git',
  'dist',
  'gen',
  'node_modules',
  'resources',
  'target',
  'testdata',
  'vendor',
]);

const SUFFIXES = ['.rs', '.ts', '.tsx', '.mjs', '.js'];

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function exists(path: string): boolean {
  return existsSync(resolve(root, path));
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  if (!exists(dir)) {
    return found;
  }
  for (const entry of readdirSync(resolve(root, dir))) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const relative = `${dir}/${entry}`;
    const absolute = resolve(root, relative);
    if (statSync(absolute).isDirectory()) {
      sourceFiles(relative, found);
      continue;
    }
    if (SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
      found.push(relative);
    }
  }
  return found;
}

/** 三条树：宿主、worker、算力核心（含协议）。前端的 src/ 单独扫。 */
const TREES = ['src-tauri/src', 'src-tauri/worker/src', 'src-tauri/crates'];

describe('去码这一档已经整条下线', () => {
  it('源码树里再没有哪一处提到去码', () => {
    const offenders: string[] = [];
    for (const tree of TREES) {
      for (const file of sourceFiles(tree)) {
        const text = read(file);
        // 只看记号本身：中文的「去码」在历史注释里可以留，英文写法不行——枚举、命令名、
        // 协议字段、错误码全靠它认路。连字符那一版（`de-censor`）也要算：它躲过只认
        // `decensor` 的正则，上一版就是这么漏掉了两处。
        if (/de[-\s]?censor/i.test(text)) {
          const line = text.split('\n').findIndex((item) => /de[-\s]?censor/i.test(item)) + 1;
          offenders.push(`${file}:${line}`);
        }
      }
    }
    expect(offenders, `这几处还在说去码：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('前端也再没有哪一处提到去码', () => {
    const offenders = sourceFiles('src').filter((file) => /de[-\s]?censor/i.test(read(file)));
    expect(offenders, `这几处还在说去码：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('去码自己的模块一个都不在了', () => {
    for (const path of [
      'src-tauri/crates/compute-core/src/decensor.rs',
      'src-tauri/crates/compute-core/src/inpaint.rs',
      'src-tauri/crates/compute-core/src/detect.rs',
      'src-tauri/src/compute/decensor.rs',
      'src-tauri/src/inference/decensor.rs',
      'src-tauri/src/inference/inpaint.rs',
      'src-tauri/worker/src/decensor.rs',
      'src-tauri/tests/compute_decensor_chain.rs',
      'src-tauri/resources/models/models-v1.manifest.json',
    ]) {
      expect(exists(path), `${path} 还在`).toBe(false);
    }
  });

  it('整轮验证入口不再跑一条已经没有的套件', () => {
    const script = read('.github/scripts/verify-round.ps1');
    expect(script).not.toMatch(/decensor/i);
  });

  it('缓存与统计的那套 kind 名单里不再留着永远不会再产出的那一档', () => {
    const cache = read('src-tauri/src/cache.rs');
    // 按**声明**切，不按名字切：常量名在文件头与别处也会被提到（2026-10-16 给 cache.rs
    // 补文件头时正好撞上——按名字切会切到注释里那一次，右边切出来是空串）。
    // 声明自带长度标注（`[&str; 5]`），所以从名字往后找到第一个 `=` 再吃到 `;`。
    const declaration = (name: string): string => {
      const match = new RegExp(`const ${name}[^=]*=([^;]*)`).exec(cache);
      return match?.[1] ?? '';
    };
    const renditions = declaration('IMAGE_RENDITIONS');
    expect(renditions).toContain('dlssnr');
    expect(renditions).not.toContain('decensored');
    // 阅读会话清理的名单同样是「只清真正还会产出的那几档」。
    const session = declaration('READER_SESSION_RENDITIONS');
    expect(session).toContain('dlssnr');
    expect(session).not.toContain('decensored');
  });
});
