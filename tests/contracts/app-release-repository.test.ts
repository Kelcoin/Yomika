import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

/** 本体更新检查打的是 GitHub 的哪个仓库。这个 slug 现在有两处来源：`package.json`
 * 的 `repository`（前端 `__APP_REPOSITORY__` 也从它来）和 `app_release.rs` 里的常量。
 * 两处漂了就会出现「关于页写着 A、更新检查盯着 B」这种谁都不报的错，所以钉一条合同。 */
describe('app release repository', () => {
  it('checks the same repository the package advertises', () => {
    const pkg = JSON.parse(read('package.json')) as { repository?: { url?: string } };
    const fromPackage = (pkg.repository?.url ?? '')
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/\.git$/, '');
    expect(fromPackage).toMatch(/^[\w.-]+\/[\w.-]+$/);

    const rust = read('src-tauri/src/app_release.rs');
    expect(rust).toContain(`const APP_REPOSITORY: &str = "${fromPackage}";`);
    // 两个地址都从那个 slug 拼出来：任何一处写死都会在换仓库时漂掉。
    expect(rust).toContain('api.github.com/repos/{APP_REPOSITORY}/releases/latest');
    expect(rust).toContain('github.com/{APP_REPOSITORY}/releases/latest');
  });
});
