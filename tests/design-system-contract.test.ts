import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
// 归一化行尾：git 的 autocrlf checkout 会把源文件写成 CRLF，而合同的换行
// 断言只应关心内容本身。
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

type Rgb = [number, number, number];

function cssVariables(block: string): Map<string, string> {
  const variables = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) variables.set(name, value.trim());
  }
  return variables;
}

/** The token file is wrapped in `@layer tokens`, so a rule body cannot be found
 * by scanning to the next line-initial `}` — that would swallow the rest of the
 * layer and merge the dark overrides into the light theme. Count braces. */
function ruleBody(css: string, selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{`).exec(source);
  const open = match ? match.index + match[0].lastIndexOf('{') : -1;
  if (open < 0) throw new Error(`Rule not found: ${selector}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && (depth -= 1) === 0) return source.slice(open + 1, index);
  }
  throw new Error(`Unbalanced rule: ${selector}`);
}

/** A rule that lives inside a media block, where every line is indented. The
 * first match for the bare selector would be the base rule instead. */
function nestedRuleBody(css: string, selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\n  ${escaped}\\s*\\{`).exec(source);
  if (!match) throw new Error(`Nested rule not found: ${selector}`);
  const open = match.index + match[0].lastIndexOf('{');
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && (depth -= 1) === 0) return source.slice(open + 1, index);
  }
  throw new Error(`Unbalanced nested rule: ${selector}`);
}

function rgb(value: string, backdrop?: Rgb): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as Rgb;
  const channels = value.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?\s*\)$/);
  if (!channels) throw new Error(`Unsupported test color: ${value}`);
  const foreground = channels.slice(1, 4).map(Number) as Rgb;
  const alpha = Number(channels[4] ?? 1);
  return foreground.map((channel, index) => Math.round(channel * alpha + (backdrop?.[index] ?? 255) * (1 - alpha))) as Rgb;
}

function contrast(left: Rgb, right: Rgb): number {
  const luminance = (color: Rgb) => 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
  const leftLuminance = luminance(left);
  const rightLuminance = luminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

describe('design system contract', () => {
  it('does not stretch shelf errors into a full-page obstruction', () => {
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.shelf-workspace\s*>\s*\.form-error\s*\{[^}]*align-self:\s*start/);
  });
  it('binds the supplied logo assets to native builds', () => {
    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as { bundle?: { icon?: string[] } };
    expect(config.bundle?.icon).toEqual(expect.arrayContaining([
      'icons/32x32.png',
      'icons/128x128.png',
      'icons/128x128@2x.png',
      'icons/icon.ico',
      'icons/icon.icns',
    ]));
  });

  it('keeps form controls and actions on semantic theme tokens', () => {
    const base = read('src/styles/base.css');
    const buttonRule = base.match(/button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(base).toMatch(/input,\s*select,\s*textarea\s*\{[\s\S]*?background:\s*var\(--control-background\)/);
    expect(buttonRule).toMatch(/font-family:\s*inherit/);
    expect(buttonRule).toMatch(/align-items:\s*center/);
  });

  it('gives every settings section one full-width column', () => {
    const shell = read('src/styles/shell.css');
    // One rule for both, and one column. A fixed label column used to hold the
    // section title the sidebar already shows: it left a blank strip beside
    // every control, and a section whose content was its own first child (sync,
    // about) was laid out *inside* that strip at a fraction of the width.
    const settingsRule = shell.match(/\.settings-section,\s*\n\.preferences-panel\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(settingsRule).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(settingsRule).not.toMatch(/grid-template-columns:[^;]*\d+px/);
    expect(shell).toMatch(/\.settings-section > \*,\s*\n\.preferences-form\s*\{[\s\S]*?min-width:\s*0/);
    expect(shell).toMatch(/\.legacy-import-form\s*\{[\s\S]*?max-width:\s*680px/);
    expect(shell).toMatch(/\.legacy-import-form textarea\s*\{[\s\S]*?width:\s*100%/);
    expect(shell).toMatch(/\.legacy-import-form > input\s*\{[\s\S]*?width:\s*100%/);
  });

  it('defines compact metadata and category surface tokens', () => {
    const tokens = read('src/styles/tokens.css');
    const shell = read('src/styles/shell.css');
    expect(tokens).toMatch(/--category-manga:/);
    expect(tokens).toMatch(/--category-doujinshi:/);
    expect(shell).toMatch(/\.metadata-chip\s*\{/);
    expect(shell).toMatch(/\.archive-row-category\[data-category='Manga'\][\s\S]*border-color:/);
    expect(shell).toMatch(/\.archive-row-category\[data-category='Cosplay'\][\s\S]*background:/);
  });

  it('defines semantic card and reader surface tokens', () => {
    const tokens = read('src/styles/tokens.css');
    const reader = read('src/styles/reader.css');
    expect(tokens).toMatch(/--shadow-card:/);
    expect(tokens).toMatch(/--brand-vermilion-strong:/);
    expect(tokens).toMatch(/--reader-border:/);
    expect(tokens).toMatch(/--reader-backdrop:/);
    expect(tokens).toMatch(/--z-reader-chrome:/);
    expect(tokens).toMatch(/--z-reader-overview:/);
    // 颜色字面量的全域禁令在「keeps literal colors out of component stylesheets」
    // 那条里（同样的三张表、同样先剥注释），这里只留令牌本身与结构禁令。
    expect(reader).not.toMatch(/--radius-panel/);
  });

  it('keeps compact content above navigation without a padded black band', () => {
    const shell = read('src/styles/shell.css');
    const compactMain = shell.match(/@media \(max-width: 900px\)[\s\S]*?\.app-main\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const archiveList = ruleBody(shell, '.archive-list');
    // 底栏占位与底部安全区要减掉；顶部安全区不能减——box-sizing: border-box 下
    // padding-top 已经算在 height 里，减第二次就会在底栏上方留下一段 body 底色的
    // 空带（手机上就是底栏之上那条黑带）。
    expect(compactMain).toMatch(/height:\s*calc\(100dvh - \(64px \+ var\(--safe-bottom\)\)\)/);
    expect(compactMain).not.toMatch(/100dvh - \(64px \+ var\(--safe-bottom\) \+ var\(--safe-top\)\)/);
    expect(compactMain).toMatch(/padding-top:\s*var\(--safe-top\)/);
    expect(archiveList).toMatch(/background:\s*var\(--surface-panel\)/);
    expect(shell).not.toMatch(/\.workspace\.is-library-workspace \.archive-list\s*\{[\s\S]*padding-bottom:\s*calc\(80px/);
  });

  it('routes every safe-area inset through the tokens, never through env() inline', () => {
    // 一处来源：iOS 由 WebKit 提供 env()，Android 由原生侧给 WebView 加内边距
    // （Chromium 不给状态栏高度）——组件样式只认变量，换平台时只动 tokens。
    const tokens = read('src/styles/tokens.css');
    expect(tokens).toMatch(/--safe-top:\s*env\(safe-area-inset-top,\s*0px\)/);
    expect(tokens).toMatch(/--safe-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/);
    for (const path of ['src/styles/shell.css', 'src/styles/reader.css']) {
      expect(read(path)).not.toMatch(/env\(safe-area-inset/);
    }
    // 移动端要读出非零安全区，view 声明必须带 viewport-fit=cover。
    expect(read('index.html')).toMatch(/viewport-fit=cover/);
    // 自绘标题栏只属于 Windows，且自己吃掉顶部安全区。窗口的拖动与缩放由原生那侧
    // 负责（decorations 关掉系统边框），所以这一条盯的是几何，不是性能开关。
    const titlebar = ruleBody(read('src/styles/shell.css'), '.titlebar');
    expect(titlebar).toMatch(/height:\s*calc\(44px \+ var\(--safe-top\)\)/);
    expect(read('src-tauri/src/lib.rs')).toMatch(/builder\.decorations\(cfg!\(not\(target_os = "windows"\)\)\)/);
    expect(ruleBody(read('src/styles/shell.css'), '.app-main')).toMatch(/background:\s*var\(--surface-panel\)/);
    expect(read('src/components/AppShell.tsx')).toMatch(/\{showTitleBar && <TitleBar \/>\}/);
  });

  it('pins the page scale and keeps text controls off the focus-zoom threshold', () => {
    // 这是个应用，不是一篇文档：整个界面不能被双指捏着缩放。少了这两项，手机上
    // 一捏界面就浮起来、工具栏跑出屏幕，一眼看得出来是网页套了个壳。
    const html = read('index.html');
    expect(html).toMatch(/maximum-scale=1(?:\.0)?/);
    expect(html).toMatch(/user-scalable=no/);

    // 阅读模式的缩放不能被这两项牵连：它不是浏览器缩放，是页帧上的 transform，
    // 手势也归画布自己管——ReaderScreen 按布局把 touch-action 写在画布上，连续
    // 模式让浏览器纵向滚动，单页/双页整个交给自己的双击、双指与滚轮。
    const reader = read('src/components/ReaderScreen.tsx');
    expect(reader).toMatch(/transform: `scale\(\$\{zoom\.scale\}\)/);
    expect(reader).toMatch(/touchAction: effectiveLayout === 'webtoon' \? 'pan-y' : 'none'/);
    // 阅读页里没有任何文本控件，所以下面那条字号下限够不到它。
    expect(reader).not.toMatch(/<input|<textarea|<select/);

    // 移动端 WebView 聚焦时会放大「算出来小于 16px」的输入框所在的页面，阈值只看
    // 控件自己的字号。控件是 font: inherit，而说明文字的 label 按 --text-xs 排
    // （.server-form、.metadata-form），里面的输入框就跟着掉到阈值以下——所以下限
    // 补在控件这一层，而且要压得过直接写在控件上的字号。
    const coarse = ruleBody(read('src/styles/base.css'), '@media (pointer: coarse)');
    expect(coarse).toMatch(/input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\)/);
    expect(coarse).toMatch(/textarea/);
    expect(coarse).toMatch(/font-size:\s*max\(16px,\s*1em\)\s*!important/);
  });

  it('parks the compact bar only while it floats, and leaves the docked row empty', () => {
    const shell = read('src/styles/shell.css');
    const app = read('src/components/AppShell.tsx');
    const base = read('src/styles/base.css');

    // 悬浮胶囊盖在内容上，滚动容器才需要补出它那 80px；整条 fixed 的底栏本来就占
    // 一行（.app-main 的高度里减掉了），再补出来的只是一块同色空带——手机上就是
    // 底栏之上那一大块「遮挡」。
    const [padded] = shell.split('padding-bottom: calc(var(--safe-bottom) + 80px)');
    expect(padded!.trimEnd()).toMatch(/\.app-shell\.is-floating-nav \.workspace\.is-library-workspace \{$/);
    // 收不收底栏由悬浮开关决定：没开悬浮时它有自己的行，不该被滚动带走。
    expect(app).toMatch(/if \(floatingNav\) \{\s*if \(current > 8 && current > before\)/);
    // 触屏没有 Tab 键，跳过链接用不上；它在 WebKit 里会被点按命中 :focus-visible，
    // 常驻成状态栏那一角的胶囊。CSS 按媒体特性挡一层，AppShell 再按平台挡一层。
    expect(shell).toMatch(/@media \(hover: none\) and \(pointer: coarse\) \{\s*\.skip-link \{ display: none; \}/);
    expect(app).toContain('{showSkipLink && <a className="skip-link"');
    // 模型下载按钮悬停只让字形变色，不铺一层底色。
    expect(base).toMatch(/\.select-option-download:hover:not\(:disabled\) \{ color: var\(--brand-vermilion\); \}/);
    expect(base).not.toMatch(/\.select-option-download:hover[^}]*background/);
  });

  it('shows one shared server prompt on every page that needs a server', () => {
    // 同一个状态原来有三种长相：首页内联的 .first-run、书架那版的 EmptyState、档案库
    // 那版干脆一直转骨架屏。现在只有 ServerRequiredPrompt 一份。
    const routes = read('src/app/routes.tsx');
    const library = read('src/components/LibraryRouteWorkspace.tsx');
    const prompt = read('src/components/ServerRequiredPrompt.tsx');
    const shell = read('src/styles/shell.css');

    expect(prompt).toContain('className="first-run"');
    expect(prompt).toContain('/settings?section=sync');
    expect(routes).toContain('<ServerRequiredPrompt />');
    expect(library).toContain('<ServerRequiredPrompt />');
    // 书架那版「尚未连接 LANraragi」的 EmptyState 已退役；首页剩下的另一处
    // .first-run 是「无法读取服务器」的报错态，复用同一套样式，不是这个提示。
    expect(routes).not.toContain('尚未连接 LANraragi');
    // 没有服务器时档案库不该停在首屏骨架屏上：确认过没有可用服务器就换提示。
    expect(library).toContain('hasServer === false');

    // 位置也归一份管。三处宿主各加各的内边距——首页的 workspace 上边 32px、档案库
    // 的列表面板 16px、书架什么都没加——只排 .first-run 就会算出三个高度（实测
    // 76 / 60 / 44）。所以外面统一加一层 .first-run-page：宿主给过的写 0，没给的
    // 补成同一份。
    expect(prompt).toContain('className="first-run-page"');
    expect(routes).toMatch(/<div className="first-run-page">/);
    expect(ruleBody(shell, '.first-run-page')).toMatch(/padding-block-start:\s*var\(--space-8\)/);
    expect(ruleBody(shell, '.workspace-home > .first-run-page')).toMatch(/padding-block-start:\s*0/);
    expect(ruleBody(shell, '.library-shell-list .first-run-page')).toMatch(/padding-block-start:\s*var\(--space-4\)/);

    // 形状是设置项那种容器：一个圆角描边卡片，动作在底部自己的容器里。以前是上下
    // 两条整幅分割线夹一段文案——页面上像两条与这个提示无关的横线。
    expect(ruleBody(shell, '.first-run')).toMatch(/border:\s*1px solid var\(--outline-variant\)/);
    expect(ruleBody(shell, '.first-run')).toMatch(/border-radius:\s*var\(--radius-card\)/);
    expect(ruleBody(shell, '.first-run')).not.toMatch(/border-(top|bottom):/);
    expect(ruleBody(shell, '.first-run-actions')).toMatch(/border-top:\s*1px solid var\(--hairline\)/);
    // 云端同步不只 WebDAV：S3 兼容存储同样能恢复配置。
    expect(prompt).toContain('WebDAV 或 S3 兼容存储');
    expect(prompt).not.toContain('从 WebDAV 同步');
  });

  it('runs the divider under a page’s top bar out to the column edges', () => {
    // 用户报告：档案库、书架、本地档案页顶部组件下面那条分隔线两端各缺一截。
    // 根因是这条线画在 `.library-panels` / `.local-archives-list` 自己的 border-top
    // 上，而这两层都住在 `.library-shell-list`（`padding: var(--space-4) var(--space-4) 0`）
    // 的内容盒里 —— 线跟着盒子一起左右各内缩 16px。
    // 往两侧各拉出一个间距，再用同宽的内边距把内容推回原位：线到列边缘，内容一格不差。
    const shell = read('src/styles/shell.css');
    expect(ruleBody(shell, '.library-panels')).toMatch(/margin-inline:\s*calc\(-1 \* var\(--space-4\)\)/);
    expect(ruleBody(shell, '.library-panels')).toMatch(/padding-inline:\s*var\(--space-4\)/);
    expect(ruleBody(shell, '.library-panels')).toMatch(/border-top:\s*1px solid var\(--hairline\)/);
    // 本地档案页的列表是 `.archive-list`，它自己有 4px 内边距，补回来时要带上。
    expect(ruleBody(shell, '.local-archives-list')).toMatch(/margin-inline:\s*calc\(-1 \* var\(--space-4\)\)/);
    expect(ruleBody(shell, '.local-archives-list')).toMatch(/padding-inline:\s*calc\(var\(--space-4\) \+ var\(--space-1\)\)/);
  });

  it('keeps app-level overlays out of the page’s own stacking contexts', () => {
    // 浮层的 z-index 要真的比底栏大，两边就得在同一个层叠上下文里。页面容器会自己
    // 建层叠上下文——`.library-shell-list` 的 --z-raised 是为了让列表面板压在详情
    // 面板上，`.workspace` 的入场动画曾经留下一个 translateY(0)——手写的全屏浮层
    // 留在里面，z-index 就被关住了，底栏于是永远压在设置菜单 / 检索预设 / 封面预览
    // 之上。Radix 的对话框（Dialog.Portal）和标签建议一直是挂到 body 的，手写浮层
    // 现在也走同一条路。
    const shell = read('src/styles/shell.css');
    // 菜单容器（SettingsMenu 与它的两个控件）现在住在 SettingsValueControls 里：
    // 设置页与 DLSS5 / 算力中心两组共用同一套，标记本身没变。
    const controls = read('src/components/SettingsValueControls.tsx');
    const preset = read('src/components/SearchPresetField.tsx');

    expect(read('src/components/OverlayLayer.tsx')).toMatch(/createPortal\(children, document\.body\)/);
    expect(controls).toMatch(/<OverlayLayer>\s*<div className="settings-choice-overlay"/);
    expect(preset).toMatch(/<OverlayLayer>\s*<div className="search-preset-overlay"/);
    // 浮层挂出去以后，面板里的点击不再算「在 field 里」，外点关闭必须放过它，
    // 否则指针一按下按钮就被卸载，click 永远到不了按钮。
    expect(preset).toContain("if (target?.closest?.('.search-preset-overlay')) return;");

    // 入场动画不能留填充值：translateY(0) 也是一个不是 none 的 transform，它会让
    // .workspace 同时变成层叠上下文和 position: fixed 子元素的包含块（浮层被裁到
    // 内容区，而不是盖住整个窗口）。backwards 只在动画开始前生效，结束后什么都不留。
    // 时长与曲线走 `--motion-standard`（原来手写的 0.28s + 同一条曲线，时长漂了）。
    expect(ruleBody(shell, '.workspace')).toMatch(/animation:\s*workspace-in\s+var\(--motion-standard\)\s+backwards/);
    expect(ruleBody(shell, '.workspace')).not.toMatch(/animation:[^;]*\bboth\b/);

    // 层序本身也是合同：底栏 < 菜单 < 遮罩 < 模态。
    const tokens = cssVariables(ruleBody(read('src/styles/tokens.css'), ':root'));
    const z = (name: string) => Number(tokens.get(name));
    expect(z('--z-compact-nav')).toBeLessThan(z('--z-menu'));
    expect(z('--z-menu')).toBeLessThan(z('--z-overlay'));
    expect(z('--z-overlay')).toBeLessThan(z('--z-modal'));
  });

  it('draws the E-Hentai row like the other settings icons and reports download progress', () => {
    const settings = read('src/components/SettingsWorkspace.tsx');
    const mark = read('src/components/EhMark.tsx');

    // 设置项里其余图标都是 lucide 那样的描边字形，带 primary-container 底板的品牌
    // 标记只有账户面板那种展示位才用。
    expect(settings).toContain('<EhMark plate={false} />');
    expect(settings).toContain('<EhMark size={20} plate={false} />');
    expect(mark).toContain('scale(0.0909)');
    // 模型下载的进度来自后端的 model-download-progress 事件，行内给进度条与百分比。
    // 监听还在工作区里；进度条那截标记后来搬进了共享控件文件（DLSSNR 的变体行也要用它，
    // 留在这里会绕出 工作区 ↔ DLSSNR 的 import 环），所以两处各断一句。
    expect(settings).toContain('model-download-progress');
    expect(read('src/components/ModelDownloadControls.tsx')).toContain('model-download-status');
  });

  it('keeps the archive count in the product font on the status bar', () => {
    // The count lives in a status-bar entry now; the old .library-heading > span
    // (and its dead wrapper classes) are gone from both markup and stylesheet.
    const shell = read('src/styles/shell.css');
    expect(shell).not.toMatch(/\.archive-row-meta\s*\{/);
    expect(shell).not.toMatch(/\.library-heading/);
    expect(shell).toMatch(/\.status-item\s*\{[^}]*font-family:\s*var\(--font-body\)/);
  });

  it('enables the native Windows credential backend for release builds', () => {
    const cargo = read('src-tauri/Cargo.toml');
    expect(cargo).toMatch(/keyring\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*['"]windows-native['"]/s);
  });

  it('keeps the reader off an animation runtime', () => {
    // 两条栏的淡入淡出曾经用 `motion` 的 `AnimatePresence`，代价是整个动画运行时跟着
    // 阅读器那一个 chunk 走：`ReaderRoute-*.js` 从 170KB（55KB gzip）掉到 45KB
    // （15KB gzip）就是把这一条依赖拿掉的结果。入场是 CSS 动画，出场是一个 260ms
    // 的延迟状态（`useDelayedUnmount`），两样都不需要运行时。
    const reader = read('src/components/ReaderScreen.tsx');
    expect(reader).not.toMatch(/from 'motion/);
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('motion');
    // 两条栏的出入场确实落在 CSS 里，而不是又被搬回 JS。
    const css = read('src/styles/reader.css');
    expect(css).toMatch(/@keyframes reader-chrome-top-in/);
    expect(css).toMatch(/@keyframes reader-chrome-bottom-out/);
    expect(ruleBody(css, '.reader-chrome-top')).toMatch(/animation:\s*reader-chrome-top-in/);
    expect(css).toMatch(/\.reader-chrome-top\.is-leaving \{\s*animation:\s*reader-chrome-top-out/);
  });

  it('draws the tray menu itself instead of handing it to Windows', () => {
    // 系统托盘菜单有两处改不了，也是用户 2026-09-30 报的那两条：宽度由「图标栏 + 内边距」
    // 算出来（两个双字条目实测约 121px，见 debug_outputs/refs/tray-menu.png），悬停高亮
    // 是矩形、和圆角边框对不上。所以菜单改成应用自己画的一个无边框透明小窗口。
    const rust = read('src-tauri/src/tray_menu.rs');
    const css = read('src/styles/tray-menu.css');
    const lib = read('src-tauri/src/lib.rs');

    // 窗口尺寸在 Rust 与 CSS 两处写死同一件事：对不上就是菜单被裁一半或四周多一块透明边。
    // 断言的是**算出来的和**，不是再抄一遍数字：容器上下各 1px 边框 + 4px 内边距，再加
    // 两条条目——条目高度与内边距都从 CSS / tokens 里现读，所以改设计时只有一处可改。
    const itemHeight = Number(/height:\s*(\d+)px/.exec(ruleBody(css, '.tray-menu-item'))?.[1]);
    const space1 = Number(/--space-1:\s*(\d+)px/.exec(read('src/styles/tokens.css'))?.[1]);
    const rows = (read('src/components/TrayMenu.tsx').match(/\{ action: '[a-z]+', label: /g) ?? []).length;
    expect(itemHeight).toBeGreaterThan(0);
    expect(space1).toBeGreaterThan(0);
    expect(rows).toBe(2);
    const expectedHeight = itemHeight * rows + space1 * 2 + 1 * 2;
    expect(rust).toMatch(new RegExp(`pub const MENU_HEIGHT: f64 = ${expectedHeight}\\.0;`));
    expect(css).toMatch(/\.tray-menu \{[\s\S]*?inset:\s*0/);
    // 84px 是**窄于**系统菜单的：参考图里两个双字条目的系统菜单约 121px。
    expect(rust).toMatch(/pub const MENU_WIDTH: f64 = 84\.0;/);
    // 创建时的尺寸会被系统夹到 SM_CXMINTRACK（这台机器 96 DPI 下实测 136×39，150% 缩放下
    // 202×56），而 SetWindowPos 不受这个下限约束——所以建好之后必须再显式设一次，否则菜单
    // 是 136 宽，比系统菜单还宽。
    expect(rust).toMatch(/window\.set_size\(tauri::LogicalSize::new\(MENU_WIDTH, MENU_HEIGHT\)\)/);
    // 透明 + 无边框：12px 圆角之外必须是桌面本身。
    expect(rust).toMatch(/\.transparent\(true\)/);
    expect(rust).toMatch(/\.decorations\(false\)/);
    expect(rust).toMatch(/\.shadow\(false\)/);
    // 托盘不再挂系统菜单；右键弹的是这个窗口。（注释里提到旧写法是允许的。）
    expect(lib).not.toMatch(/MenuBuilder::new/);
    expect(lib).not.toMatch(/\.menu\(&/);
    expect(lib).toMatch(/show_menu_on_left_click\(false\)/);
    expect(lib).toMatch(/TrayIconEvent::Click \{ button: MouseButton::Right/);
    // 左键仍然能把主窗叫回来：菜单万一没弹出来，应用不能变成只有右键够得着的东西。
    expect(lib).toMatch(/MouseButton::Left/);
    // 第二个入口是独立文档（只为两条菜单项，不该拉整个应用 bundle）。
    expect(read('vite.config.ts')).toMatch(/'tray-menu': entry\('\.\/tray-menu\.html'\)/);

    // 悬停高亮是**内缩的胶囊**：容器留 4dp，条目自己再圆一档——不是顶到边框的矩形。
    expect(ruleBody(css, '.tray-menu')).toMatch(/padding:\s*var\(--space-1\)/);
    expect(ruleBody(css, '.tray-menu')).toMatch(/border-radius:\s*var\(--radius-card\)/);
    const item = ruleBody(css, '.tray-menu-item');
    expect(item).toMatch(/border-radius:\s*var\(--radius-control\)/);
    // 字号与其它菜单同一档（13px）：14px 让两个双字条目落在一个大半是空白的方框里。
    expect(ruleBody(css, '.tray-menu')).toMatch(/font-size:\s*var\(--text-sm\)/);
    expect(css).toMatch(/\.tray-menu-item:hover,[\s\S]*?background:\s*var\(--surface-container-highest\)/);
    // 「退出」不带危险色：悬停和「打开」是同一层墨色（用户指定的）。
    expect(css).not.toMatch(/--error-container/);
    expect(read('src/components/TrayMenu.tsx')).not.toMatch(/is-danger/);
    // 焦点也不预置：程序化聚焦会被浏览器算成键盘操作（`:focus-visible` 命中），第一条
    // 就永远带着一块悬停底色——用户报的「打开选项 hover 常驻不消失」。
    expect(read('src/components/TrayMenu.tsx')).not.toMatch(/focusItem\(0\)/);
  });

  it('gives the tray its own mark, not the app icon', () => {
    // 托盘给的 16px 上，print 那版标记的 18/512 笔画是 0.56px — 整块糊成一团灰
    // （用户报的「小尺寸下很难看清」）。所以托盘用的是单独一份：`assets/yomika-tray.svg`
    // 是源头，`icons/tray-32.png` 是 `npx tauri icon` 出来的、被 include_bytes! 编进 exe。
    const lib = read('src-tauri/src/lib.rs');
    const cargo = read('src-tauri/Cargo.toml');
    expect(lib).toMatch(/include_bytes!\("\.\.\/icons\/tray-32\.png"\)/);
    expect(lib).toMatch(/Image::from_bytes\(/);
    // 解不出来要退回应用图标：托盘没有图标比图标糊一点糟得多。
    expect(lib).toMatch(/app\.default_window_icon\(\)\.cloned\(\)/);
    // 那条 `Image::from_bytes` 要能解码 PNG，靠的是这个特性。
    expect(cargo).toMatch(/tauri\s*=\s*\{[^}]*"image-png"/);

    // 源头、产物、以及「产物是从源头来的」都要在仓库里说得清。
    expect(read('assets/yomika-tray.svg')).toContain('Yomika tray mark');
    expect(read('src-tauri/icons/README.md')).toContain('tray-32.png');
    const tray = read('src-tauri/src/tray_menu.rs');
    expect(tray).toMatch(/fn the_embedded_tray_bitmap_decodes_to_a_non_empty_icon/);
  });

  it('keeps the toast above menus, their backdrop and dialogs', () => {
    // toast 说的是刚刚发生的那件事：被二级菜单那道 fixed 遮罩盖住就等于没发生。
    const tokens = read('src/styles/tokens.css');
    const zIndexOf = (name: string) => Number(new RegExp(`${name}:\\s*([0-9]+)`).exec(tokens)?.[1] ?? -1);
    expect(zIndexOf('--z-toast')).toBeGreaterThan(zIndexOf('--z-modal'));
    expect(zIndexOf('--z-modal')).toBeGreaterThan(zIndexOf('--z-overlay'));
    expect(ruleBody(read('src/styles/shell.css'), '.toast-stack')).toMatch(/z-index:\s*var\(--z-toast\)/);
    // 并且要挂到 body 上：留在页面容器里，容器自己的层叠上下文会把它关在里面
    //（浮层当初就是因为这个改用 portal 的）。
    expect(read('src/components/Toast.tsx')).toMatch(/<OverlayLayer>\s*<div className="toast-stack"/);
  });

  it('keeps the tag chip tight to its delete button and never clips a fitting label', () => {
    // 用户报的两件事都在这几行里：✕ 与文字之间空到 12px（两边都留 8），以及「明明放得下
    // 却被截断」——量出来的是小数（`somebody` 61.05px），四舍五入到 61 就比文字窄，于是
    // `text-overflow: ellipsis` 把最后一个字换成省略号。实测 8 枚里 3 枚这样。
    const shell = read('src/styles/shell.css');
    const reveal = ruleBody(shell, '.metadata-tag-reveal');
    expect(reveal).toMatch(/padding:\s*0 2px 0 8px/);
    // 宽度公式与那条 padding 一一对应（+10 = 左 8 + 右 2）。
    expect(shell).toMatch(/\.metadata-tag\.is-measured \.metadata-tag-reveal \{[^}]*width:\s*calc\(var\(--tag-width-rest\) \+ 10px\)/);
    expect(shell).toMatch(/\.metadata-tag\.is-measured\.is-revealed \.metadata-tag-reveal \{[^}]*width:\s*calc\(var\(--tag-width-revealed\) \+ 10px\)/);

    const chip = read('src/components/MetadataTagChip.tsx');
    expect(chip).toMatch(/\$\{Math\.ceil\(sizes!\.translatedWidth\)\}px/);
    expect(chip).toMatch(/\$\{Math\.ceil\(sizes!\.originalWidth\)\}px/);
    expect(chip).not.toMatch(/Math\.round\(sizes!/);

    // 行的换行预留跟着 chip 的固定开销走：左 8 + 右 2 + ✕ 22 + 边框 2。
    expect(read('src/components/MetadataTagRows.tsx')).toMatch(/Math\.max\(originalWidth, translatedWidth\) \+ 34/);
  });

  it('centers the second-level menu title with the row icon on its left', () => {
    const shell = read('src/styles/shell.css');
    const title = ruleBody(shell, '.settings-choice-title');
    // 居中：菜单顶上的标题不再左对齐——它说的是「这是从哪一行开出来的」。
    expect(title).toMatch(/justify-content:\s*center/);
    expect(title).toMatch(/display:\s*flex/);
    // 比正文大一点（原来是 --text-md）。
    expect(title).toMatch(/font-size:\s*var\(--text-lg\)/);
    expect(shell).toMatch(/\.settings-choice-icon \{[^}]*width:\s*20px/);
    const settings = read('src/components/SettingsWorkspace.tsx');
    const controls = read('src/components/SettingsValueControls.tsx');
    // 图标是**来源那一行的同一个**：三个菜单容器都把 icon 传下去。其中选择与数字
    // 两个已经挪到 SettingsValueControls，第三个（SettingsPanel）还在设置页里。
    expect(controls).toMatch(/className="settings-choice-icon"/);
    const menuIcons = [
      ...(settings.match(/<SettingsMenu[^>]*icon=\{icon\}/g) ?? []),
      ...(controls.match(/<SettingsMenu[^>]*icon=\{icon\}/g) ?? []),
    ];
    expect(menuIcons).toHaveLength(3);
  });

  it('closes overlays with the back gesture instead of leaving the page', () => {
    // 返回手势（以及浏览器后退、iOS 侧滑）走的是 webview 历史：没有守卫的话，菜单开着按返回
    // 会把**下面的页面**带走。每一个浮层都要挂上那道守卫（见 lib/overlayBackGuard）。
    const components = readdirSync(resolve(root, 'src/components'));
    const overlays = components.filter((name) => {
      if (!name.endsWith('.tsx')) return false;
      const source = read(`src/components/${name}`);
      // JSX 属性那种写法（前面是空白），不是选择器字符串里的 `[role="dialog"]`。
      return source.includes('Dialog.Root') || /\srole="dialog"/.test(source);
    });
    expect(overlays.length).toBeGreaterThan(6);
    for (const name of overlays) {
      expect(read(`src/components/${name}`), `${name} 少了 useOverlayBackGuard`).toContain('useOverlayBackGuard(');
    }
  });

  it('keeps the collapsed recommendations tab from inflating the strip', () => {
    // 折叠那一列只剩左右留白时，0 宽的内容盒子会把标签拆成三行——按钮跟着长到三倍行高
    // （实测 39px），整条切换栏被撑到 45px，而加载完是 34px：用户看到的「加载中样式异常」。
    const shell = read('src/styles/shell.css');
    const button = ruleBody(shell, '.archive-recommendations-tabs button');
    expect(button).toMatch(/white-space:\s*nowrap/);
    const collapsed = ruleBody(shell, '.archive-recommendations-tabs .archive-recommendations-tab-creator');
    expect(collapsed).toMatch(/padding-inline:\s*0/);
    // 长出来的时候留白要还回去，否则两个标签会挤在一起。
    expect(shell).toMatch(/\.archive-recommendations-tabs\.has-creator \.archive-recommendations-tab-creator \{[^}]*padding-inline:\s*var\(--space-4\)/);
  });

  it('scrolls the settings menu body instead of clipping a tall form', () => {
    const shell = read('src/styles/shell.css');
    // 面板是 flex 列：只有 flex 会按 max-height 收内容盒，网格的自动行按内容撑开，
    // 长表单会被 overflow:hidden 直接切掉（保存/取消够不着，也无法滚动）。
    const panel = ruleBody(shell, '.settings-choice-panel');
    expect(panel).toMatch(/display:\s*flex/);
    expect(panel).toMatch(/flex-direction:\s*column/);
    // `dvh` 而不是 `vh`：键盘弹起时视口会变矮（Android 侧把视图压短），限高得跟着矮，
    // 否则面板比可见区域还高——底部那一截按钮被键盘盖住。
    expect(panel).toMatch(/max-height:\s*min\(85dvh,\s*760px\)/);
    expect(panel).toMatch(/overflow:\s*hidden/);
    const body = ruleBody(shell, '.settings-menu-body');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/flex:\s*1 1 auto/);
    expect(body).toMatch(/min-height:\s*0/);
    // 标题与说明是选择器列表，ruleBody 只吃单条选择器，这里直接看规则本体。
    expect(shell).toMatch(/\.settings-choice-panel > \.settings-choice-title,\s*\n\.settings-choice-panel > \.settings-menu-desc\s*\{\s*\n\s*flex:\s*none/);
  });

  it('reuses the shared multi-select rows for the sync scope', () => {
    const module = read('src/components/SyncSettings.tsx');
    // 范围勾选就是设置菜单里「底栏项目」那一套行，不再自造复选框；而且它独立成行
    // （自己的 SettingsPanel），不挂在账户表单里。
    expect(module).toMatch(/function SyncScopeChecks[\s\S]*?<CheckRowGroup label="同步范围">/);
    expect(module).toMatch(/<CheckRow[\s\S]*?label=\{category\.label\}/);
    expect(module).not.toMatch(/input\s+type="checkbox"/);
    expect(read('src/styles/shell.css')).not.toMatch(/\.sync-scope-option\b/);
    expect(read('src/components/SettingsWorkspace.tsx')).toMatch(/label="同步范围"/);
    const form = module.slice(module.indexOf('export function SyncAccountForm'));
    expect(form).not.toMatch(/toggleScope|CheckRowGroup/);
  });

  it('draws each multi-value control exactly once', () => {
    // 复选框行、开关与「勾选行组」各只有一份实现：三处复制过的行、两处复制过的
    // 开关，都改成从这里取。任何一处再自己画一个，这条就红。
    const controls = read('src/components/SettingsControls.tsx');
    expect(controls).toMatch(/export function CheckRow\(/);
    expect(controls).toMatch(/export function CheckRowGroup\(/);
    expect(controls).toMatch(/export function SettingsSwitch\(/);
    expect(controls).toMatch(/export function SwitchControl\(/);

    // DeduplicationWorkspace is deliberately absent: a selectable result card is
    // not a check row, and its disc marker is shared a different way.
    const components = ['SettingsWorkspace.tsx', 'SyncSettings.tsx', 'ArchiveDeleteDialog.tsx', 'EhAccountPanel.tsx'];
    for (const file of components) {
      const source = read(`src/components/${file}`);
      // 自带 role="checkbox" 的行、自带 role="switch" 的按钮、直接写出的
      // switch-control 类，都是绕过了共享实现。
      expect(source, file).not.toMatch(/role="checkbox"/);
      expect(source, file).not.toMatch(/role="switch"/);
      expect(source, file).not.toMatch(/className="switch-control"/);
    }
    // 勾选行的类名只在共享实现里出现一次。
    const checkRowClass = ['SettingsWorkspace.tsx', 'SyncSettings.tsx'].map((file) => read(`src/components/${file}`));
    for (const source of checkRowClass) expect(source).not.toMatch(/settings-menu-check/);
  });

  it('keeps one button family and no dead member of it', () => {
    const shell = read('src/styles/shell.css');
    // 主/次按钮共用一段几何：色调才是修饰符。
    expect(shell).toMatch(/\.primary-action,\s*\n\.secondary-action\s*\{/);
    // 曾经各自成套的三个类都不该再出现（注释里提到旧名是允许的）。
    const rules = shell.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/\.settings-action\b/);
    expect(rules).not.toMatch(/\.archive-action-button\b/);
    expect(rules).not.toMatch(/\.danger-action\b/);
    // 危险色调必须是「底色 + 文字」，不是一圈红描边；而且必须有静止态规则，
    // 否则按钮平时还是次级色，只在悬停时才变红。
    const danger = ruleBody(shell, '.secondary-action.is-danger');
    expect(danger).toMatch(/background:\s*var\(--error-container\)/);
    expect(danger).toMatch(/color:\s*var\(--on-error-container\)/);
    expect(danger).not.toMatch(/border/);
    // 动作行平分宽度：声明的容器与实际使用的一致。
    for (const row of ['.sync-form-actions > button', '.settings-menu-actions > .secondary-action', '.archive-detail-actions > .primary-action']) {
      expect(shell.replace(/\/\*[\s\S]*?\*\//g, '')).toContain(row);
    }
  });

  it('uses a two-level settings layout with stable rail targets', () => {
    const shell = read('src/styles/shell.css');
    const settings = read('src/components/SettingsWorkspace.tsx');
    expect(settings).toMatch(/className=\{`settings-layout/);
    expect(settings).toMatch(/className="settings-sidebar"/);
    expect(settings).toMatch(/className="settings-nav"/);
    expect(shell).toMatch(/\.settings-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(164px,\s*208px\)/);
    expect(shell).toMatch(/\.settings-nav a\s*\{[\s\S]*min-height:\s*40px/);
    expect(shell).toMatch(/\.sidebar-toggle\s*\{[\s\S]*flex:\s*0 0 44px/);
    expect(shell).toMatch(/\.segmented-control\s*\{[\s\S]*width:\s*fit-content/);
  });

  it('uses one sidebar hover box and clips detail covers to the visible art', () => {
    const shell = read('src/styles/shell.css');
    const nav = ruleBody(shell, '.nav-link');
    const collapsed = ruleBody(shell, '.is-sidebar-collapsed .side-nav .nav-link');
    const collapsedShell = ruleBody(shell, '.app-shell.is-sidebar-collapsed');
    const collapsedSidebar = ruleBody(shell, '.is-sidebar-collapsed .sidebar');
    const cover = ruleBody(shell, '.archive-detail-route-cover img');
    expect(nav).not.toMatch(/transform:/);
    expect(collapsedShell).toMatch(/grid-template-columns:\s*65px/);
    expect(collapsedSidebar).toMatch(/padding-inline:\s*10px/);
    expect(collapsed).toMatch(/width:\s*44px/);
    expect(collapsed).toMatch(/margin-inline:\s*0/);
    expect(cover).toMatch(/object-fit:\s*cover/);
  });

  it('widens only the visible home panel, not the pages kept mounted beside it', () => {
    // RetainedPage 把访问过的路由都留在 DOM 里，所以 `:has(.workspace-home)` 在离开
    // 首页之后依然命中：每个页面被压到 1680px 并左对齐，右边整块留白。
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(shell).toMatch(/\.workspace:has\(> \.route-cache-panel:not\(\[hidden\]\) \.workspace-home\)/);
    expect(shell).not.toMatch(/\.workspace:has\(\.workspace-home\)/);
  });

  it('lets each home column scroll on its own once the detail is open', () => {
    // 首页平时是 flow：面板随内容长高、整页滚。详情一开，那个「随内容长高」就成了 bug——
    // Group 的内联 height:100% 落到不定高父级上退化成 auto，两栏被拉到「较高那一栏的内容
    // 高度」，详情栏的 height:100% 于是永远等于自己的 scrollHeight，overflow:auto 永远不
    // 溢出、也就永远滚不动；页面上唯一的滚动容器是 .workspace，鼠标落在哪一栏都是滚整页，
    // 两栏一起动。详情打开这一态改成档案库那样的钳定两栏，`is-home` 是那个闸门。
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const home = read('src/components/HomeShell.tsx');
    expect(home).toContain('library-shell is-home');
    expect(shell).toMatch(/\.workspace:has\(> \.route-cache-panel:not\(\[hidden\]\) \.library-shell\.is-home\.has-detail\)\s*\{[^}]*overflow:\s*hidden/);
    expect(shell).toMatch(/\.route-cache-panel\.is-flow:has\(\.library-shell\.is-home\.has-detail\)\s*\{[^}]*height:\s*100%/);
    expect(shell).toMatch(/\.library-shell\.is-home\.has-detail \.library-shell-list\s*\{[^}]*overflow-y:\s*auto/);
    // 900px 及以下首页是「钻进去」的单栏、整页滚：`@media (max-width: 900px)` 那一段把
    // `.library-shell` 拆成 `display: block`、把 `.library-shell-detail` 的 overflow 还原成
    // `visible`。上面这三条要是漏进窄屏，详情栏就被钳在一个 `overflow: hidden` 的盒子里，
    // 内容比屏幕长，而没有任何东西能滚它。
    expect(shell).toMatch(/@media \(min-width: 901px\) \{\s*\.workspace:has\(/);
  });

  it('keeps the detail of each shell on the page that owns it', () => {
    // 详情栏里的推荐条从前一律指向 `/library/:id`：首页或书架的详情点一条推荐，
    // 左边那一栏会跟着换成档案库，等于又从首页/书架溜进了档案库。
    const home = read('src/components/HomeShell.tsx');
    const shelf = read('src/components/ShelfShell.tsx');
    const routes = read('src/app/routes.tsx');
    expect(home).toMatch(/<ArchiveDetailRoute archiveId=\{archiveId\} detailBasePath="\/home" \/>/);
    expect(shelf).toMatch(/<ArchiveDetailRoute archiveId=\{archiveId\} detailBasePath=\{detailBasePath\} \/>/);
    expect(routes).toContain('<ShelfShell name="history" detailBasePath="/history">');
    expect(routes).toContain('<ShelfShell name="toRead" detailBasePath="/to-read">');
  });

  it('draws card tags and detail panes from one implementation each', () => {
    // 本地档案页原来各写一套：标签直接摆原始列表（顺序、范围、My Tags 染色全丢），
    // 详情是自带的 <dl>。现在三方共用同一批组件，页面里不该再有第二份。
    const local = read('src/components/LocalArchivesWorkspace.tsx');
    const library = read('src/components/LibraryWorkspace.tsx');
    const route = read('src/components/ArchiveDetailRoute.tsx');
    const sections = read('src/components/ArchiveDetailSections.tsx');
    const tagRows = read('src/components/CardTagRows.tsx');

    // 卡片标签：挑选（pickCardTags + My Tags 席位）与染色只此一份。
    expect(tagRows).toMatch(/export function ArchiveCardTags/);
    expect(tagRows).toMatch(/pickCardTags\(tags \?\? \[\], limit, myTagKeys\)/);
    for (const page of [local, library]) {
      expect(page).toContain('ArchiveCardTags');
      expect(page).not.toMatch(/<CardTagRows\b/);
      expect(page).not.toMatch(/pickCardTags\(/);
    }
    // 详情分区：标题、封面、事实网格、标签墙都住在共用模块里。
    for (const name of ['ArchiveDetailCover', 'ArchiveDetailFacts', 'ArchiveDetailTagSection', 'useDetailTagGroups', 'useArchiveCover', 'useTwoLineTitle']) {
      expect(sections).toContain(`export function ${name}`);
    }
    expect(local).toContain('ArchiveDetailTagSection');
    expect(local).not.toMatch(/local-detail/);
    // 档案详情页自己也要用共享的那几块，而不是留一份拷贝。
    expect(route).toContain("from './ArchiveDetailSections'");
    expect(route).not.toMatch(/className="archive-detail-facts"/);
    expect(route).not.toMatch(/function DetailFactGlyph/);
    // 本地档案那一页的自有样式已经退役。
    expect(read('src/styles/shell.css')).not.toMatch(/\.local-detail/);
  });

  it('keeps hover rules free of geometry so a hover never resizes a control', () => {
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    // A previous style merge fused the brand mark's 38px sizing into the chrome
    // hover rule: titlebar buttons shrank on hover and the settings nav's rows
    // collapsed into one-character columns (vertical text). The chrome hover
    // tier carries colour only, and every hover selector list may only mix
    // members of one component family (e.g. a resting state and its hover).
    const chromeHover = shell.match(/\.titlebar-control:hover,\n[\s\S]*?\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(chromeHover).toMatch(/\.nav-link:hover/);
    expect(chromeHover).toMatch(/\.sidebar-toggle:hover/);
    expect(chromeHover).toMatch(/background:\s*var\(--surface-container-high\)/);
    expect(chromeHover).not.toMatch(/(^|\s)(width|height):/);
    // The final compound of every non-hover member must also be the final
    // compound of some hover member in the same list — otherwise two unrelated
    // components were fused by an identical-declaration merge.
    const subjectOf = (selector: string): string => (
      selector.replace(/:not\([^)]*\)/g, '').replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').trim().split(/\s+/).pop() ?? ''
    );
    let depth = 0;
    let body = '';
    let header = '';
    const rules: Array<{ selector: string; body: string }> = [];
    for (const character of shell) {
      if (character === '{') {
        depth += 1;
        if (depth === 1) { header = body.trim(); body = ''; }
        continue;
      }
      if (character === '}') {
        depth -= 1;
        if (depth === 0) { rules.push({ selector: header, body }); body = ''; header = ''; }
        continue;
      }
      body += character;
    }
    for (const rule of rules) {
      const { selector } = rule;
      if (!selector || selector.startsWith('@')) continue;
      const parts = selector.split(',').map((part) => part.trim()).filter(Boolean);
      const hoverSubjects = new Set(parts.filter((part) => /:hover/.test(part)).map(subjectOf));
      if (hoverSubjects.size === 0 || hoverSubjects.size === parts.length) continue;
      for (const part of parts) {
        if (/:hover/.test(part)) continue;
        expect(
          hoverSubjects.has(subjectOf(part)),
          `hover rule mixes unrelated selectors: ${selector.replace(/\s+/g, ' ')}`,
        ).toBe(true);
      }
    }
    const markRule = shell.match(/\.brand \.yomika-mark\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(markRule).toMatch(/width:\s*38px/);
    expect(markRule).not.toMatch(/:hover/);
  });

  it('gives every hover rule a pressed twin, so a tap is visible on touch', () => {
    // 触屏没有 hover——`:hover` 在触屏上会留在屏幕上（点过的行一直填着色），所以整套
    // 悬停规则都关在 @media (hover: hover) 里，按下态就是触屏唯一的反馈。两边必须成对：
    // 悬停加一条，按下态就得补一条，否则那个组件在手机上又变回"点下去毫无动静"。
    //
    // 变换是机械的：把悬停选择器里的 `:hover` 原样换成 `:is(.is-pressed, :active)`，
    // 祖先上下文与 `:not(...)` 守卫都不动——这样特异性和悬停完全一致，凡是悬停压得住
    // 的静止态，按下态也压得住。机制见 src/lib/pressFeedback.ts。
    const shell = read('src/styles/shell.css');
    const source = shell.replace(/\/\*[\s\S]*?\*\//g, '');
    // 选择器列表要按**顶层**逗号切：`:is(.is-pressed, :active)` 自己带一个逗号。
    const splitSelectors = (list: string): string[] => {
      const parts: string[] = [];
      let depth = 0;
      let current = '';
      for (const character of list) {
        if (character === '(') depth += 1;
        if (character === ')') depth -= 1;
        if (character === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
        current += character;
      }
      parts.push(current.trim());
      return parts.filter(Boolean);
    };

    // 有意不补的：桌面专属（自绘标题栏）；触屏另有一套交互（标签的悬停是揭示机制、
    // SFW 的悬停是揭图）；骨架屏不是可点元素；分隔线纯装饰；`:disabled:hover` 是禁用态
    // 的中和规则；输入框在触屏上点一下就直接聚焦，聚焦环就是反馈；下拉的选项行外层是
    // `div[role=option]`，被标记的是行里那个真正的按钮，所以按下态写在 .select-option-main 上。
    const exempt = (selector: string) => /titlebar|metadata-tag|data-sfw|is-skeleton|panel-separator|:disabled:hover|^input:hover|^select:hover|^textarea:hover|^\.select-option:hover$/.test(selector);
    // 只比颜色：悬停规则里那点位移（`transform: translateY(-1px)`）按下去不该复刻，
    // 布局一动就会跳。
    const colour = (body: string) => [...body.matchAll(/(background(?:-color)?|color|border-color)\s*:\s*([^;]+)/g)].map((match) => `${match[1]}: ${match[2]?.trim()}`);

    const missing: string[] = [];
    let checked = 0;
    for (const path of ['src/styles/base.css', 'src/styles/shell.css', 'src/styles/reader.css']) {
      const sheet = read(path);
      const stripped = sheet.replace(/\/\*[\s\S]*?\*\//g, '');

      const hovered = new Map<string, string>();
      for (let at = stripped.indexOf('@media (hover: hover)'); at >= 0; at = stripped.indexOf('@media (hover: hover)', at + 1)) {
        const open = stripped.indexOf('{', at);
        let depth = 0;
        let end = open;
        for (let index = open; index < stripped.length; index += 1) {
          if (stripped[index] === '{') depth += 1;
          else if (stripped[index] === '}' && (depth -= 1) === 0) { end = index; break; }
        }
        for (const rule of stripped.slice(open + 1, end).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          for (const selector of splitSelectors(rule[1] ?? '')) {
            if (selector.includes(':hover')) hovered.set(selector, rule[2] ?? '');
          }
        }
      }

      const pressed = new Map<string, string>();
      for (const rule of ruleBody(sheet, '@media (hover: none)').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const selector of splitSelectors(rule[1] ?? '')) pressed.set(selector, rule[2] ?? '');
      }

      for (const [selector, body] of hovered) {
        if (exempt(selector)) continue;
        checked += 1;
        const twin = pressed.get(selector.replace(/:hover/g, ':is(.is-pressed, :active)'));
        if (twin === undefined) { missing.push(`${path} 没有按下态：${selector}`); continue; }
        for (const declaration of colour(body)) {
          if (!twin.includes(declaration)) missing.push(`${path} 按下态少了 ${declaration}：${selector}`);
        }
      }
    }
    // 覆盖得够多才说明这个断言有意义（三份样式表加起来几十条悬停规则）。
    expect(checked).toBeGreaterThan(35);
    expect(missing).toEqual([]);
  });

  it('keeps design tokens in a cascade layer so user CSS can override them', () => {
    // The reason presets appeared to do nothing twice over: a preset's
    // `:root { --brand-vermilion: … }` is (0,1,0) and loses on specificity to
    // `:root[data-theme='dark']` and `:root:not([data-theme])`. Injected user CSS
    // is unlayered, and unlayered rules beat every layered rule regardless of
    // specificity — so the token file must stay wrapped, and no other stylesheet
    // may declare tokens on :root outside a layer.
    const tokens = read('src/styles/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(tokens).toMatch(/@layer tokens\s*\{/);
    const themeBlocks = [/:root\[data-theme='dark'\]/, /:root:not\(\[data-theme\]\)/];
    const layerStart = tokens.indexOf('@layer tokens {');
    for (const block of themeBlocks) {
      const at = tokens.search(block);
      expect(at).toBeGreaterThan(layerStart);
    }
    for (const path of ['src/styles/base.css', 'src/styles/shell.css', 'src/styles/reader.css']) {
      const sheet = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, body] of sheet.matchAll(/:root[^{]*\{([^}]*)\}/g)) {
        expect(body).not.toMatch(/--[\w-]+\s*:/);
      }
    }
  });

  it('keeps archive toolbar icon actions compact and select fields flexible', () => {
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.library-toolbar\s*\{[\s\S]*display:\s*flex/);
    expect(shell).toMatch(/\.library-toolbar\s*>\s*\.secondary-action\s*\{[\s\S]*flex:\s*0\s*0\s*var\(--control-height\)/);
    expect(shell).toMatch(/\.library-toolbar\s+\.select-field\s*\{[\s\S]*flex:\s*1\s*1\s*0/);
  });

  it('keeps recommendation rails horizontal and lets wide covers span the thumbnail grid', () => {
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.archive-rail-grid\s*\{[\s\S]*display:\s*flex[\s\S]*overflow-x:\s*auto/);
    expect(shell).toMatch(/\.archive-rail-grid\s*\{[\s\S]*align-items:\s*flex-start/);
    expect(shell).toMatch(/\.archive-thumb-card\s*\{[\s\S]*width:\s*150px/);
    expect(shell).toMatch(/\.archive-thumb-card\.is-wide\s*\{[\s\S]*width:\s*316px/);
    expect(shell).toMatch(/\.archive-thumb-card-media\s*\{[\s\S]*height:\s*210px/);
    expect(shell).toMatch(/\.archive-thumb-card-body\s*\{[\s\S]*grid-template-rows:\s*36px 48px 15px[\s\S]*height:\s*135px/);
    expect(shell).toMatch(/\.archive-thumb-card-tags\s*\{[\s\S]*align-items:\s*flex-start[\s\S]*align-content:\s*flex-start/);
    // The rail card and the library grid share one tag geometry: a 20px chip in a
    // 48px two-row slot, so two rows need 44px and keep 4px clearance — the second
    // row's bottom edge is never shaved by the clip box. The 20px is the only
    // variant a chip has: its type comes from the chip family, which is declared
    // once (see the label-family contract below).
    expect(shell).toMatch(/\.archive-thumb-card-tags \.metadata-chip\s*\{[\s\S]*min-height:\s*20px;/);
    expect(shell).toMatch(/\.archive-thumb-card-tags\s*\{[\s\S]*height:\s*48px/);
    // Thumbnail grid rows are packed in JS (fixed 180px columns, wide covers
    // exactly two columns plus the gap) so the grid can virtualize by row.
    expect(shell).toMatch(/\.archive-thumb-grid-row\s*\{[\s\S]*position:\s*absolute[\s\S]*display:\s*flex[\s\S]*gap:\s*var\(--card-gap\)/);
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \.archive-row-wrap\s*\{[\s\S]*width:\s*180px/);
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \.archive-row-wrap\.is-cover-wide\s*\{[\s\S]*width:\s*368px/);
    // The grid card reuses the rail card's classes: .archive-thumb-card with a
    // 220px media frame and the shared body/title/tags/meta stack.
    const gridCard = ruleBody(shell, '.archive-list.is-thumbnail .archive-thumb-card');
    expect(gridCard).toMatch(/grid-template-rows:\s*220px 1fr/);
    expect(gridCard).toMatch(/height:\s*350px/);
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \.archive-thumb-card \.archive-thumb-card-body\s*\{[\s\S]*grid-template-rows:\s*34px 48px 18px/);
    expect(shell).not.toMatch(/\.archive-list\.is-thumbnail \.archive-row-copy/);
    // List rows share the footer layout and drop the trailing chevron column.
    expect(shell).toMatch(/\.archive-row-footer\s*\{[\s\S]*justify-content:\s*space-between/);
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row\s*\{[\s\S]*grid-template-columns:\s*100px minmax\(0, 1fr\);/);
    // The wide card has the biggest tag area in the app, so it gets full-size
    // chips. That is the family default now — the wide row used to restate the
    // whole chip box to get there, which is how the sizes drifted apart.
    expect(shell).not.toMatch(/\.archive-list\.is-wide \.archive-row-tags \.metadata-chip\s*\{/);
    // 宽行卡的标签区是 JHenTai 画廊详情的分组行形态：分组行纵向堆叠，行内
    // 不折行，前三条完整物理行由 JS 打包（WideTagRows）——像素封顶会把组内
    // 续行拦腰切掉半枚芯片。
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row-tags\s*\{[\s\S]*flex-direction:\s*column/);
    expect(shell).toMatch(/\.archive-row-tag-line\s*\{[\s\S]*flex-wrap:\s*nowrap/);
    expect(shell).toMatch(/\.card-tag-measures\s*\{[\s\S]*visibility:\s*hidden/);
    expect(shell).not.toMatch(/\.is-cover-wide \.archive-row-thumb\s*\{[\s\S]*aspect-ratio/);
    expect(shell).toMatch(/\.archive-row-thumb\s*\{[\s\S]*overflow:\s*hidden[\s\S]*border-radius:\s*var\(--radius-control\)/);
    expect(shell).toMatch(/\.archive-row-thumb img\s*\{[\s\S]*border-radius:\s*inherit/);
    expect(shell).not.toMatch(/@container app-main \(max-width: 1280px\)/);
  });

  it('uses the project font and stable icon slots for status chrome', () => {
    const tokens = read('src/styles/tokens.css');
    const shell = read('src/styles/shell.css');
    const reader = read('src/styles/reader.css');
    expect(tokens).toMatch(/--icon-button-size:\s*44px/);
    expect(shell).toMatch(/\.status-item\s*\{[\s\S]*font-family:\s*var\(--font-body\)/);
    expect(shell).toMatch(/\.icon-button\s*\{[\s\S]*width:\s*var\(--icon-button-size\)[\s\S]*height:\s*var\(--icon-button-size\)/);
    expect(reader).toMatch(/\.reader-icon-button,[\s\S]*?\.reader-toolbar button\s*\{[\s\S]*width:\s*var\(--icon-button-size\)[\s\S]*height:\s*var\(--icon-button-size\)/);
  });

  it('gives the reader chrome the Material 3 app-bar geometry and roles', () => {
    // 阅读模式的顶栏/底栏按 M3 的 small top app bar 与 bottom app bar 规格：容器
    // 64dp / 80dp（各加自己的安全区）、左右 4dp（TopAppBarHorizontalPadding 与
    // BottomAppBarHorizontalPadding —— M3 把「距图标 16dp」的内容边距交给按钮自己
    // 的内边距，容器只留 4dp）、24dp 图标、标题 title-large（22/28）。
    //
    // **两条栏跟随应用主题**：容器、分隔线、墨色都取 --surface-container / --hairline /
    // --on-surface(-variant)，和 shell 的标题栏同一档家具——阅读模式不再像「另一个
    // 应用」。画布本身仍是固定深色（--reader-canvas），压在画面上那些东西也仍是
    // --reader-*（见下面那条 on-canvas chrome 的测试）。
    // 两条栏依然都是**不透明**的：整块 chrome 里没有一处 `backdrop-filter`，也没有带
    // alpha 的容器色（2026-09-30 上一轮曾把它们做成同一种半透明 chrome）。
    const reader = read('src/styles/reader.css');
    const tokens = read('src/styles/tokens.css');

    expect(tokens).toMatch(/--reader-title-size:\s*22px/);
    expect(tokens).toMatch(/--reader-title-leading:\s*28px/);
    expect(tokens).toMatch(/--reader-toolbar-height:\s*80px/);
    expect(tokens).toMatch(/--reader-primary:\s*#ffb4a9/);
    // 阅读器只剩「画布 + 压在画面上的东西」这一组固定深色令牌；两条栏专用的
    // --reader-surface / --reader-surface-container 已随这一轮删掉——它们现在读主题。
    expect(tokens).toMatch(/--reader-canvas:\s*#[0-9a-f]{6};/);
    expect(tokens).toMatch(/--reader-surface-raised:\s*#[0-9a-f]{6};/);
    expect(tokens).not.toMatch(/--reader-surface:/);
    expect(tokens).not.toMatch(/--reader-surface-container/);
    expect(tokens).not.toMatch(/--reader-chrome:/);
    expect(tokens).not.toMatch(/--reader-bar-container/);

    const top = ruleBody(reader, '.reader-chrome-top');
    expect(top).toMatch(/height:\s*calc\(64px \+ var\(--safe-top\)\)/);
    expect(top).toMatch(/padding:\s*var\(--safe-top\)\s+var\(--space-1\)\s+0/);
    // 容器高度是定的，不是 min-height：内容在 64dp 里居中，多一行也不会长高。
    expect(top).not.toMatch(/min-height/);
    // 顶栏 = 主题的 surface-container（和 shell 的标题栏同一档），不透明；朝内容那一侧
    // 一条 hairline 分隔线；墨色取 on-surface。
    expect(top).toMatch(/background:\s*var\(--surface-container\)/);
    expect(top).toMatch(/color:\s*var\(--on-surface\)/);
    expect(top).toMatch(/border-bottom:\s*1px solid var\(--hairline\)/);
    expect(top).not.toMatch(/backdrop-filter/);
    expect(top).not.toMatch(/color-mix|transparent/);

    const title = ruleBody(reader, '.reader-chrome-top strong');
    expect(title).toMatch(/font-size:\s*var\(--reader-title-size\)/);
    // M3 的 app bar 标题是 400，但这个应用自己的标题是粗的：同一个档案在详情页是粗体、在
    // 阅读模式是常规体，来回切看着像两个应用。2026-09-25 起跟详情页走同一条字重。
    expect(title).toMatch(/font-weight:\s*var\(--weight-bold\)/);
    expect(title).toMatch(/line-height:\s*var\(--reader-title-leading\)/);

    // 出错那条横幅上的标题是同一个标题的另一种状态，字重不能各写各的。
    expect(ruleBody(reader, '.reader-error-bar strong')).toMatch(/font-weight:\s*var\(--weight-bold\)/);

    const toolbar = ruleBody(reader, '.reader-toolbar');
    expect(toolbar).toMatch(/height:\s*calc\(var\(--reader-toolbar-height\) \+ var\(--safe-bottom\)\)/);
    expect(toolbar).toMatch(/padding:\s*0 var\(--space-1\) var\(--safe-bottom\)/);
    // 功能组之间留 8dp；组内图标仍由各自的触控面提供间距。
    expect(toolbar).toMatch(/gap:\s*var\(--space-2\)/);
    expect(ruleBody(reader, '.reader-toolbar-group')).toMatch(/display:\s*flex/);
    // 底栏 = 主题的 surface-container——和顶栏同一档（一条在上、一条在下，中间隔着
    // 画面），分隔线同样取 hairline。「两条栏不是同一个材质」这条设计仍然成立，只是
    // 两档现在都由主题给。
    expect(toolbar).toMatch(/background:\s*var\(--surface-container\)/);
    expect(toolbar).toMatch(/color:\s*var\(--on-surface\)/);
    expect(toolbar).toMatch(/border-top:\s*1px solid var\(--hairline\)/);
    expect(toolbar).not.toMatch(/backdrop-filter/);
    expect(toolbar).not.toMatch(/color-mix|transparent/);
    expect(toolbar).not.toMatch(/var\(--reader-surface\)/);

    // 三段式网格：三列都按内容宽（`auto`），整排再 `justify-content: center`——左右两组
    // 因此**向中间靠拢**，页码仍然按网格落在栏的正中。这一条曾经是
    // `minmax(0, 1fr) auto minmax(0, 1fr)` 加两侧各自的 `justify-self: start/end`：宽窗口下
    // 两组被推到栏的两端，离中间那枚页码最远（user report:「底栏左右两侧按钮离中心太远」）。
    // `justify-content` 在这里必须留成 `center`——上一轮 ≤900px 的那条查询把它压成
    // `flex-start`，窗口一窄，页码就从中间滑到左边。
    expect(toolbar).toMatch(/display:\s*grid/);
    expect(toolbar).toMatch(/grid-template-columns:\s*auto auto auto/);
    expect(toolbar).toMatch(/justify-content:\s*center/);
    // 两侧不再贴边：任何 `justify-self` 都会把那一组推回自己那一列的边上，又变成「离中心远」。
    expect(ruleBody(reader, '.reader-toolbar-layout')).toMatch(/grid-column:\s*1/);
    expect(ruleBody(reader, '.reader-toolbar-layout')).not.toMatch(/justify-self/);
    expect(ruleBody(reader, '.reader-toolbar-pages')).toMatch(/grid-column:\s*2/);
    expect(ruleBody(reader, '.reader-toolbar-processing')).toMatch(/grid-column:\s*3/);
    expect(ruleBody(reader, '.reader-toolbar-processing')).not.toMatch(/justify-self/);

    // 手机档（≤610px）换成可以换行的 flex：页码整行占满、行内居中，剩下两组跟在后面，
    // 整行同样居中。这是「移动模式下底栏组件没有居中」那条 user report 的钉子。
    const phone = ruleBody(reader, '@media (max-width: 610px)');
    expect(phone).toMatch(/flex-wrap:\s*wrap/);
    expect(phone).toMatch(/justify-content:\s*center/);
    expect(phone).toMatch(/\.reader-toolbar-pages\s*\{[^}]*width:\s*100%/);
    expect(phone).toMatch(/\.reader-toolbar-pages\s*\{[^}]*justify-content:\s*center/);
    // 900px 那一档只收组内间距，不再动对齐。
    expect(ruleBody(reader, '@media (max-width: 900px)')).not.toMatch(/justify-content/);

    // M3 的 top app bar 一明一暗两颗图标：前导（返回）是 on-surface，尾随动作是
    // on-surface-variant。底栏那一排动作全走 on-surface-variant，页码是 on-surface。
    // 底栏那条要按规则本体匹配：`.reader-toolbar button` 先出现在上面那条共享几何规则
    // 的选择器列表里，`ruleBody` 取的是第一个。
    expect(reader).not.toMatch(/\.reader-chrome-top \.reader-icon-button\s*\{/);
    expect(ruleBody(reader, '.reader-chrome-top .reader-chrome-settings,\n.reader-chrome-top .reader-chrome-window,\n.reader-chrome-top .reader-chrome-thumbnails'))
      .toMatch(/color:\s*var\(--on-surface-variant\)/);
    expect(reader).toMatch(/\.reader-toolbar button \{\s*color:\s*var\(--on-surface-variant\);\s*\}/);
    // 缩略面板按钮搬到顶栏之后，它是这条栏上唯一有开/关状态的一颗，和底栏那些开关同一条
    // 读法（只有图标换 primary，容器保持透明）。
    expect(ruleBody(reader, ".reader-chrome-top .reader-chrome-thumbnails[aria-pressed='true']"))
      .toMatch(/color:\s*var\(--primary\)/);
    // 组不带填充（M3 的 bottom app bar 是一排 standard icon button）。
    expect(ruleBody(reader, '.reader-toolbar-group')).not.toMatch(/background/);
    expect(reader).not.toMatch(/\.reader-toolbar-pages[^{]*\{[^}]*background/);

    // 浮在画面上的两枚胶囊仍是阅读器自己那套固定深色（不进主题）：它们压在亮度不可控
    // 的画面上，跟着主题翻转只会在浅色主题下变成深色压黑底。
    expect(ruleBody(reader, '.reader-deriving')).toMatch(/background:\s*var\(--reader-surface-raised\)/);
    expect(ruleBody(reader, '.reader-page-indicator')).toMatch(/background:\s*var\(--reader-surface-raised\)/);
    // 整个 chrome 里只剩概览那层蒙版带模糊——它是一枚对话框的 scrim，不是 app bar。
    // 先去掉注释再抓选择器，否则上一条规则的注释会跟着一起被捕获。
    const blurSelectors = [...reader.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}]*?)\{[^{}]*backdrop-filter:\s*blur/g)]
      .map((match) => (match[1] ?? '').trim());
    expect(blurSelectors.join(' | ')).toBe('.reader-overview-backdrop');

    // 图标按钮是 M3 的 full shape，不是 8px 圆角；图标 24dp。
    expect(ruleBody(reader, '.reader-icon-button,\n.reader-toolbar button')).toMatch(/border-radius:\s*var\(--radius-pill\)/);
    expect(ruleBody(reader, '.reader-error svg,\n.reader-icon-button svg,\n.reader-toolbar svg')).toMatch(/width:\s*24px/);

    // 选中的开关走 M3 standard icon button 的选中态：只有图标换 primary，容器保持
    // 透明。填充式（整块实色）会把一枚控件变成压在画面上的色块。
    const selected = ruleBody(reader, '.reader-toolbar button[aria-pressed="true"]');
    expect(selected).toMatch(/color:\s*var\(--primary\)/);
    expect(selected).not.toMatch(/background/);

    // 概览面板是一枚 M3 对话框：extra-large 圆角 + 24dp 内边距。
    const panel = ruleBody(reader, '.reader-overview');
    expect(panel).toMatch(/border-radius:\s*var\(--radius-overlay\)/);
    expect(panel).toMatch(/padding:\s*var\(--space-6\)/);

    // 页码胶囊压在底栏上，读的是底栏自己的高度令牌，改一边不会让两边错位。
    expect(ruleBody(reader, '.reader-page-indicator.is-raised')).toMatch(/bottom:\s*calc\(var\(--reader-toolbar-height\)/);
  });

  it('keeps the on-canvas reader chrome on its own fixed dark scheme', () => {
    // 阅读画布两个主题下都是黑的，压在**画面**上的东西只能用 --reader-* 那套固定的
    // 深色方案。引用会随主题翻转的颜色令牌，在浅色主题下就会变成深色落在黑底上：
    // 选中页缩略图的描边（--brand-cyan）、画布焦点环（--focus-ring）都曾如此。
    //
    // 两组例外，它们**必须**引用主题角色：两条栏（顶栏 / 底栏 / 出错横幅 / 顶栏里的无痕
    // 徽章）从 2026-09-30 起跟随应用主题（见上一条测试）；概览面板是一枚对话框，同一个
    // 面板还出现在去重工作区那个跟随主题的对话框里，里面的标签芯片本来就是主题色。按
    // 选择器把这两组规则**整条**剔掉，再看剩下的（画布、页码胶囊、重试按钮……）。
    const reader = read('src/styles/reader.css');
    const themed = /[^{}]*\.(?:reader-chrome-top|reader-toolbar|reader-error-bar|reader-overview|reader-incognito-badge)[\w-]*[^{}]*\{[^{}]*\}/g;
    const rest = reader.replace(/\/\*[\s\S]*?\*\//g, '').replace(themed, '');
    const rules = [...rest.matchAll(/([^{}]*)\{([^{}]*)\}/g)];
    const chrome = rules.map(([whole]) => whole).join('\n');
    // 剔完还得剩下东西，否则「剩下的里面没有违规令牌」是句空话。
    expect(chrome).toMatch(/--reader-canvas/);
    expect(chrome).toMatch(/--reader-surface-raised/);
    const flipping = /var\(--(?:primary|on-primary|primary-container|on-primary-container|secondary|tertiary|error|success|warning|surface[\w-]*|on-surface[\w-]*|ink-[\w-]+|brand-[\w-]+|outline[\w-]*|hairline[\w-]*|control-[\w-]+|chip-[\w-]+|backdrop-overlay|selection-[\w-]+|focus-[\w-]+|inverse-[\w-]+|state-[\w-]+|category-[\w-]+|tag-ns-[\w-]+|eh-mark-[\w-]+|shadow-[\w-]+)\)/;
    expect(chrome).not.toMatch(flipping);
  });

  it('leaves the namespace label chip its own ink in the reader overview', () => {
    // 命名空间的标题就是那枚带色芯片（`.tag-group h3` 的 background + color 由
    // 命名空间变量给）。面板里再写一次 color 就会把它换成灰色：`.reader-overview-tags
    // .tag-group h3` 的特异性 (0,2,1) 压得住 `.tag-group-artist h3` 那几条 (0,1,1)，
    // 于是标签成了灰字压在彩色底上——实测对比度 1.4–4.8，最差的几乎看不见。
    const reader = read('src/styles/reader.css');
    const body = ruleBody(reader, '.reader-overview-tags .tag-group h3');
    expect(body).toMatch(/margin:\s*0/);
    expect(body).not.toMatch(/color|background/);
    // 而且面板必须给得出芯片的底色：它跟随主题，就得用主题的容器与墨色。
    const panel = ruleBody(reader, '.reader-overview');
    expect(panel).toMatch(/background:\s*var\(--surface-container-high\)/);
    expect(panel).toMatch(/color:\s*var\(--on-surface\)/);
  });

  it('anchors the enabled switch thumb to the track end even if its flex row shrinks', () => {
    const shell = read('src/styles/shell.css');
    // Material 3 switch: a 52x32 track and one 24dp handle that only travels.
    // Both states must use the same handle size and the same 4px end margin —
    // a growing handle read as two different controls and touched one edge
    // while floating away from the other.
    expect(shell).toMatch(/\.switch-control\[role="switch"\]\s*\{[^}]*flex:\s*0 0 52px[^}]*min-width:\s*52px/);
    expect(shell).toMatch(/\.switch-control\[role="switch"\]\s*\{[^}]*height:\s*32px[^}]*\}/);
    expect(shell).toMatch(/\.switch-control\[role="switch"\]::after\s*\{[^}]*top:\s*3px[^}]*left:\s*3px[^}]*width:\s*24px[^}]*height:\s*24px[^}]*border-radius:\s*50%/);
    expect(shell).toMatch(/\.switch-control\[role="switch"\]::after\s*\{[^}]*background:\s*var\(--primary\)/);
    expect(shell).toMatch(/\.switch-control\[role="switch"\]\[aria-checked="true"\]::after\s*\{[^}]*transform:\s*translateX\(20px\)[^}]*\}/);
    const checked = shell.match(/\.switch-control\[role="switch"\]\[aria-checked="true"\]::after\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(checked).not.toMatch(/width|height|top|left/);
  });

  it('defines the Material 3 color roles and shape scale', () => {
    const tokens = read('src/styles/tokens.css');
    const roles = [
      '--primary', '--on-primary', '--primary-container', '--on-primary-container',
      '--secondary', '--on-secondary', '--secondary-container', '--on-secondary-container',
      '--tertiary', '--on-tertiary', '--tertiary-container', '--on-tertiary-container',
      '--error', '--success', '--warning',
      '--surface', '--surface-container-low', '--surface-container', '--surface-container-high',
      '--surface-container-highest', '--on-surface', '--on-surface-variant', '--outline', '--outline-variant',
    ];
    for (const role of roles) {
      expect(tokens).toMatch(new RegExp(`${role}:\\s*[^;]+;`));
    }
    // 8px controls, 12px cards, 28px dialogs, full pills.
    expect(tokens).toMatch(/--radius-control:\s*8px/);
    expect(tokens).toMatch(/--radius-card:\s*12px/);
    expect(tokens).toMatch(/--radius-overlay:\s*28px/);
    expect(tokens).toMatch(/--radius-pill:\s*999px/);
  });

  it('keeps the toast on the radius scale and the scale free of extra tokens', () => {
    const shell = read('src/styles/shell.css');
    const tokens = read('src/styles/tokens.css');
    // The toast used to carry a private 4px token outside the documented
    // scale; it now rides the control radius like inputs and chips.
    expect(shell).toMatch(/\.toast-card\s*\{[^}]*border-radius:\s*var\(--radius-control\)/);
    expect(tokens).not.toMatch(/--radius-toast/);
    expect(tokens).not.toMatch(/--card-radius/);
    expect(tokens).not.toMatch(/--shape-corner-/);
  });

  it('keeps UI type on the token scale with a small weight set', () => {
    const tokens = read('src/styles/tokens.css');
    // Nothing smaller than 12px, and one heading step so section titles stop
    // drifting between 18 and 24.
    expect(tokens).toMatch(/--text-xs:\s*12px/);
    expect(tokens).toMatch(/--text-heading:\s*24px/);
    // 权重也只走令牌：「keeps typography on the scale…」那条对同样的三张表全域封杀
    // 任何数字权重（比一张白名单更严），这里只剩字号与行高。
    for (const path of ['src/styles/base.css', 'src/styles/shell.css', 'src/styles/reader.css']) {
      const sheet = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      // No raw pixel font sizes anywhere in component CSS.
      expect(sheet).not.toMatch(/font-size:\s*\d+px/);
    }
  });

  it('keeps literal colors out of component stylesheets', () => {
    // Tokens are the only place a hex, rgb() or rgba() may appear. Components
    // reference semantic tokens so the brand triad and both themes stay swappable.
    for (const path of ['src/styles/base.css', 'src/styles/shell.css', 'src/styles/reader.css']) {
      const sheet = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(sheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(sheet).not.toMatch(/\brgba?\(/);
    }
  });

  it('gives every archive card an 8px gap, its own edge and a 12px radius', () => {
    const shell = read('src/styles/shell.css');
    const wrap = ruleBody(shell, '.archive-list.is-wide .archive-row-wrap');
    expect(wrap).toMatch(/height:\s*166px/);
    // The 8px between cards is the card's own margin, so the timeline rail — which
    // stretches to the wrap — runs unbroken from one row to the next.
    expect(wrap).not.toMatch(/padding-block/);
    const row = ruleBody(shell, '.archive-list.is-wide .archive-row');
    expect(row).toMatch(/margin-block:\s*4px/);
    // The edge is an inner outline, not a border: a border inside the fixed
    // border-box height stole 2px and clipped the second tag row.
    expect(row).toMatch(/outline:\s*1px solid var\(--outline-variant\)/);
    expect(row).toMatch(/outline-offset:\s*-1px/);
    expect(row).toMatch(/border:\s*0/);
    expect(row).toMatch(/border-radius:\s*var\(--radius-card\)/);
    expect(row).toMatch(/background:\s*var\(--surface-container-high\)/);
    expect(row).toMatch(/overflow:\s*hidden/);
    const thumbRow = ruleBody(shell, '.archive-list.is-thumbnail .archive-thumb-card');
    expect(thumbRow).toMatch(/outline:\s*1px solid var\(--outline-variant\)/);
    expect(thumbRow).toMatch(/border:\s*0/);
    expect(thumbRow).toMatch(/border-radius:\s*var\(--radius-card\)/);
    // A continuous list must not be faked with shared edges or negative margins.
    expect(shell).not.toMatch(/margin-top:\s*-1px/);
    expect(shell).not.toMatch(/\.archive-row-wrap:not\(\[data-first=/);
  });

  it('pins the wide-row progress bar to the card’s own bottom edge', () => {
    const shell = read('src/styles/shell.css');
    const source = read('src/components/LibraryWorkspace.tsx');
    // 横条是卡片（那个 button）的直接子元素：只有横跨整张卡，卡片自己的
    // overflow: hidden + border-radius 才能把两端削成与下缘一致的圆角。
    expect(source).toMatch(/<ArchiveProgressBar page=\{readingProgressByArchiveId\?\.get\(archive\.archiveId\)\} pageCount=\{archive\.pageCount\} cornerAware \/>\s*<\/button>/);
    expect(source).not.toMatch(/<span className="archive-row-copy">\s*<ArchiveProgressBar/);
    expect(shell).not.toMatch(/\.archive-row-copy > \.archive-card-progress\s*\{/);
    const bar = ruleBody(shell, '.archive-list.is-wide .archive-row > .archive-card-progress');
    // 底边留 1px：卡片的高亮是它自己的 outline（outline-offset: -1px → 画在
    // y ∈ [H-1, H]），横条贴到 0 时会作为定位后代把这条描边连同两个下角弧线盖掉。
    expect(bar).toMatch(/inset:\s*auto 0 1px/);
    expect(bar).toMatch(/height:\s*4px/);
    // `.archive-row > span` 的 display: grid 特异性更高，横条必须显式声明 display。
    expect(bar).toMatch(/display:\s*block/);
    // 横条两端不再内缩：它依然横跨整张卡（压住两个圆角），只有填充的长度排除圆角。
    expect(bar).not.toMatch(/padding-inline/);
    expect(shell).not.toMatch(/\.archive-list\.is-wide \.archive-row > \.archive-card-progress\.is-complete\s*\{/);
    const card = read('src/components/ArchiveThumbnailCard.tsx');
    // 长度只在宽行这一支上排除圆角：预览/网格卡那条压在封面接缝上，没有圆角可让。
    expect(card).toMatch(/cornerAware = false/);
    expect(card).toMatch(/calc\(var\(--radius-card\) \+ \(100% - 2 \* var\(--radius-card\)\) \* \$\{percent \/ 100\}\)/);
    // 覆盖层必须画在横条之上，几何与卡片 outline 对齐（inset: 1px + 半径 - 1px）。
    const overlay = ruleBody(shell, ".archive-list.is-wide .archive-row:is(.is-selected, [aria-checked='true'], [aria-pressed='true'])::after");
    expect(overlay).toMatch(/inset:\s*1px/);
    expect(overlay).toMatch(/z-index:\s*1/);
    expect(overlay).toMatch(/border:\s*1px solid var\(--primary\)/);
    expect(overlay).toMatch(/border-radius:\s*calc\(var\(--radius-card\) - 1px\)/);
    expect(overlay).toMatch(/pointer-events:\s*none/);
    // 宽度过渡要挂在真实存在的时长令牌上：`--motion-medium` 全仓从未定义，
    // 那条 transition 一直是死声明。
    expect(ruleBody(shell, '.archive-card-progress-fill')).toMatch(/transition:\s*width var\(--motion-standard\)/);
    // 缩略图卡那条仍压在封面与正文的接缝上，两种卡不共用同一个贴边位置。
    expect(ruleBody(shell, '.archive-card-progress')).toMatch(/inset:\s*-5px 0 auto/);
    // hover 的浮动（`.archive-thumb-card:hover` 的 translateY）会把卡片提成合成层，
    // 封面在设备像素取整上会贴着媒体下沿越出一线，正落在进度条下沿——用户报的
    // 「缩略图卡鼠标移上去时进度条底部闪出一丝封面」。横条因此多压住接缝 1px，
    // 并抬到卡片内容之上；同 z-index 时按文档顺序，宽行档的选中覆盖层仍在它上面。
    const gridBar = ruleBody(shell, '.archive-card-progress');
    expect(gridBar).toMatch(/height:\s*6px/);
    expect(gridBar).toMatch(/z-index:\s*1/);
  });

  it('renders the library grid thumbnail with the shared card component', () => {
    const source = read('src/components/LibraryWorkspace.tsx');
    const card = read('src/components/ArchiveThumbnailCard.tsx');
    // The grid branch builds the rail's card, not a second card implementation.
    expect(source).toMatch(/className=\{`archive-thumb-card/);
    expect(source).toMatch(/<ArchiveThumbCardBody/);
    expect(source).toMatch(/archive-thumb-card-media/);
    // ...and the body it renders is the exported shared component.
    expect(card).toMatch(/export function ArchiveThumbCardBody/);
    // The meta line is identical in both places: page count on the left, date on
    // the right, so the grid card and the rail card cannot drift apart.
    expect(card).toMatch(/meta=\{<><span>\{formatArchivePageMeta\(/);
    expect(source).toMatch(/meta=\{<><span>\{formatArchivePageMeta\(/);
  });

  it('uses one circular icon-button shape, one nav treatment and one icon weight', () => {
    const shell = read('src/styles/shell.css');
    const base = read('src/styles/base.css');
    const iconAction = ruleBody(shell, '.icon-action');
    // Material 3 filled tonal icon button: circular, secondary-container fill,
    // no outline.
    expect(iconAction).toMatch(/border-radius:\s*var\(--radius-pill\)/);
    expect(iconAction).toMatch(/background:\s*var\(--secondary-container\)/);
    expect(iconAction).toMatch(/color:\s*var\(--on-secondary-container\)/);
    expect(iconAction).not.toMatch(/border:\s*1px/);
    // The settings nav shares the main nav's left indicator instead of its own
    // left border.
    expect(ruleBody(shell, '.settings-nav a')).toMatch(/position:\s*relative/);
    expect(shell).not.toMatch(/\.settings-nav a\.is-active\s*\{[^}]*border-left-color/);
    expect(shell).toMatch(/\.settings-nav a::before,[\s\S]*?\.settings-nav button::before\s*\{[^}]*background:\s*var\(--primary\)/);
    expect(shell).toMatch(/\.settings-nav a\.is-active::before,[\s\S]*?\.settings-nav button\.is-active::before\s*\{[^}]*opacity:\s*1/);
    // Every icon renders at one optical weight.
    expect(base).toMatch(/svg\.lucide\s*\{[\s\S]*stroke-width:\s*1\.75/);
    expect(shell).not.toMatch(/stroke-width:\s*1\.[458]/);
  });

  it('keeps route titles as hidden landmarks and counts in the product font', () => {
    const shell = read('src/styles/shell.css');
    // The big page headline is gone visually but stays in the accessibility tree.
    expect(shell).toMatch(/\.workspace-heading h1,[\s\S]*?\.metadata-edit-header h1\s*\{[\s\S]*clip-path:\s*inset\(50%\)/);
    expect(read('src/components/LibraryRouteWorkspace.tsx')).toMatch(/<h1 className="visually-hidden">档案库<\/h1>/);
    expect(read('src/components/SettingsWorkspace.tsx')).toMatch(/<h1 className="visually-hidden">设置<\/h1>/);
    expect(read('src/components/LocalArchivesWorkspace.tsx')).toMatch(/<h1 className="visually-hidden">本地档案<\/h1>/);
  });

  it('centres the history rail node on the rail line', () => {
    const shell = read('src/styles/shell.css');
    // The rail is the scroller's own background: 82px timeline column minus the
    // 13px node centre, plus the scroller's 4px side padding, puts the 2px line
    // exactly under the node by construction. Desktop only — the compact layout
    // resets it and groups by the dated section bars instead. The rail runs down
    // the left of the list now, so every horizontal measure is mirrored.
    expect(shell).toMatch(/\.archive-row-timeline\s*\{[\s\S]*--timeline-rail-center:\s*13px/);
    expect(shell).toMatch(/\.archive-list\.has-timeline\s*\{[\s\S]*left 72px top \/ 2px 100%/);
    expect(shell).toMatch(/\.archive-row-timeline::after\s*\{[\s\S]*right:\s*var\(--timeline-rail-center\)[\s\S]*width:\s*8px[\s\S]*transform:\s*translateX\(50%\)/);
    expect(shell).not.toMatch(/\.archive-row-timeline::after\s*\{[\s\S]{0,400}?left:\s*var\(--timeline-rail-center\)/);
  });

  it('lets the flow routes grow their cached panel so the tail can scroll out', () => {
    const shell = read('src/styles/shell.css');
    const routes = read('src/app/routes.tsx');
    // route-cache-panel 的 height:100% 钳制会把溢出尾困在面板外：首页与书架
    // 面板必须随内容生长（is-flow），≤900 则所有路由（含档案库页面滚动）放开。
    expect(routes).toContain("flow={!['/library', '/downloads', '/history', '/watchlist', '/to-read'].includes(key)}");
    expect(read('src/app/RetainedPage.tsx')).toContain("flow ? ' is-flow'");
    expect(shell).toMatch(/\.route-cache-panel\.is-flow \{ height: auto; \}/);
    expect(shell).toMatch(/@media \(max-width: 900px\)/);
  });

  it('gives the shelves the library workspace so their list can scroll to the end', () => {
    const shell = read('src/styles/shell.css');
    const appShell = read('src/components/AppShell.tsx');
    expect(appShell).toMatch(/is-library-workspace/);
    expect(appShell).toMatch(/history\|watchlist\|to-read/);
    // The compact override that shrank their end clearance again is gone.
    expect(shell).not.toMatch(/\.workspace\.is-library-workspace \.archive-list\s*\{\s*padding-bottom/);
  });

  it('splits compact history by day and keeps the rail on desktop', () => {
    const shell = read('src/styles/shell.css');
    const workspace = read('src/components/LibraryWorkspace.tsx');
    expect(workspace).toMatch(/archive-day-divider/);
    // Hidden by default, horizontal sections only under the compact breakpoint,
    // where the right-hand rail folds away.
    expect(shell).toMatch(/\.archive-day-divider\s*\{\s*display:\s*none;\s*\}/);
    expect(shell).toMatch(/@media \(max-width: 900px\)[\s\S]*\.archive-row-timeline\s*\{\s*display:\s*none;\s*\}/);
    expect(shell).toMatch(/@media \(max-width: 900px\)[\s\S]*\.archive-day-divider\s*\{[\s\S]*display:\s*flex/);
  });

  it('keeps the history timeline in its own rail outside the clickable card', () => {
    const shell = read('src/styles/shell.css');
    const source = read('src/components/LibraryWorkspace.tsx');
    // The rail column is the first of the two; the card keeps its place in the
    // DOM (it is the row's markup and its click target) and is placed into the
    // second column explicitly.
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row-wrap:has\(\.archive-row-timeline\)\s*\{[^}]*grid-template-columns:\s*82px\s+minmax\(0,\s*1fr\)/);
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row-wrap:has\(\.archive-row-timeline\) > \.archive-row\s*\{[^}]*grid-area:\s*1 \/ 2/);
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row-wrap:has\(\.archive-row-timeline\) > \.archive-row-timeline\s*\{[^}]*grid-area:\s*1 \/ 1/);
    expect(shell).toMatch(/\.archive-row-timeline\s*\{[\s\S]{0,400}?justify-items:\s*end/);
    expect(shell).toMatch(/\.archive-row-timeline\s*\{[\s\S]{0,700}?padding:\s*var\(--space-3\) 28px 0 0/);
    // The timeline is rendered as a sibling of the card button, never inside it.
    expect(source).toMatch(/<\/button>[\s\S]{0,400}archive-row-timeline/);
  });

  it('gives the history quick-jump rail a gutter of its own', () => {
    const shell = read('src/styles/shell.css');
    const source = read('src/components/LibraryWorkspace.tsx');
    // Ticks live in the gutter reserved to the right of the cards, so a tick never
    // sits on a card.
    expect(shell).toMatch(/\.archive-list\.is-wide\.has-timeline\s*\{\s*padding-right:\s*24px/);
    // 刻度条挂在列表外面的面板层上：留在滚动容器里的绝对定位元素会跟着内容一起滚，
    // 居中就随滚动漂走。挂出去之后 `top: 50%` 量的才是「看得见的那一段」的高度。
    expect(shell).toMatch(/\.library-list-panel-content\s*\{\s*position:\s*relative/);
    expect(shell).toMatch(/\.archive-quick-rail\s*\{[^}]*position:\s*absolute[^}]*top:\s*50%[^}]*transform:\s*translateY\(-50%\)/);
    // 密度是固定节距（11px，正好一格命中区那么高），不再把 N 个刻度摊满 48vh——
    // 两个刻度的历史过去会被拉成半屏高。
    expect(shell).toMatch(/\.archive-quick-rail-track\s*\{[^}]*--rail-pitch:\s*11px[^}]*grid-auto-rows:\s*1fr[^}]*height:\s*min\(calc\(var\(--rail-pitch\) \* var\(--rail-ticks, 1\)\), 70%\)/);
    expect(source).toMatch(/className="archive-quick-rail-track" style=\{\{ '--rail-ticks': railSegments\.length \}/);
    expect(shell).toMatch(/\.archive-quick-rail-tick\.is-active\s*\{\s*width:\s*16px;\s*background:\s*var\(--primary\)/);
    // 刻度只有 9×3px，直接拿它当悬停/点击靶太细：一层看不见的伪元素把靶撑到 29×11px
    // （相邻刻度只隔 11px，竖向只各让 4px）。
    expect(shell).toMatch(/\.archive-quick-rail-tick\s*\{[^}]*position:\s*relative/);
    expect(shell).toMatch(/\.archive-quick-rail-tick::before\s*\{\s*content:\s*'';\s*position:\s*absolute;\s*inset:\s*-4px -10px/);
    // 悬停/聚焦时在刻度左边浮一枚标签，写着这个刻度会把你送到哪一天哪个时间——原生
    // `title` 要等一秒、触摸设备上根本没有。
    expect(shell).toMatch(/\.archive-quick-rail-label\s*\{[^}]*position:\s*absolute[^}]*right:\s*calc\(100% \+ 8px\)[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
    expect(shell).toMatch(/\.archive-quick-rail-tick:hover > \.archive-quick-rail-label\s*\{\s*opacity:\s*1/);
    expect(source).toMatch(/className="archive-quick-rail-label"/);
    // 细分规则：越靠近当前越细，但刻度总数有天花板。
    expect(source).toMatch(/RAIL_MAX_TICKS = 28/);
    expect(source).not.toContain('RAIL_MAX_SEGMENTS');
    // 紧凑档整条轨线都不画（刻度条没有落点），也没有替代入口：手机上不需要跳转控件。
    expect(source).toMatch(/!compact && displayMode === 'wide' && railSegments\.length > 1/);
    expect(source).not.toContain('historyMonths');
    expect(source).not.toContain('history-quick-jump');
    expect(shell).not.toContain('.history-quick-jump');
    expect(shell).toMatch(/@media \(max-width: 900px\)[\s\S]*\.archive-list\.is-wide\.has-timeline\s*\{\s*padding-right:\s*4px/);
    // Thumbnail cards have no rail to hang the ticks on.
    expect(source).toMatch(/displayMode !== 'wide' \|\| railSegments\.length < 2/);
  });

  it('keeps the list row stride in step with the card gap', () => {
    const layout = read('src/lib/archiveGridLayout.ts');
    expect(layout).toMatch(/ARCHIVE_LIST_ROW_HEIGHT\s*=\s*158/);
    expect(layout).toMatch(/ARCHIVE_LIST_ROW_GAP\s*=\s*8/);
    expect(layout).toMatch(/ARCHIVE_LIST_ROW_STRIDE\s*=\s*ARCHIVE_LIST_ROW_HEIGHT \+ ARCHIVE_LIST_ROW_GAP/);
    // The compact day divider adds height to a day's first row.
    expect(layout).toMatch(/ARCHIVE_DAY_DIVIDER_HEIGHT\s*=\s*28/);
    const workspace = read('src/components/LibraryWorkspace.tsx');
    expect(workspace).toMatch(/estimateSize:\s*\(index\)\s*=>\s*ARCHIVE_LIST_ROW_STRIDE/);
  });

  it('paints the loading skeleton on the list own surface and grid', () => {
    const shell = read('src/styles/shell.css');
    const loading = read('src/styles/library-loading.css');
    // 骨架层顶替的就是 `.archive-list` 里那一列卡片，而那一列的表面色是列表自己的
    // `--surface-panel`。占位层再铺一层别的底色，第一帧整幅换色、落地时 180ms 淡掉，
    // 就是「第一次切页闪一下」；那层不透明底色还会盖上列表背景画的时间轴轨线。
    expect(shell).toMatch(/\.archive-list\s*\{[\s\S]{0,400}?background:\s*var\(--surface-panel\)/);
    expect(ruleBody(loading, '.archive-list-skeleton-layer')).not.toMatch(/background/);
    // 内边距和行距照抄真列表：4px 内边距（缩略图档位 12px）加行自己的 4px margin-block，
    // 步距仍旧是 158 + 8，占位卡和落地后的卡片落在同一格上。
    expect(ruleBody(loading, '.archive-list-skeleton-layer .archive-list-skeleton')).toMatch(/padding:\s*4px/);
    expect(ruleBody(loading, '.archive-list-skeleton-layer .archive-list-skeleton.is-thumbnail')).toMatch(/padding:\s*var\(--space-3\)/);
    expect(ruleBody(loading, '.archive-list-skeleton-layer .archive-list-skeleton.is-wide')).toMatch(/gap:\s*0/);
    expect(ruleBody(loading, '.archive-list-skeleton-layer .archive-list-skeleton.is-wide .archive-row-skeleton')).toMatch(/margin-block:\s*4px/);
    expect(shell).toMatch(/\.archive-row-skeleton\s*\{[^}]*height:\s*158px/);
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row\s*\{[^}]*margin-block:\s*4px;[^}]*height:\s*158px/);
    // 时间轴那一栏是行的第一列：真行是 82px 的网格列，骨架行也让出同样的 82px（而不是
    // 靠容器的 padding-left），轨线由列表背景画，占位层不再重复画一根。
    expect(ruleBody(loading, '.archive-list-skeleton-layer .archive-list-skeleton.has-timeline')).toMatch(/padding-left:\s*4px/);
    expect(ruleBody(loading, '.archive-list-skeleton-layer .archive-list-skeleton.has-timeline .archive-row-skeleton')).toMatch(/margin-left:\s*82px/);
    expect(ruleBody(loading, '.archive-list-skeleton-layer .archive-list-skeleton.has-timeline .archive-timeline-skeleton')).toMatch(/border-right:\s*0/);
    // 节点和日期跟着真行摆：真节点圆心在列表左边缘 73px、真日期右端在 58px（= 列宽 82px
    // 减 `.archive-row-timeline` 的 28px 右内边距）处。
    expect(ruleBody(loading, '.archive-list-skeleton-layer .archive-list-skeleton.has-timeline .archive-timeline-skeleton::before')).toMatch(/right:\s*8px/);
    expect(ruleBody(loading, '.archive-list-skeleton-layer .archive-list-skeleton.has-timeline .archive-timeline-skeleton .skeleton-line')).toMatch(/right:\s*28px/);
  });

  it('paints detail tag groups with a hue per namespace and one chip per tag', () => {
    const shell = read('src/styles/shell.css');
    const tokens = read('src/styles/tokens.css');
    // Each namespace carries its own background + ink pair…
    for (const ns of ['artist', 'group', 'parody', 'character', 'female', 'male', 'mixed', 'language', 'category', 'source']) {
      expect(tokens).toMatch(new RegExp('--tag-ns-' + ns + '-bg:'));
      expect(tokens).toMatch(new RegExp('--tag-ns-' + ns + '-ink:'));
      expect(shell).toMatch(new RegExp('\\.tag-group-' + ns + ' \\{ --tag-ns-bg:'));
    }
    // …every tag inside is the same chip family: one deeper fill token, no
    // border. A border used to be the contrast fix and read as an outline the
    // user did not ask for; the fill alone carries the contrast now.
    expect(shell).toMatch(/\.tag-group \.metadata-chip \{\s*background: var\(--chip-background\)/);
    expect(shell).toMatch(/\.tag-group \.metadata-chip \{\s*[\s\S]{0,120}?border: 0/);
    expect(shell).not.toMatch(/--chip-edge/);
    expect(shell).toMatch(/\.tag-group h2,[\s\S]{0,40}\.tag-group h3 \{[^}]*border: 0/);
  });


  it('keeps one dropdown shape, one sort control, and one selection bar', () => {
    const base = read('src/styles/base.css');
    const shell = read('src/styles/shell.css');
    const workspace = read('src/components/LibraryWorkspace.tsx');
    const settings = read('src/components/SettingsWorkspace.tsx');
    // A tick on the right of every dropdown said what the option background
    // already said, once per menu.
    expect(read('src/components/SelectField.tsx')).not.toMatch(/Check/);
    expect(base).toMatch(/\.select-option-trailing \{/);
    // The sort direction lives in the field it belongs to; the separate button
    // is gone, and its place is where the multi-select toggle sits.
    expect(shell).not.toMatch(/library-sort-direction/);
    expect(workspace).toMatch(/select-trailing/);
    expect(workspace).toMatch(/optionTrailing=/);
    expect(workspace).toMatch(/if \(value === sortMode\) updateSortOrder/);
    // One row shape for every setting, and the complex ones open a panel that
    // shares the preset sheet's frame.
    expect(shell).toMatch(/\.settings-row \{/);
    // The whole row is the control, and its right side is text, not a field:
    // a row that only answered on its value, which looked like a select box,
    // gave two different things to click.
    expect(shell).toMatch(/\.settings-row-button \{/);
    expect(shell).not.toMatch(/settings-choice-trigger/);
    // 行的元素只有一处画：SettingsRow 自己。设置页只负责给内容。
    expect(read('src/components/SettingsRow.tsx')).toMatch(/className="settings-row settings-row-button"/);
    expect(settings).not.toMatch(/className="settings-row settings-row-button"/);
    // No section may wrap its rows in a frame of its own: a legend or a fieldset
    // padding put the first row of that section lower than every other section's,
    // which is the jump between sections.
    expect(settings).not.toMatch(/model-feature-block/);
    expect(shell).not.toMatch(/model-feature-block|model-stage-row/);
    expect(shell).toMatch(/\.search-preset-overlay,\n\.settings-choice-overlay \{/);
    // Both panels share one sheet shape, but a settings menu is allowed to be
    // taller than a preset list, so the panel rules are separate now.
    expect(shell).toMatch(/\.search-preset-panel \{[^}]*max-height:\s*min\(70dvh, 520px\)/);
    expect(shell).toMatch(/\.settings-choice-panel \{[^}]*max-height:\s*min\(85dvh, 760px\)/);
    expect(read('src/components/SettingsRow.tsx')).toMatch(/export function SettingsRow\(/);
    // 选择控件住在 SettingsValueControls：设置页只是它的调用方。
    expect(read('src/components/SettingsValueControls.tsx')).toMatch(/export function SettingsChoice\(/);
    // The selection is a mode with its own bar, not a checkbox glued to a card.
    expect(shell).toMatch(/\.archive-selection-bar \{/);
    expect(shell).toMatch(/\.archive-card-check \{/);
    expect(workspace).toMatch(/role: 'checkbox', 'aria-checked': isSelected/);
    expect(workspace).toMatch(/modifiers.shiftKey && anchor >= 0/);
  });

  it('blurs covers and thumbnails in SFW mode and reveals only the image surface', () => {
    const shell = read('src/styles/shell.css');
    const preferences = read('src/app/preferences.tsx');
    // 开关只翻转根属性：模糊与显隐是纯 CSS 合同，自定义 CSS 无需知道开关。
    expect(preferences).toMatch(/documentElement\.dataset\.sfw/);
    // 列表封面、rail/网格封面与详情封面都参与模糊；SFW 下点击卡片（获得焦点）也算显示意图。
    expect(shell).toMatch(/:root\[data-sfw='true'\] \.archive-row-thumb img/);
    expect(shell).toMatch(/:root\[data-sfw='true'\] \.archive-thumb-card-media img/);
    expect(shell).toMatch(/:root\[data-sfw='true'\] \.archive-detail-cover-trigger img/);
    // 悬停封面本身与卡片焦点/按下都解除模糊。
    expect(shell).toMatch(/\.archive-row-thumb:hover img/);
    expect(shell).not.toMatch(/\.archive-thumb-card:(hover|focus|active) img/);
    expect(shell).toMatch(/\.archive-page-thumbnail img/);
    expect(shell).not.toMatch(/\.archive-row:(hover|focus-visible|active) img/);
    expect(shell).toMatch(/\.archive-detail-cover-trigger:focus-visible img/);
  });

  it('draws the E-Hentai mark as a tonal M3 tile from theme tokens', () => {
    const tokens = read('src/styles/tokens.css');
    const mark = read('src/components/EhMark.tsx');
    // The tile rides the theme (primary container pair), so every colour
    // scheme recolours it; no literal brand teal, no shadow token.
    expect(tokens).toMatch(/--eh-mark-plate: var\(--primary-container\)/);
    expect(tokens).toMatch(/--eh-mark-ink: var\(--on-primary-container\)/);
    expect(tokens).not.toMatch(/--eh-mark-shadow/);
    expect(mark).toMatch(/var\(--eh-mark-plate/);
    expect(mark).toMatch(/var\(--eh-mark-ink/);
    // M3 form: full-bleed rounded plate like YomikaMark, rounded-stroke
    // letterforms, and no skeuomorphic long-shadow stack (no clip/use).
    expect(mark).toMatch(/rx="112"/);
    expect(mark).toMatch(/strokeLinecap="round"/);
    expect(mark).not.toMatch(/clipPath/);
    expect(mark).not.toMatch(/<use /);
  });

  it('pins the settings nav to one offset, whatever the section', () => {
    const shell = read('src/styles/shell.css');
    const settings = read('src/components/SettingsWorkspace.tsx');
    // The nav is sticky inside a stretched slot, and sticks at 0. The sticky
    // offset is measured from the scrollport's content edge — already 32px down —
    // so any non-zero inset pushed the list down by that much on exactly the
    // sections whose content was taller than the nav, and the list jumped on
    // every switch between a tall and a short one.
    expect(shell).toMatch(/\.settings-sidebar-slot \{\n  align-self: stretch/);
    expect(shell).toMatch(/\.settings-sidebar \{\n  position: sticky;\n[\s\S]{0,400}?top: 0;/);
    expect(settings).toMatch(/className="settings-sidebar-slot"/);
  });

  it('paints the history rail on the scroller but never leaks it into the compact layout', () => {
    const shell = read('src/styles/shell.css');
    const workspace = read('src/components/LibraryWorkspace.tsx');
    const card = read('src/components/ArchiveThumbnailCard.tsx');
    // The per-row overshoot used to extend the scroller's scrollable area —
    // ~190px of dead scroll. The rail is scroller background now: full height at
    // rest, pinned to the edges mid-gesture, never scrollable — and explicitly
    // reset in the compact block so the phone groups by the day bars instead.
    expect(workspace).toMatch(/timelineByArchiveId \? 'has-timeline'/);
    expect(shell).toMatch(/\.archive-list\.has-timeline\s*\{[^}]*no-repeat left 72px top \/ 2px 100%/);
    expect(shell).toMatch(/\.archive-list\.has-timeline\s*\{\s*background:\s*none/);
    expect(shell).not.toMatch(/archive-row-timeline::before/);
    expect(card).toMatch(/headingIcon/);
  });

  it('answers overscroll by moving the list, and pins the refresh disc over it', () => {
    const shell = read('src/styles/shell.css');
    const workspace = read('src/components/LibraryWorkspace.tsx');
    // The notice that faded in over the first row and could outstay the gesture
    // is gone, along with the wheel-delta heuristic that fired it.
    expect(shell).not.toMatch(/library-refresh-hint/);
    expect(workspace).not.toMatch(/library-refresh-hint|pullTicks/);
    // The gesture is answered by the content: one signed offset slides the list
    // past either end, and touch tracks the finger while the wheel eases.
    expect(workspace).toMatch(/className="archive-list-pull"/);
    expect(workspace).toMatch(/data-overscroll=\{overscrollGesture \?\? undefined\}/);
    expect(shell).toMatch(/\.archive-list-pull\[data-overscroll='touch'\] \{ transition: none; \}/);
    // The disc is an overlay, not part of the sliding content: the list springs
    // back on release and the disc stays pinned and spinning above it.
    const disc = ruleBody(shell, '.library-pull-indicator');
    expect(disc).toMatch(/position: sticky/);
    expect(disc).toMatch(/z-index: var\(--z-sticky\)/);
    expect(shell).toMatch(/\.library-pull-indicator\.is-visible \.library-pull-disc \{ opacity: 1/);
    expect(workspace).toMatch(/className=\{`library-pull-indicator/);
    // Never build a class name by appending a possibly-undefined value: the
    // string "undefined" matches no rule, so the element renders raw.
    expect(workspace).not.toMatch(/\$\{[^}]*\?[^}]*:\s*undefined\s*\}/);
  });

  it('keeps toast text at WCAG AA contrast in light and dark themes', () => {
    const tokens = read('src/styles/tokens.css');
    const shell = read('src/styles/shell.css');
    const light = cssVariables(ruleBody(tokens, ':root'));
    const dark = new Map([
      ...light,
      ...cssVariables(ruleBody(tokens, ":root[data-theme='dark']")),
    ]);
    // A failed capture must not pass by checking the dark theme twice.
    expect(light.get('--surface-canvas')).not.toBe(dark.get('--surface-canvas'));
    const toast = shell.match(/\.toast-card\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const backgroundToken = toast.match(/background:\s*var\((--[\w-]+)\)/)?.[1] ?? '';
    const foregroundToken = toast.match(/color:\s*var\((--[\w-]+)\)/)?.[1] ?? '';

    for (const theme of [light, dark]) {
      const canvas = rgb(theme.get('--surface-canvas') ?? '');
      const background = rgb(theme.get(backgroundToken) ?? '', canvas);
      const foreground = rgb(theme.get(foregroundToken) ?? '', background);
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps every hover rule behind a hover capability guard', () => {
    // A tap leaves :hover stuck on the element in a WebView, so a card stayed
    // raised and a row stayed filled after the finger had gone. Every hover rule
    // is inside @media (hover: hover); the selectors that share a rule with a
    // resting state (aria-pressed, is-revealed, focus-visible) are split out and
    // left outside, because those states must still work on a touch screen.
    for (const path of ['src/styles/shell.css', 'src/styles/reader.css', 'src/styles/base.css']) {
      const sheet = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      const guarded = (() => {
        let out = '';
        let index = 0;
        for (;;) {
          const match = /@media \(hover: hover\) \{/.exec(sheet.slice(index));
          if (!match) { out += sheet.slice(index); break; }
          const at = index + match.index;
          out += sheet.slice(index, at);
          let depth = 1;
          let cursor = at + match[0].length;
          while (cursor < sheet.length && depth > 0) {
            if (sheet[cursor] === '{') depth += 1;
            else if (sheet[cursor] === '}') depth -= 1;
            cursor += 1;
          }
          index = cursor;
        }
        return out;
      })();
      expect(guarded, path).not.toMatch(/:hover/);
      expect(sheet, path).toMatch(/@media \(hover: hover\) \{/);
    }
  });

  it('takes the browser out of the gestures the app owns', () => {
    const base = read('src/styles/base.css');
    // A tap must not wait to see whether it is half of a double-tap, and a
    // double-tap must not zoom the shell: an application, not a page.
    // The control selectors are one list, so every one of them carries it. The
    // list matters: the last time these were per-component, most of them were
    // missed.
    const gesture = base.match(/([^{}]*)\{[^{}]*touch-action:\s*manipulation/)?.[1] ?? '';
    expect(gesture.length).toBeGreaterThan(0);
    expect(ruleBody(base, "[role='tab']")).toMatch(/touch-action:\s*manipulation/);
    for (const selector of ['button', 'a', 'label', 'summary', 'input', 'select', 'textarea',
      "[role='button']", "[role='checkbox']", "[role='switch']"]) {
      expect(gesture, selector).toContain(selector);
    }
    // The shell is a fixed frame, so nothing should chain a gesture back to it.
    expect(ruleBody(base, 'html')).toMatch(/overscroll-behavior:\s*none/);
    expect(ruleBody(base, 'body')).toMatch(/overscroll-behavior:\s*none/);
    // The soft keyboard resizes the viewport instead of covering the controls.
    expect(read('index.html')).toMatch(/interactive-widget=resizes-content/);
    // Machine values dominate, so the defaults are off at the root and the two
    // prose fields opt back in.
    expect(read('index.html')).toMatch(/autocapitalize="off"/);
    const metadata = read('src/components/MetadataEditRoute.tsx');
    expect(metadata).toMatch(/<label>标题<input value=\{title\} autoCapitalize="sentences"/);
    expect(read('src/components/LibraryWorkspace.tsx')).toMatch(/enterKeyHint="search"/);
  });

  it('gives small controls a finger-sized target only where a finger is used', () => {
    const shell = read('src/styles/shell.css');
    const coarse = ruleBody(shell, '@media (pointer: coarse)');
    // Rows take the height; boxes take both axes; glyphs inside a line keep
    // their drawing and grow a transparent hit overlay around their centre.
    expect(coarse).toMatch(/min-height:\s*var\(--tap-min\)/);
    expect(coarse).toMatch(/min-width:\s*var\(--tap-min\)/);
    expect(coarse).toMatch(/\.metadata-tag-delete::before,/);
    expect(coarse).toMatch(/width:\s*max\(100%,\s*var\(--tap-min\)\)/);
    expect(coarse).toMatch(/height:\s*max\(100%,\s*var\(--tap-min\)\)/);
    // 44px is the floor, and it is a token so the three sizes cannot drift.
    expect(cssVariables(ruleBody(read('src/styles/tokens.css'), ':root')).get('--tap-min')).toBe('44px');
    // The toast stack clears the bottom nav instead of hiding under it.
    expect(shell).toMatch(/@media \(max-width: 900px\) \{[\s\S]*?\.toast-stack \{[\s\S]*?bottom:\s*calc\(var\(--safe-bottom\) \+ 64px/);
  });

  it('keeps typography on the scale instead of spelling out weights and leading', () => {
    for (const path of ['src/styles/shell.css', 'src/styles/reader.css', 'src/styles/base.css']) {
      const sheet = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      // Weights, leading, tracking and every looping indicator's clock are
      // tokens — the drift they replaced was 52 / 23 / 47 deployments of the
      // same three numbers.
      expect(sheet, path).not.toMatch(/font-weight:\s*\d/);
      expect(sheet, path).not.toMatch(/line-height:\s*1\.[0-9]/);
      expect(sheet, path).not.toMatch(/letter-spacing:\s*-?[0-9.]+(px|em)/);
      expect(sheet, path).not.toMatch(/animation:[^;]*\b\d+ms\b/);
      expect(sheet, path).not.toMatch(/animation:[^;]*\b\d+(\.\d+)?s\b/);
    }
    const tokens = cssVariables(ruleBody(read('src/styles/tokens.css'), ':root'));
    for (const token of ['--weight-regular', '--weight-medium', '--weight-semibold', '--weight-bold',
      '--leading-none', '--leading-tight', '--leading-normal', '--leading-relaxed',
      '--tracking-tight', '--tracking-normal', '--tracking-wide',
      '--duration-spin', '--duration-shimmer', '--duration-pulse', '--z-raised']) {
      expect(tokens.has(token), token).toBe(true);
    }
  });

  it('says "nothing here" and "still loading" with one component each', () => {
    // EmptyState is a region; StatusLine is the one-line version. Four places
    // used to borrow the region's class on a <p> and inherit its 320px centring.
    const empty = read('src/components/EmptyState.tsx');
    const status = read('src/components/StatusLine.tsx');
    expect(empty).toMatch(/export function EmptyState\(/);
    expect(status).toMatch(/export function StatusLine\(/);
    expect(status).toMatch(/LoadingIndicator inline/);
    // The region's geometry is bound to the region element, so the borrowed-class
    // bug cannot come back to a <p>.
    expect(read('src/styles/shell.css')).toMatch(/\.empty-state:not\(section\)/);
    for (const path of ['SettingsWorkspace.tsx', 'LocalArchivesWorkspace.tsx', 'DeduplicationWorkspace.tsx', 'UploadPanel.tsx',
      'EhComments.tsx', 'ErrorLogPanel.tsx', 'EhAccountPanel.tsx', 'MetadataEditRoute.tsx', 'MorePagesRoute.tsx', 'DedupSuggestionPanel.tsx']) {
      const source = read(`src/components/${path}`);
      expect(source, path).not.toMatch(/className="empty-state"/);
      expect(source, path).not.toMatch(/server-list-message/);
      expect(source, path).not.toMatch(/<p role="status">/);
    }
    // The reader-only spinner was referenced by a class that never existed.
    expect(read('src/components/MetadataEditRoute.tsx')).not.toMatch(/className="spin"/);
    expect(read('src/components/LoadingIndicator.tsx')).toMatch(/export function LoadingIndicator\(/);
  });

  it('binds the pull to whatever scrolls, on every layout', () => {
    // The gesture used to be bound to the archive list, which only scrolls inside
    // the library's own panels on a wide window. On compact and behind the
    // shelves the page scrolls instead, so the pull did nothing on exactly the
    // layouts that have no other way to ask for a refresh — and a refresh button
    // is not the answer: the app has one way to ask, and it is this gesture.
    const workspace = read('src/components/LibraryWorkspace.tsx');
    expect(workspace).toMatch(/function scrollHost\(list: HTMLElement \| null, root: HTMLElement\)/);
    expect(workspace).toMatch(/if \(list && scrollsVertically\(list\) && overflows\(list\)\) return list;/);
    expect(workspace).toMatch(/hostRef|setScrollHostElement/);
    expect(workspace).toMatch(/host\.addEventListener\('touchmove', touchMove, \{ passive: false \}\)/);
    // The disc is pinned to the list panel, which every layout has.
    expect(workspace).toMatch(/\{onRefresh && \(/);
    // No layout may opt out of the gesture, and no second refresh control may
    // appear beside it.
    expect(workspace).not.toMatch(/if \(compact\) return/);
    expect(workspace).not.toMatch(/aria-label="刷新"/);
  });

  it('pins only the library in the compact bar', () => {
    // 档案库 is load-bearing: unchecking it would leave no way into the library.
    // 设置 is not — an unselected entry reappears under 更多 — and pinning it made
    // the checkbox look like a choice while refusing it.
    const shell = read('src/components/AppShell.tsx');
    expect(shell).toMatch(/const PINNED_NAV_KEYS: NavKey\[\] = \['\/library'\];/);
    const settings = read('src/components/SettingsWorkspace.tsx');
    expect(settings).toMatch(/const pinned = key === 'library';/);
    expect(settings).toMatch(/if \(key === 'library'\) return;/);
    // The stored preference is re-pinned on the native side too, and that is the
    // copy that actually decides: unpinning it only in the UI would have been
    // undone on the next save.
    const rust = read('src-tauri/src/settings.rs');
    const normalize = rust.slice(rust.indexOf('fn normalize_bottom_nav_items'), rust.indexOf('fn load_value'));
    expect(normalize).toMatch(/\*\*key == "library"/);
    // No pin loop may put anything back: that is what forced 设置 on the last line.
    expect(normalize).not.toMatch(/for required/);
    expect(normalize).not.toMatch(/\["library", "settings"\]/);
  });

  it('draws a phone toast the way Android does', () => {
    const shell = read('src/styles/shell.css');
    // A phone: centred over the bottom of the screen, above the bottom bar — a
    // corner is where a desktop puts a notification, not where a thumb is.
    const stack = nestedRuleBody(shell, '.toast-stack');
    expect(stack).toMatch(/justify-items: center/);
    expect(stack).toMatch(/bottom: calc\(var\(--safe-bottom\) \+ 64px \+ var\(--space-6\)\)/);
    // A solid pill sized to its message, and not something you act on: no border,
    // no dismiss control, touches through to the content underneath.
    const card = nestedRuleBody(shell, '.toast-card');
    expect(card).toMatch(/display: flex/);
    expect(card).toMatch(/justify-content: center/);
    expect(card).toMatch(/border: 0/);
    expect(card).toMatch(/border-radius: var\(--radius-pill\)/);
    expect(card).toMatch(/pointer-events: none/);
    expect(card).toMatch(/text-align: center/);
    expect(nestedRuleBody(shell, '.toast-close')).toMatch(/display: none/);
    // The desktop card keeps the snackbar it had, dismiss control included, and
    // the media block comes after it so a first-match read still finds it.
    const desktop = ruleBody(shell, '.toast-card');
    expect(desktop).toMatch(/border: 1px solid var\(--outline-variant\)/);
    expect(desktop).toMatch(/display: grid/);
    expect(ruleBody(shell, '.toast-close')).toMatch(/cursor: pointer/);
  });

  it('cleans up records that point at archives the server no longer has', () => {
    // A shelf card that only fails once it has been opened is the thing being
    // prevented: the record has to go, not just the card. Both paths that learn a
    // deletion is real must act on it, or the cleanup is only as prompt as the
    // slower of the two.
    const rust = read('src-tauri/src/commands/library.rs');
    expect(rust).toMatch(/fn prune_dangling_records_for_server\(/);
    // Only a tombstoned archive counts. A record whose archive was never indexed
    // (an import, or a list written offline) must survive: "not indexed" is not
    // evidence of deletion.
    const helper = rust.slice(rust.indexOf('fn prune_dangling_records_for_server'), rust.indexOf('pub fn prune_dangling_records'));
    expect(helper).toMatch(/JOIN archives a ON a\.server_id = \?2 AND a\.archive_id = r\.archive_id/);
    expect(helper).toMatch(/a\.is_deleted = 1/);
    expect(helper).not.toMatch(/LEFT JOIN/);
    expect(helper).toMatch(/for \(table, object_type\) in DANGLING_RECORD_TABLES/);
    // 三张表里只有两张进同步：收藏夹镜像的是服务器上的收藏分类，本机这份只是镜像的
    // 落点，删掉它不留墓碑。待看与收藏夹曾经共用一个对象类型，于是清掉一条收藏夹
    // 记录会让别的设备删掉待看里同 id 的那条——所以这条断言盯的是「各归各的名字，
    // 或者干脆没有名字」。
    expect(rust).toMatch(/\("reading_history", Some\("history"\)\),\s*\("reading_list", Some\("watchlist"\)\),\s*\("watchlist", None\),/);
    expect(read('src-tauri/src/commands/sync.rs')).toMatch(/"watchlist" => Some\("watchlist"\),\s*"search_preset" => Some\("search_presets"\),/);
    // Wired into both: the per-id verification, and the complete library walk.
    const verify = rust.slice(rust.indexOf('pub async fn verify_archives_exist'), rust.indexOf('pub fn save_reading_progress'));
    expect(verify).toMatch(/prune_dangling_records_for_server\(&mut connection, &server_id\)/);
    const refresh = rust.slice(rust.indexOf('pub async fn refresh_archives'), rust.indexOf('fn search_status_failure'));
    expect(refresh).toMatch(/prune_dangling_records_for_server\(&mut connection, &input\.server_id\)/);
    // And reachable from the bridge, so it can be triggered by hand.
    expect(read('src-tauri/src/lib.rs')).toMatch(/prune_dangling_records,/);

    // A shelf is checked in batches, so a shelf longer than one call still gets
    // looked at instead of only ever checking its first page.
    const existence = read('src/lib/archiveExistence.ts');
    expect(existence).toMatch(/for \(let at = 0; at < unchecked\.length; at \+= VERIFY_BATCH\)/);
    expect(existence).toMatch(/if \(!result\.ok\) break;/);
    const verifyLimit = Number(rust.match(/const VERIFY_ARCHIVE_LIMIT: usize = (\d+);/)?.[1]);
    const batch = Number(existence.match(/const VERIFY_BATCH = (\d+);/)?.[1]);
    expect(batch).toBeLessThanOrEqual(verifyLimit);
  });

  it('describes each setting in one line', () => {
    // Hints used to be two clauses joined by ；, the second restating the label or
    // the disabled state. The label says what it is; the hint says only what the
    // label cannot.
    const settings = read('src/components/SettingsWorkspace.tsx');
    // A hint is either a literal or a conditional of literals; the strings inside
    // are what a reader sees, so those are what has to stay short.
    const hints = [...settings.matchAll(/hint=(?:"([^"]*)"|\{([^}]*)\})/g)]
      .flatMap((match): string[] => (match[1] !== undefined
        ? [match[1]]
        : [...(match[2] ?? '').matchAll(/'([^']*)'/g)].flatMap((inner) => (inner[1] === undefined ? [] : [inner[1]]))))
      .filter((hint) => hint.length > 0);
    const longest = hints.reduce((worst, hint) => (hint.length > worst.length ? hint : worst), '');
    expect(hints.length).toBeGreaterThan(15);
    expect(longest.length, `longest hint: ${longest}`).toBeLessThanOrEqual(34);
  });
  it('keeps the loading mark moving under reduced motion', () => {
    // 加载指示是**不确定进度**：它在说「还在跑」。base.css 的减弱动效通杀规则把每个
    // 动画压成 `1ms` 一次，装饰性动效那样收掉是对的，但这一条会被收成一根冻住的弧
    // ——看起来是「卡住了」，比动着的圈更糟。实测：reduce 下 1.4 秒的加载里 dashoffset
    // 一直是 0。所以这里必须重新声明一个真的时长 + 无限的迭代次数（都得带 !important，
    // 通杀规则就是用 !important 压下来的），并且只动透明度。
    const shell = read('src/styles/shell.css');
    // shell.css 里不止一个减弱动效块，所以从关键字眼后面的那一个开始找。
    const marker = '@keyframes loading-indicator-breathe';
    const start = shell.indexOf('@media (prefers-reduced-motion: reduce)', shell.indexOf(marker));
    expect(start, '没有找到标记用的减弱动效块').toBeGreaterThan(0);
    const open = shell.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let index = open; index < shell.length; index += 1) {
      if (shell[index] === '{') depth += 1;
      else if (shell[index] === '}' && (depth -= 1) === 0) { end = index; break; }
    }
    const block = shell.slice(open + 1, end);
    // 两个标记（大圈与小圈）都要重新声明，且都必须压过通杀规则。
    expect(block).toMatch(/\.loading-indicator svg,\s*\n\s*\.loading-mark svg\s*\{[^}]*animation-name:\s*loading-indicator-breathe\s*!important/);
    expect(block).toMatch(/animation-duration:\s*var\(--duration-pulse\)\s*!important/);
    expect(block).toMatch(/animation-iteration-count:\s*infinite\s*!important/);
    // 位移与旋转在减弱动效里不出现：呼吸只动透明度。
    const breathe = ruleBody(shell, marker);
    expect(breathe).toMatch(/opacity/);
    expect(breathe).not.toMatch(/transform|translate|rotate|scale/);
    // 弧的形状动画关掉：形状每帧变是主线程重画，这里正好连它也免了。
    expect(block).toMatch(/\.loading-indicator-arc\s*\{\s*animation:\s*none/);
  });

  it('decodes every fetched image off the main thread', () => {
    // `decoding="async"` 不是装饰：默认的 `auto` 允许浏览器在"下一帧就要画它"时**在主线程上
    // 同步解**那张图。这个应用里的图是几百万像素的漫画页与封面，而这一刻屏幕上往往正转着
    // 加载圈（`stroke-dasharray` 动画，正是主线程画的）——同步解码就是"圈卡住"的一种成因。
    // 卡片缩略图一直写着 async，几处大图（阅读页、封面大图、详情封面）漏着。
    const offenders: string[] = [];
    for (const name of readdirSync(resolve(root, 'src/components'))) {
      if (!name.endsWith('.tsx')) continue;
      // 先去掉注释：文档里提到 `<img src="…svg">` 的那些不算数。
      const source = read(resolve('src/components', name)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const images = source.match(/<img/g)?.length ?? 0;
      const async = source.match(/decoding="async"/g)?.length ?? 0;
      if (images > async) offenders.push(`${name}: ${images} 张 <img>，只有 ${async} 张写了 decoding="async"`);
    }
    expect(offenders).toEqual([]);
  });

  it('draws the DLSSNR variant rows with the shared choice row', () => {
    // 用户报了几次同一条：DLSSNR 的组件菜单自己造了一套两行行式（strong + small），
    // 和「超分模型」那一排长得不是一种东西。变体行现在与模型菜单同一套行式：选项名
    // 一行，行尾挂同一个下载按钮——「使用中 · 体积」那行字整行去掉，已安装与否由
    // 高亮（is-active）与 aria-pressed 说，进度走和模型菜单同一个槽。这里只盯组件
    // 源码：那条已经没人用的 `.dlssnr-variant-copy` 规则由协调者从 shell.css 里删。
    const source = read('src/components/DlssnrSettingsGroup.tsx');
    expect(source).not.toContain('dlssnr-variant-copy');
    expect(source).toMatch(/className="settings-choice-option-main"/);
    expect(source).toMatch(/className="select-option-download"/);
  });

  it('packs choice rows with no phantom second line and centres their labels', () => {
    // 模型菜单每一项都挂着常驻的下载进度槽（关着时高度 0）。`gap` 会给换下来的那条
    // **空**行照样留 8px 行间距，于是每行都比自己的按钮高 8px、高亮块跟着多出一截，
    // 看上去就是「底部空隙过大」（探针实测：行高 50.4px / 按钮 42.7px）。
    // 注释里也写着 `row-gap: 0` 这几个字（解释为什么必须为 0），所以先剥注释再断言，
    // 否则「声明被改回 8px」这种回归会被注释里的字面量蒙混过去。
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const source = read('src/components/DlssnrSettingsGroup.tsx');
    expect(shell).toMatch(/\.settings-choice-option\s*\{[^}]*row-gap:\s*0/);
    // 用户报的：选项名字全贴着左边，和高亮块不是一个中心。
    expect(shell).toMatch(/\.settings-choice-option-main\s*\{[^}]*justify-content:\s*center[^}]*text-align:\s*center/);
    // 例外：「设备行」（管理已有配对 / 添加设备）是图标 + 名字/地址的网格，保持左对齐。
    expect(shell).toMatch(/\.settings-choice-option-main\.settings-device-option\s*\{\s*justify-content:\s*flex-start;\s*text-align:\s*left/);
    // DLSSNR 变体行尾那行「使用中 · 体积」整行去掉，规则也删了，别再有人捡回来。
    expect(shell).not.toMatch(/\.settings-row-note\s*\{/);
    expect(source).not.toContain('settings-row-note');
  });

  it('keeps a filled row concentric with its 28px shell and mirrors the row-end button', () => {
    // 图①：二级菜单的外壳是 28px，里面的高亮行是 8px——两个圆角各转各的圆心，看上去
    // 就是「内外圆角不统一」。同心规则写进了 tokens 的形状尺度注释：内层 = 外层 − 外壳
    // 自身内缩。浮动面板是全项目唯一 28px 外壳 + 16px 内缩，所以家族里的填充行用 12px。
    const tokens = read('src/styles/tokens.css');
    expect(tokens).toMatch(/Nesting rule \(同心圆角\)/);
    expect(tokens).toMatch(/inner radius is\s+the outer radius minus the shell's own inset/);
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const selector of [
      '.settings-choice-option',
      '.settings-menu-path',
      '.settings-menu-account',
      '.settings-menu-check',
      '.settings-menu-mode-button',
      '.custom-scheme-card',
      '.search-preset-apply',
    ]) {
      expect(ruleBody(shell, selector), selector).toMatch(/border-radius:\s*var\(--radius-card\)/);
    }
    // 从不画填充的那一层不跟着换：它 hover 被显式压成透明，半径只影响焦点环。
    expect(ruleBody(shell, '.settings-choice-option-main')).toMatch(/border-radius:\s*var\(--radius-control\)/);

    // 图②：行尾挂下载/更新按钮时（40px + margin 2px + 行内 gap 8px = 50px），文字中心
    // 偏左 25px——半行宽无关，只看这一块。补一块等宽的镜像留白把中心顶回去；已安装的行
    // 不渲染按钮，同一列里才会「有的居中有的偏左」，所以镜像槽必须按按钮在不在生效。
    expect(shell).toMatch(
      /\.settings-choice-option:has\(> \.select-option-download\)\s*\{\s*padding-left:\s*calc\(40px \+ 2px \+ var\(--space-2\)\)/,
    );
  });

  it('steps a hovered choice row up a tone and keeps the last one concentric with the panel bottom', () => {
    // 图③：鼠标移到没选中的行上什么都没发生，只有选中那行有反馈。根因不是「忘了写 hover」，
    // 而是 hover 填的 `--surface-container-high` 就是面板自己的底色——等于没变。改法和档案卡
    // 那张卡一样：往上走一阶。
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(shell).toMatch(/\.settings-choice-option:hover\s*\{\s*background:\s*var\(--surface-container-highest\)/);
    const touchBlock = shell.slice(shell.lastIndexOf('@media (hover: none) {'));
    expect(touchBlock).toMatch(/\.settings-choice-option:is\(\.is-pressed, :active\)\s*\{\s*background:\s*var\(--surface-container-highest\)/);

    // 图③的另一半：列表正好收尾时面板的下内边距只有 space-1，最后一行离面板底只有 8.7px，
    // 它的 12px 圆角和面板的 28px 弧线就不平行了。内半径 = 外半径 − 间距。
    expect(shell).toMatch(
      /\.settings-choice-panel:has\(> \.settings-menu-body > \.settings-choice-list:last-child\) > \.settings-menu-body > \.settings-choice-list > \.settings-choice-option:last-child\s*\{\s*border-bottom-left-radius:\s*calc\(var\(--radius-overlay\) - 8\.7px\);\s*border-bottom-right-radius:\s*calc\(var\(--radius-overlay\) - 8\.7px\)/,
    );
  });

  it('steps the neutral rows inside a settings panel up a tone, where the panel is already high', () => {
    // ⑤ 的另一半：二级菜单的面板（`.settings-choice-panel` / `.search-preset-panel`）自己的底色就是
    // `--surface-container-high`，而「中性 hover 家族」填的也是这一阶（shell.css 的那条统一规则）——
    // 于是面板里的设置行、菜单勾选、配色卡、预设应用移上去同样什么都没发生，和用户报的选中项那半
    // 是同一个根因。只给面板内的子项再上一阶，面板外的同类行不动。
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(shell).toMatch(
      /\.settings-choice-panel \.settings-row-button:hover:not\(:disabled\),\s*\.settings-choice-panel \.settings-menu-check:hover:not\(:disabled\),\s*\.settings-choice-panel \.custom-scheme-card:hover,\s*\.search-preset-panel \.search-preset-apply:hover\s*\{\s*background:\s*var\(--surface-container-highest\)/,
    );
    const touchBlock = shell.slice(shell.lastIndexOf('@media (hover: none) {'));
    expect(touchBlock).toMatch(
      /\.settings-choice-panel \.settings-row-button:is\(\.is-pressed, :active\):not\(:disabled\),\s*\.settings-choice-panel \.settings-menu-check:is\(\.is-pressed, :active\):not\(:disabled\),\s*\.settings-choice-panel \.custom-scheme-card:is\(\.is-pressed, :active\),\s*\.search-preset-panel \.search-preset-apply:is\(\.is-pressed, :active\)\s*\{\s*background:\s*var\(--surface-container-highest\)/,
    );
  });

  it('keeps a cover inside the image budget after its last consumer lets go', () => {
    // ⑥：封面「切走再回来闪一下」的正解不是淡入，是让它重新挂载的第一帧就有图。三条取封面的
    // 路径（卡片、档案库列表、书架）都必须 retain，否则 release 到 0 引用就 revoke，
    // 缓存记忆消失——回前台只能从骨架重来。`peek` 是同步种子，只读；`release` 只在
    // 「refs 归零且没 retain」时才真撤。
    const cache = read('src/lib/unifiedImageCache.ts');
    expect(cache).toMatch(/if \(entry\.refs === 0 && !entry\.retain\)/);
    expect(read('src/components/ArchiveThumbnailCard.tsx')).toContain('retain: true');
    const retainWithSignal = /\{ retain: true, \.\.\.\(signal \? \{ signal \} : \{\}\) \}/;
    expect(read('src/components/LibraryRouteWorkspace.tsx')).toMatch(retainWithSignal);
    expect(read('src/app/routes.tsx')).toMatch(retainWithSignal);
  });

  it('fades in only the rows a background refresh brought in', () => {
    // 图⑤：后台刷新把整个数组换成新的，屏幕上却「什么都没发生」。只有发起请求的那一层
    // 分得出谁是新来的：它给这些行的外壳挂 is-fresh，动画落在行本身——虚拟化把
    // translateY 内联写在 .archive-row-wrap 上，动那一层会和布局打架（:1138 也钉着）。
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(shell).toMatch(/@keyframes archive-row-fresh-in\s*\{/);
    expect(shell).toMatch(
      /\.archive-row-wrap\.is-fresh > \.archive-row,\s*\.archive-row-wrap\.is-fresh > \.archive-thumb-card\s*\{\s*animation:\s*archive-row-fresh-in var\(--motion-standard\) backwards/,
    );
    const list = read('src/components/LibraryWorkspace.tsx');
    expect(list).toContain('freshArchiveIds?: ReadonlySet<string>');
    expect(list).toContain("' is-fresh'");
    const workspace = read('src/components/LibraryRouteWorkspace.tsx');
    expect(workspace).toMatch(/FRESH_ARCHIVE_HIGHLIGHT_MS = 700/);
    // 只有后台/静默重读才播动画：翻页追加的行是用户自己滚出来的。
    expect(workspace).toMatch(/collectFreshArchiveIds\(unique, options\.background === true \|\| options\.silent === true\)/);
    expect(workspace).toMatch(/freshArchiveIds=\{freshArchiveIds\}/);
  });
});
