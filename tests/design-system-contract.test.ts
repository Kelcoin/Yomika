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
  it('keeps dialog centering independent from its entry animation', () => {
    const entry = ruleBody(read('src/styles/visual-enhancements.css'), '@keyframes dialog-in');
    expect(entry).toMatch(/scale:\s*0\.96/);
    expect(entry).not.toMatch(/transform:/);
    expect(ruleBody(read('src/styles/shell.css'), '.dialog-content')).toMatch(/transform: translate\(-50%, -50%\)/);
  });

  it('does not apply archive tag tracks to an unfinished download', () => {
    const shell = read('src/styles/shell.css');
    const copy = ruleBody(shell, '.local-archives-list .archive-row.is-downloading > .archive-row-copy');
    expect(copy).toMatch(/height:\s*auto/);
    expect(copy).toMatch(/grid-template-rows:\s*auto 4px auto/);
    expect(copy).toMatch(/align-content:\s*center/);
  });

  it('keeps compact page flow free of duplicated viewport and tail reservations', () => {
    const compact = ruleBody(read('src/styles/shell.css'), '@media (max-width: 900px)');
    // Check all compact blocks: some specialize sizing after the first block.
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.library-shell\.has-detail > \[data-panel\]:has\(\.library-shell-detail\) \{\s*height: auto !important/);
    expect(shell).toMatch(/\.archive-detail-route \{ min-height: 0; \}/);
    expect(shell).toMatch(/\.local-archives \{ height: auto; min-height: 0; \}/);
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \{ padding-bottom: 0; \}/);
    expect(compact).toBeTruthy();
  });

  it('keeps comment voting in one compact row with a right-aligned trailing score', () => {
    const shell = read('src/styles/shell.css');
    expect(ruleBody(shell, '.eh-comment-votes')).toMatch(/flex-wrap:\s*nowrap/);
    expect(ruleBody(shell, '.eh-comment-votes .eh-comment-score')).toMatch(/text-align:\s*end/);
    expect(ruleBody(shell, '.eh-comment-votes-actions button')).toMatch(/flex:\s*0 0 28px/);
    expect(ruleBody(shell, '.eh-comment-votes-actions svg')).toMatch(/display:\s*block/);
  });

  it('does not stretch shelf errors into a full-page obstruction', () => {
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.shelf-workspace\s*>\s*\.form-error\s*\{[^}]*align-self:\s*start/);
  });
  it('invalidates the shelf snapshots after a category mirror write', () => {
    // Successful category writes invalidate remote Favorites snapshots as well as shelves.
    const repository = read('src/repositories/nativeLibraryRepository.ts');
    const add = repository.slice(repository.indexOf('addArchiveToCategory('), repository.indexOf('removeArchiveFromCategory('));
    expect(add, '分类写成功后作废收藏夹快照').toMatch(/then\(invalidateFavorites\)/);
    const remove = repository.slice(repository.indexOf('removeArchiveFromCategory('), repository.indexOf('updateArchiveMetadata('));
    expect(remove).toMatch(/then\(invalidateFavorites\)/);
    const metadataWrite = repository.slice(repository.indexOf('updateArchiveMetadata('), repository.indexOf('listMetadataPlugins('));
    expect(metadataWrite).toMatch(/then\(invalidateShelves\)/);
    expect(repository).toMatch(/function invalidateFavorites[\s\S]*?invalidateShelves\(result\)/);
    // Favorites membership comes exclusively from the current remote category.
    const routes = read('src/app/routes.tsx');
    expect(routes, '收藏夹读取服务器分类').toMatch(/readFavoritesCategory/);
    expect(routes, '收藏夹不把分类并进书架').not.toMatch(/\.\.\.favoritesIds/);
    expect(routes, '快照里不再存服务器那条分类的 id').not.toMatch(/favoritesIds/);
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
    expect(compactMain).toMatch(/height:\s*calc\(var\(--viewport-height\) - \(64px \+ var\(--safe-bottom\)\)\)/);
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
    // Android 侧量到的是**物理像素**（androidx 的 `getInsets` 就是物理像素），而页面
    // 拿到的是 CSS 像素（WebView 里 1 CSS px = 1 dp，`src/lib/safeArea.ts` 直接拼
    // `${top}px`）。少这一次除法就是「移动端上下避让过大」：3x 机上 24dp 的状态栏
    // 变成 72px，页面顶部往下多让 48px、底栏上方也多出一条空白。
    const mainActivity = read('src-tauri/gen/android/app/src/main/java/app/yomika/reader/MainActivity.kt');
    expect(mainActivity).toMatch(/val density = resources\.displayMetrics\.density/);
    expect(mainActivity, '状态栏高度要换算成 CSS 像素再交给页面').toMatch(/val top = Math\.round\(bars\.top \/ density\)/);
    expect(mainActivity, '手势条高度要换算成 CSS 像素再交给页面').toMatch(/val bottom = Math\.round\(bars\.bottom \/ density\)/);
    // 换算后的那两个值才是给页面与 `insets` 命令的那一份，`bars` 原文不再外流。
    expect(mainActivity).toMatch(/pushInsetsToPage\(appWebView\(view\), top, bottom\)/);
    expect(mainActivity).toMatch(/SystemBars\.top = top/);
    expect(mainActivity).toMatch(/SystemBars\.bottom = bottom/);
  });

  // 用户报的：阅读模式整屏盖住了自绘标题栏，那一屏里没有任何地方能拖动窗口。
  // 手势只有一处实现，三个地方铺开（外壳标题栏与阅读器两条栏）；失败页说「加载
  // 失败」这一件事实，不把宿主原话（自带服务器地址与请求路径）贴上画布。
  it('moves the window from whichever bar is on screen, and states a failure without echoing it', () => {
    const controls = read('src/components/WindowControls.tsx');
    expect(controls).toContain('export function useWindowDrag(');
    // 一次按下才是一次拖动（`detail !== 1` 就是双击的第一下），栏上的控件自己吃掉。
    expect(controls).toContain('event.button !== 0 || event.detail !== 1');
    expect(controls).toContain("closest('button, a, input, select, textarea')");
    expect(controls).toContain('void api?.startDragging()');
    expect(controls).toContain('void api?.toggleMaximize()');

    // 外壳标题栏改用手势件，不再自己抄一遍；阅读器两条栏都铺上它。
    expect(read('src/components/TitleBar.tsx')).toContain('<header className="titlebar" {...drag}>');
    expect(read('src/components/ReaderScreen.tsx')).toContain('{...windowDrag}');
    // 窗口按钮只在**桌面**上画：Tauri 的桥在 Android/iOS 上一样存在，只看桥会把
    // 「最大化」画到手机上（`plugin:window|toggle_maximize` 在那边是空操作，点了
    // 没反应——用户报的「移动端下阅读模式顶栏不应该有最大化/最小化按钮」）。
    expect(read('src/components/ReaderScreen.tsx')).toMatch(/windowApi && platform === 'windows' \? \(/);
    expect(read('src/components/ReaderScreen.tsx')).toContain('getPlatformCapabilities().then((result) => {');
    const route = read('src/components/ReaderRoute.tsx');
    expect(route).toContain('{...windowDrag}');
    expect(route).toContain('<p role="alert">加载失败</p>');
    expect(route).not.toContain('<p role="alert">{error}</p>');
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
    expect(reader).toMatch(/transform: `scale\(\$\{zoomRef\.current\.scale\}\)/);
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

  // 用户报的「移动端两个开屏页」：Android 上同一个品牌印记被画了四遍（12+ 系统开屏、
  // 窗口背景、index.html 的静态帧、React 的 SplashFrame）。前两遍是原生资源，判据在
  // tests/contracts/mobile-packaging.test.ts 的「every theme variant」；这里盯网页那
  // 两帧——它们必须**同一张画**，否则 React 首次 render 把静态帧整体换掉的那一刻会跳
  // 一下，用户看到的就是第二张开屏页。
  it('protects the first paint without replaying a React splash', () => {
    const html = read('index.html');
    expect(html).toContain('app-splash-static');
    expect(html).toContain("data-native-mobile='true'");
    expect(html).toContain("invoke('frontend_ready')");
    expect(read('src/components/SplashFrame.tsx')).toContain('return null');
    expect(read('src/components/SplashFrame.tsx')).not.toMatch(/setTimeout|requestAnimationFrame/);
    expect(html.indexOf("localStorage.getItem('yomika.last-theme')")).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf("localStorage.getItem('yomika.last-custom-css')")).toBeLessThan(html.indexOf('</head>'));
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
    expect(app).toMatch(/if \(floatingNav\) \{\s*setCompactNavHidden/);
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
    // 用户报告（第 5 条）：档案库、历史、收藏、待看这四页右侧多出一段空白，首页与
    // 本地档案没有。这四页的分隔线画在 `.library-panels` 上，而它是 react-resizable-panels
    // 的 Group，那一层带着行内 `width: 100%`；全局 `box-sizing: border-box` 之下，100%
    // 量到的是包含块（外壳内容盒，两侧各让出 16px），负外边距只能把整框往左推、并不能
    // 让它变宽，于是边框盒右端短了 32px，再经自身 16px 内边距把列表又推回内侧。
    // 上面那条 `margin-inline` 只在 `width: auto` 时才真的成立——宽度交回给
    // 「外边距盒填满包含块」（与本地档案页的 `.local-archives-list` 同一套写法）。
    expect(ruleBody(shell, '.library-panels')).toMatch(/width:\s*auto\s*!important/);
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
    // `<div` 与 `className` 之间允许换行：属性一多就会被折成多行，那是排版不是形状，
    // 条款只该钉「浮层是 OverlayLayer 的直接子节点」这件事。
    expect(controls).toMatch(/<OverlayLayer>\s*<div\s+className="settings-choice-overlay"/);
    expect(preset).toMatch(/<OverlayLayer>\s*<div\s+className="search-preset-overlay"/);
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
    // 进度条画的是共享组件（同一套类名与量法），不是这里再手写一条。
    expect(read('src/components/ModelDownloadControls.tsx')).toContain('<CardProgressBar');
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
    // 宽度按同一笔账现算：两个双字标签的墨迹（13px × 2）+ 条目左右各 8px 内边距 + 容器
    // 左右各 4px 内边距 + 两条 1px 边框 + 两侧各 4px 余量。这样改设计只发生在 CSS/令牌那
    // 一侧，Rust 那个数不再需要人肉同步。2026-10-16 按这笔账从 84 收到 60：84 里两个双字
    // 标签左右各空 29px，用户报「左右空隙太大」（工装 debug_outputs/tray-round/probe-tray.mjs
    // 在 84/72/64/60/56/52 六个宽度下量过，60 两侧各 17px、不裁切）。
    const space2 = Number(/--space-2:\s*(\d+)px/.exec(read('src/styles/tokens.css'))?.[1]);
    const textSm = Number(/--text-sm:\s*(\d+)px/.exec(read('src/styles/tokens.css'))?.[1]);
    expect(space2).toBeGreaterThan(0);
    expect(textSm).toBeGreaterThan(0);
    const expectedWidth = textSm * 2 + space2 * 2 + space1 * 2 + 1 * 2 + 4 * 2;
    expect(rust).toMatch(new RegExp(`pub const MENU_WIDTH: f64 = ${expectedWidth}\\.0;`));
    // 仍然**窄于**系统菜单：参考图里两个双字条目的系统菜单约 121px。
    expect(expectedWidth).toBeLessThan(84);
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
    // 文字居中：这一层是 flex，文字是一个匿名 flex item，横向位置只认 `justify-content`
    // （`text-align: start` 在 flex 里管不着它，菜单看起来就偏左——用户报的）。
    expect(item).toMatch(/justify-content:\s*center/);
    expect(item).not.toMatch(/text-align:\s*start/);
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

  it('names every colour slot the master mark uses', () => {
    // 母版把颜色写成槽名而不是字面量，因为它一张画要供两个世界（打包件没有
    // currentColor，内联组件必须跟随主题）。槽名是**契约**：漏一处就会出现一个浏览器
    // 认不出的 `fill="YOMIKA_…"`，图标直接画不出来——托盘那次就是这么踩的。
    const master = read('assets/yomika-mark.svg');
    const used = [...new Set([...master.matchAll(/fill="(YOMIKA_[A-Z_]+)"/g)].map((m) => m[1]))].sort();
    expect(used, '母版至少要用一个颜色槽').not.toHaveLength(0);

    // 打包世界：派生脚本把槽解析成字面量。名单从母版现读，脚本只提供一张表。
    const script = read('.github/scripts/derive-logo.mjs');
    for (const slot of used) {
      expect(script, `derive-logo.mjs 里没有 ${slot} 的下场`).toContain(slot);
    }
    // 内联世界：每个槽都要在令牌里有一条线，并且在组件里真的被引用。
    const tokens = read('src/styles/tokens.css');
    const component = read('src/components/YomikaMark.tsx');
    // 两处都要先剥注释：注释里会**提到**退场的旧令牌名，那是历史说明，不是声明/引用。
    const strip = (source: string) => source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
    const declared = strip(tokens);
    const drawn = strip(component).replaceAll('\\"', '"');
    expect(declared).toMatch(/--yomika-mark-plate:\s*var\(--surface-container-highest\)/);
    expect(declared).toMatch(/--yomika-mark-ink-accent:\s*var\(--on-surface-variant\)/);
    expect(drawn).toMatch(/fill="var\(--yomika-mark-plate/);
    expect(drawn).toMatch(/fill="var\(--yomika-mark-ink-accent/);
    // 旧的描边框令牌随描边字形一起退场：16px 下它抢的是字形要用的宽度。
    expect(declared).not.toMatch(/--yomika-mark-frame\s*:/);
    expect(drawn).not.toMatch(/yomika-mark-frame/);

    // 母版带的是槽名，所以**它不能被当成图片引用**：`<img src>` 是独立文档，没有
    // CSS 变量可解析，浏览器看到 `fill="YOMIKA_PLATE"` 只会画出一个方块（README 上一版
    // 就指向母版）。会渲染的地方一律指派生件——那里槽已经解析成字面量。
    const readme = read('README.md');
    expect(readme, 'README 的标记要指派生件，不能指带槽名的母版').toMatch(/assets\/yomika-mark\.svg|<img[^>]*src="[^"]*app-icon\.svg"/);
    expect(readme).not.toMatch(/<img[^>]*src="assets\/yomika-mark\.svg"/);
  });

  it('derives the approved reading mark everywhere from one master', () => {
    const master = read('assets/yomika-mark.svg');
    // 这份设计稿是**契约的输入**，而 `docs/*` 按 `.gitignore:2` 默认不入库：它必须被
    // 显式入库（`git add -f`，仓库里另外两份 superpowers 设计稿就是这么进去的），否则
    // 干净检出与 CI 会在这一行读不到文件而红。它不能被挪进 `assets/`——本用例末尾那条
    // 断言 `assets/` 下有且只有一份 svg。
    const approved = read('docs/superpowers/specs/2026-10-14-yomika-reading-mark.svg');
    const paths = (source: string) => [...source.matchAll(/d="(M[^"]+)"/g)].map(match => match[1]);
    expect(paths(master)).toEqual(paths(approved));
    expect(paths(master)).toHaveLength(4);
    for (const surface of ['index.html', 'src-tauri/icons/app-icon.svg', 'src-tauri/icons/android-foreground.svg']) {
      expect(paths(read(surface))).toEqual(paths(master));
    }
    const component = read('src/components/YomikaMark.tsx').replaceAll('\\"', '"');
    expect(paths(component)).toEqual(paths(master));
    expect(read('src-tauri/icons/android-foreground.svg')).toContain('scale(0.68)');
    expect(readdirSync(resolve(root, 'assets')).filter(name => name.endsWith('.svg'))).toEqual(['yomika-mark.svg']);
  });

  it('retains tray decoding and fallback with a generated bitmap', () => {
    expect(readFileSync(resolve(root, 'src-tauri/icons/tray-32.png'))).toEqual(readFileSync(resolve(root, 'src-tauri/icons/32x32.png')));
    const lib = read('src-tauri/src/lib.rs');
    expect(lib).toContain('include_bytes!("../icons/tray-32.png")');
    expect(lib).toContain('app.default_window_icon().cloned()');
    expect(read('src-tauri/Cargo.toml')).toMatch(/tauri\s*=\s*\{[^}]*"image-png"/);
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

  it('centers the second-level menu title while the preset list keeps its gutter', () => {
    const shell = read('src/styles/shell.css');
    const title = ruleBody(shell, '.settings-choice-title');
    // 2026-10-15 用户报「所有设置页面二级菜单的标题都不居中了」：2026-10-14 那轮为了让
    // 「标题文字与设备名同一个 x」把它改成了 flex-start + 12px 内缩，居中就是那次丢的。
    // 现在标题的内容块（图标 + 文字）在面板内容区里居中；字号/字重保留那一轮压下来的
    // `--text-md`/`--weight-semibold`（当时那版居中标题是 20px/700，量出来头重脚轻）。
    expect(title).toMatch(/justify-content:\s*center/);
    expect(title, '居中不能被左侧内缩推偏').not.toMatch(/padding-inline-start/);
    expect(title).toMatch(/display:\s*flex/);
    expect(title).toMatch(/font-size:\s*var\(--text-md\)/);
    expect(title).toMatch(/font-weight:\s*var\(--weight-semibold\)/);
    expect(title).toMatch(/gap:\s*var\(--space-3\)/);
    // 搜索预设那条标题不跟着居中：它下面是一列预设，标题与行文字左对齐读起来才是一组。
    const preset = ruleBody(shell, '.search-preset-title');
    expect(preset).toMatch(/justify-content:\s*flex-start/);
    expect(preset).toMatch(/padding-inline-start:\s*var\(--space-3\)/);
    // 32px 的图标槽仍由标题行自己出：标题块的高度与图标尺寸都跟着它。
    expect(shell).toMatch(/\.settings-choice-icon \{[^}]*width:\s*32px/);
    expect(shell).toMatch(/\.settings-choice-icon svg \{\s*width:\s*18px;\s*height:\s*18px/);
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

  it('pins a menu-level action to the title row without pushing the title off the gutter', () => {
    const shell = read('src/styles/shell.css');
    // 标题左对齐落在条目行那条栏上（上一条），菜单自己的动作仍然必须脱出文档流钉在
    // 行右端：跟着 flex 排在标题后面会把这一条整体推长，问号还会随标题文字长短左右
    // 横跳。「这一屏是什么」比旁边那枚按钮更该留在原位。
    expect(ruleBody(shell, '.settings-choice-title')).toMatch(/position:\s*relative/);
    const action = ruleBody(shell, '.settings-choice-action');
    expect(action).toMatch(/position:\s*absolute/);
    expect(action).toMatch(/inset-inline-end:\s*0/);
    // 没传 action 的菜单一个节点都不多渲染：这一格是 opt-in 的。
    expect(read('src/components/SettingsValueControls.tsx'))
      .toMatch(/\{action && <span className="settings-choice-action">/);
    // 层参数说明那枚问号比 .icon-action 小一号——40px 会把标题行撑高。
    const toggle = ruleBody(shell, '.settings-help-toggle');
    expect(toggle).toMatch(/width:\s*28px/);
    expect(toggle).toMatch(/height:\s*28px/);
  });

  it('floats the layer help away from the panel that toggles it', () => {
    const shell = read('src/styles/shell.css');
    // 说明气泡得是门户 + fixed：菜单面板是固定高度 + overflow:hidden 的弹层，说明块一写进
    // 内容流就会把面板撑高、把问号挤走——指针还停在原地而按钮已经挪开，于是来回抖。
    const bubble = ruleBody(shell, '.settings-help-bubble');
    expect(bubble).toMatch(/position:\s*fixed/);
    // 面板自己占 --z-overlay(50)，气泡要压得住它才看得见。
    expect(bubble).toMatch(/z-index:\s*var\(--z-modal\)/);
    expect(read('src/components/DlssnrSettingsGroup.tsx')).toMatch(/<OverlayLayer>/);
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
    expect(ruleBody(shell, '.archive-recommendations-tabs')).toMatch(/grid-template-columns:\s*auto minmax\(0, 0fr\)/);
    expect(ruleBody(shell, '.archive-recommendations-tabs.has-creator')).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\)/);
    expect(shell).not.toMatch(/archive-recommendations-tabs:not\(\.has-creator\) \.archive-recommendations-tab-creator\s*\{\s*display:\s*none/);
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
    // 内容区是纯滚动容器：没有任何负外边距。负外边距会把内容盒顶出滚动容器自己的
    // 边界，最后一项永久有一截落在视野之外（实测被切 10px）。早先它的 `margin: -2px`
    // 是拿来抵面板内边距的，那条抵账现在不需要了（见下面「四边同内缩」那条）。
    expect(body).not.toMatch(/margin:\s*-?\d/);
    // 内容区自己**不添内缩**（0，不是 2px）：从前那圈「给焦点环的余量」保护不到任何
    // 东西——焦点环是 `outline-offset: -2px` 朝内画的——却把行推到 18px 内缩上，同心
    // 半径成了 28 − 18 = 10，行里第一行文字也比标题宽出 2px（见「四边同内缩」那条）。
    // 末行下面也不许再补一层内边距，那就把同一行的三个方向弄成套不起来了。
    expect(body).toMatch(/padding:\s*0;/);
    expect(body).not.toMatch(/padding:\s*2px/);
    expect(shell).not.toMatch(/\.settings-choice-panel:has\([^)]*\)[^{]*\{\s*padding-bottom/);
    expect(shell).not.toMatch(/settings-menu-body\s*\{\s*padding-bottom/);
    // 标题与说明是选择器列表，ruleBody 只吃单条选择器，这里直接看规则本体。
    expect(shell).toMatch(/\.settings-choice-panel > \.settings-choice-title,\s*\n\.settings-choice-panel > \.settings-menu-desc\s*\{\s*\n\s*flex:\s*none/);
  });

  it('keeps the floating panel inside one inset so every row stays concentric with it', () => {
    // 用户报的「四周圆角不一致」：面板的圆角在四边不相等（上 52 / 左 17 / 右 17 / 下 5，
    // 实测），最后一行只好单开一个 `calc(var(--radius-overlay) - 8.7px)` 的下半径，
    // 8.7px 是量出来的死数。同心规则（tokens.css「Nesting rule (同心圆角)」）只在四边
    // 内缩相等时才解得开：内半径 = 外半径 − 内缩，28 − 16 = 12 = `--radius-card`。
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const panel = ruleBody(shell, '.settings-choice-panel');
    expect(panel).toMatch(/padding:\s*var\(--space-4\)/);
    expect(panel).toMatch(/border-radius:\s*var\(--radius-overlay\)/);
    // 描边会给每条边各加 1px：16 + 1 = 17，内半径就成了 28 − 17 = 11，不在尺度上。
    expect(panel).toMatch(/border:\s*0/);
    expect(panel).not.toMatch(/border:\s*1px/);
    // 面板不再砍自己的下内边距（那条 `:has(...) { padding-bottom: var(--space-1) }`），
    // 也不再借滚动容器的下内边距偷偷补回来——两种写法都让同一行的内缩不成套。
    expect(shell).not.toMatch(/\.settings-choice-panel:has\([^)]*\)\s*\{\s*padding-bottom/);
    expect(shell).not.toMatch(/\.settings-choice-panel:has\([^)]*\)[^{]*\{\s*padding-bottom/);
    expect(shell).not.toMatch(/settings-menu-body\s*\{\s*padding-bottom/);
    // 最后一行不再需要第二个半径：四边同内缩之后 28 − 16 = 12 就是它本来就有的值。
    expect(shell).not.toMatch(/radius-overlay\)\s*-\s*8\.7px/);
    expect(shell).not.toMatch(/settings-choice-option:last-child\s*\{[^}]*border-bottom/);
    // 同一族里另一个 28px 外壳也按同一个内缩走。
    expect(ruleBody(shell, '.search-preset-panel')).toMatch(/padding:\s*var\(--space-4\)/);

    // 面板**里面**那层滚动容器不许再添内缩。它从前带一圈 2px「给焦点环的余量」，
    // 于是行落在 18px 上：同心半径变成 28 − 18 = 10（又不在尺度上），行里第一行文字
    // 也比标题文字宽出 2px（探针量到的 gutterMismatch）。判据是这一对：容器内缩为零，
    // 而焦点环必须是**朝内画**的（`outline-offset: -2px`）——否则环会被面板边裁掉，
    // 那时这 2px 就重新变成必要，两条断言必须一起改。
    const body = ruleBody(shell, '.settings-menu-body');
    expect(body).toMatch(/padding:\s*0;/);
    expect(body).not.toMatch(/padding:\s*2px/);
    expect(body).not.toMatch(/margin:\s*-2px/);
    // 焦点环是**朝内画**的（`outline-offset: -2px`，写在选择器组里，所以直接扫源码
    // 而不是 ruleBody——ruleBody 只吃单个选择器）。
    const ringGroup = shell.slice(
      shell.indexOf('.settings-row-button:focus-visible'),
      shell.indexOf('.settings-row-button:focus-visible') + 400,
    );
    expect(ringGroup).toMatch(/\.settings-choice-option-main:focus-visible/);
    expect(ringGroup).toMatch(/outline-offset:\s*-2px/);
    // 末行下面那点内缩**哪儿都不许有**：不在面板上，也不在滚动容器上。
    expect(shell).not.toMatch(/\.settings-choice-panel:has\([^)]*\)[^{]*\{\s*padding-bottom/);
    expect(shell).not.toMatch(/settings-menu-body\s*\{\s*padding-bottom/);
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

  it('keeps app settings out of sync while the export list still carries them', () => {
    // 两张词表刻意分家：同步管「自动在设备之间流动什么」（应用设置不在其中——主题与
    // 后处理开关同步只会让两台设备互相覆盖，用户看到的是主题来回跳、DLSSNR 自己关
    // 掉），「导入导出范围」管「我主动带走什么」（必须含应用设置，否则换机器带不走
    // 设置）。判据落在两侧的词表与派生关系上，任何一侧被顺手改回去都会红。
    const syncScope = read('src/domain/syncScope.ts');
    const syncTable = syncScope.slice(
      syncScope.indexOf('export const SYNC_SCOPE_CATEGORIES'),
      syncScope.indexOf('] as const;'),
    );
    expect(syncTable).not.toMatch(/app_settings/);

    // 导出清单自己逐项列，不许再从同步词表派生：派生的话摘掉同步那一步就顺手把它
    // 一起摘掉了（「勾了应用设置却什么都没带」）。
    const dataExport = read('src/domain/dataExport.ts');
    expect(dataExport).not.toMatch(/SYNC_SCOPE_CATEGORIES/);
    const recordItems = dataExport.slice(
      dataExport.indexOf('export const DATA_EXPORT_RECORD_ITEMS'),
      dataExport.indexOf('export const DATA_EXPORT_CREDENTIAL_ITEMS'),
    );
    expect(recordItems).toMatch(/\{ id: 'app_settings', label: '应用设置' \}/);
    expect(recordItems.match(/id: '/g)).toHaveLength(6);

    // 原生侧同一件事：同步词表五项（无应用设置），文件词表六项（有）。
    const sync = read('src-tauri/src/commands/sync.rs');
    const rustSyncTable = sync.slice(
      sync.indexOf('pub(crate) const SYNC_SCOPE_CATEGORIES'),
      sync.indexOf('/// 默认勾选'),
    );
    expect(rustSyncTable).not.toMatch(/"app_settings"/);
    const transfer = read('src-tauri/src/data_transfer.rs');
    const rustRecordTable = transfer.slice(
      transfer.indexOf('pub(crate) const RECORD_CATEGORIES'),
      transfer.indexOf('pub(crate) const DATA_RECORDS_ITEM'),
    );
    expect(rustRecordTable).toMatch(/"app_settings"/);
    // 文件导入导出走的是文件词表，不许再借同步那份解析（借了应用设置就搬不动）。
    for (const call of [
      sync.slice(sync.indexOf('pub fn export_scoped_data')),
      sync.slice(sync.indexOf('pub fn import_scoped_data')),
    ]) {
      expect(call).toMatch(/parse_record_categories/);
    }

    // 同步范围菜单底部那行小字删掉了：说明凭据去哪儿是「导入导出范围」的事，
    // 写在这里既是重复，也让人以为上面那几行能勾到凭据。
    const syncSettings = read('src/components/SyncSettings.tsx');
    const scopeChecks = syncSettings.slice(
      syncSettings.indexOf('function SyncScopeChecks'),
      syncSettings.indexOf('export function SyncAccountForm'),
    );
    expect(scopeChecks).not.toMatch(/sync-scope-hint/);
    // 账户表单自己也用这个 class 放一句提示，CSS 因此留着——这条是「不要连 CSS 一起删」。
    expect(read('src/styles/shell.css')).toMatch(/\.sync-scope-hint\s*\{/);
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

  it('preserves the home scroll tail when transferring scrolling into the split list', () => {
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    // 分栏态下滚动搬进了左栏列表，它自己那 32px 底部留白要留着：不留的话可滚范围会比
    // 普通态短 32px，记住的位置一进来就被夹小（列表跳一下）。首页**整页滚动**那一档不再
    // 补尾（见 item 19：任何尾留白都会让「刚好放满」的页面多滚一格，实测 24px）。
    expect(shell).toMatch(/\.library-shell\.is-home\.has-detail \.library-shell-list\s*\{[^}]*padding-bottom:\s*var\(--space-8\)/);
    expect(shell).not.toMatch(/\.route-cache-panel\.is-flow \{[\s\S]{0,200}?padding-bottom/);
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
    for (const name of ['ArchiveDetailCover', 'ArchiveDetailFacts', 'ArchiveDetailTagSection', 'useDetailTagGroups', 'useArchiveCover', 'useSingleLineTitle']) {
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

  it('re-measures the chips when the tag slot changes size instead of trusting a stale zero', () => {
    // 卡片先在看不见的容器里挂载（`display: none`、或还没滚到眼前的
    // `content-visibility: auto` 卡片）时，胶囊量与槽宽都是 0。要是把这一份记下来，
    // 之后容器显示出来时通知里只有新槽宽 —— 「填满」分支会把 0 当成 5px，每条标签
    // 都算得下，于是全部挤进第一行、被 overflow 裁掉（缩略图卡片的换行就是这么没的）。
    // 所以：没排版就不许记，槽宽变了必须连胶囊一起重量。
    const tagRows = read('src/components/CardTagRows.tsx');
    expect(tagRows).toContain('if (widths.length === 0 || !widths.some((width) => width > 0)) return;');
    expect(tagRows).toContain('if (fill && containerWidth <= 0) return;');
    expect(tagRows).toMatch(/new ResizeObserver\(\(\) => \{[\s\S]*?measureTags\(\);[\s\S]*?\}\)/);
    expect(tagRows).not.toContain('previous.containerWidth !== containerWidth');
    // 这条路上量不到真尺寸，所以判据只能落在真排版引擎里；jsdom 那份用工装把
    // 「0 宽 → 真宽度」演出来，钉住它别再退回去。
    expect(read('tests/components/card-tag-rows.test.tsx'))
      .toContain('re-measures the chips when a card that mounted unseen is laid out at last');
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
    // SFW 的悬停是揭图——它的按下态不是换成 `:is(.is-pressed, :active)` 的逐字孪生，而是
    // 挂在按钮/卡片这些载体上，由下面 'blurs covers and thumbnails in SFW mode' 那条钉住）；
    // 骨架屏不是可点元素；分隔线纯装饰；`:disabled:hover` 是禁用态
    // 的中和规则；输入框在触屏上点一下就直接聚焦，聚焦环就是反馈；下拉的选项行外层是
    // `div[role=option]`，被标记的是行里那个真正的按钮，所以按下态写在 .select-option-main 上。
    const exempt = (selector: string) => /titlebar|^\.error-log-entry:hover$|metadata-tag|data-sfw|is-skeleton|panel-separator|:disabled:hover|^input:hover|^select:hover|^textarea:hover|^\.select-option:hover$/.test(selector);
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
      // 每一块 `@media (hover: none)` 都要读。原先只读第一块（ruleBody 取首个匹配），
      // 于是「按下态攒在哪一块里」变成了没有声明的隐含约定：谁在别处再开一块（哪怕只是
      // 想让新组件的悬停与按下挨着写），第一块之后的所有按下态就一起退出检查范围——
      // 而且报出来的错是「没有按下态」，指向的根本不是出错的规则。
      for (let at = stripped.indexOf('@media (hover: none)'); at >= 0; at = stripped.indexOf('@media (hover: none)', at + 1)) {
        const open = stripped.indexOf('{', at);
        let depth = 0;
        let end = open;
        for (let index = open; index < stripped.length; index += 1) {
          if (stripped[index] === '{') depth += 1;
          else if (stripped[index] === '}' && (depth -= 1) === 0) { end = index; break; }
        }
        for (const rule of stripped.slice(open + 1, end).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          for (const selector of splitSelectors(rule[1] ?? '')) pressed.set(selector, rule[2] ?? '');
        }
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
    // 用户报告（第 2 条，随后第 1 条）：首页那几排卡片两侧的空隙与别的组件对不上，而且
    // 一开详情就变。卡片区域的两侧空隙由轨道自己的 `padding` 给（四边 16px，与档案库的
    // 网格、宽行同一档），水平那圈不能收成 0——收掉之后整排卡片贴着框边，用户看到的正是
    // 「随机漫游和继续阅读左右直接没有空隙了」。
    // 那一排也不能居中：货架上只有一两张卡片时它们会被推到框子正中间、两侧留下巨大的空档
    // （「待看则是巨大无比，似乎是变成居中显示了」），而 `safe center` 在 Chromium 里溢出
    // 时并没有回落到起始对齐，第一张卡片直接被切在框外。默认的起始对齐不藏内容；「右边
    // 那条没用上的尾巴」是固定宽卡片排成一条轨道的固有结果，不是空隙。
    expect(ruleBody(shell, '.archive-rail')).toMatch(/padding:\s*var\(--space-4\);/);
    expect(ruleBody(shell, '.archive-rail-heading')).not.toMatch(/padding-inline/);
    expect(ruleBody(shell, '.archive-rail-grid')).not.toContain('justify-content');
    // 另一半原因（用户第 ④ 轮第 1 条：「首页待看的左侧空隙又回退到之前的比别的组件宽
    // 一点的状态了，依然打开详情页时会变成一致的」）：snapport 默认是滚动口的 padding box，
    // 所以卡片的 `scroll-snap-align: start` 第一个吸附位置落在 `scrollLeft = 6px`，正好把
    // 网格那 6px 内边距滚出视野。能滚的轨道被吸附到 6px、从不溢出的停在 0，同一条轨道于是
    // 有两种左空隙；左栏一变窄再重新吸附，两者又合并。`scroll-padding-inline` 必须与网格的
    // 6px 内边距相等，吸附位置才会回到 0、藏不掉内边距。
    expect(ruleBody(shell, '.archive-rail-grid')).toMatch(/padding:\s*6px 6px var\(--space-2\);/);
    expect(ruleBody(shell, '.archive-rail-grid')).toMatch(/scroll-padding-inline:\s*6px;/);
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

  // 用户报 4（2026-10-18）：「为超分和 dlssnr 图标绘制关闭 / 启用两种状态，不要单纯只是
  // 颜色变化。」阅读器底栏那两枚由 reader-screen.test.tsx 的
  // 'draws a different glyph for the on and off state of both enhancement switches' 从
  // 行为上钉住；设置页是同一对开关的第二处落点（超分在 SettingsWorkspace、DLSSNR 在
  // DlssnrSettingsGroup）。两态画在组件里以后，还得有人把当前状态真的传下去——传丢了
  // 组件会退回默认的「开」那一态，页面上就只剩颜色在动，正是用户报的那个样子。
  it('draws the enhancement switches in both states wherever they appear', () => {
    expect(read('src/components/SettingsWorkspace.tsx')).toMatch(/icon=\{<UpscaleIcon enabled=\{upscaleOn\} \/>\}/);
    expect(read('src/components/DlssnrSettingsGroup.tsx')).toMatch(/icon=\{<DlssnrIcon enabled=\{preferences\.dlssnrEnabled\} \/>\}/);
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

    // 顶栏三列：**两侧按内容定宽，标题吃掉剩下的全部**。这一条曾经是
    // `minmax(var(--icon-button-size), 1fr) minmax(0, auto) minmax(var(--icon-button-size), 1fr)`：
    // Grid 在 §12.6.3 先把剩余空间分给 `auto` 轨道，`fr` 轨道要等 §12.6.4 才轮到，于是
    // 标题把中间那条吃满、右侧轨道永远停在一颗图标的 44px 上，尾部那排按钮（手机上
    // 两颗＝92px）从自己那一格里向左溢出、压在标题上（user report:「阅读模式顶栏的
    // 标题会和右侧按钮重叠」；真机 390px 实测压住 44px，尾部四颗控件时 156px）。判据钉在
    // 「只有一条 fr 轨道」上：两侧再挂第二条 `minmax(…, 1fr)`，那个先后次序就会把
    // 重叠带回来。标题那条轨道必须带 0 下限，否则长标题会反过来把尾部顶出去。
    const columns = top.match(/grid-template-columns:\s*([^;]+);/)?.[1]?.trim() ?? '';
    expect(columns, '顶栏只能有一条 1fr 轨道，就是标题那条').toMatch(/minmax\(0,\s*1fr\)/);
    expect((columns.match(/\b1fr\b/g) ?? []).length, '两侧都不许再挂 1fr 轨道').toBe(1);

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

    // 底栏在的时候胶囊让位（2026-10-15 用户要求：底栏一出现，页码就隐藏）。原来那条
    // `.is-raised` 把胶囊抬到栏顶，只是把重叠换了个高度：两块小台面在同一段时间里抢同一
    // 块地方，看起来仍是「底栏上面还挂着一块东西」。现在整段「栏在（含退场那 260ms）」
    // 都并进 `data-visible='false'` 那一条，胶囊位置一次都不动——所以这里断言的是「那条
    // 抬高规则已经不在」（源码里安静条件包含栏在/退场那一条见下面 `indicatorScreen` 处）。
    expect(reader).not.toMatch(/\.reader-page-indicator\.is-raised/);

    // 手机这一档高度必须落在**两条栏和胶囊共同的祖先**上。自定义属性是继承的：写进
    // `.reader-toolbar` 就只有栏的后代看得见，而胶囊是 `.reader-screen` 的直接子节点、
    // 与 `.reader-chrome` 同级，它会一直读 `:root` 的 80px。手机档栏实高 160px，胶囊的
    // 「让位」位置却只退到 88px——它于是落在栏**里面**、盖住栏自己的页码；栏一退场又从
    // 栏顶滑到屏幕底，一路横穿整条栏（user report:「底栏消失时看起来会有两层底栏」）。
    // 真机读数：修前 `--reader-toolbar-height` 栏读到 160px、胶囊读到 80px，`shown` 那
    // 一帧胶囊与栏重叠 25px；修后两边都读 160px，每一帧重叠都是 0。
    expect(phone).toMatch(/\.reader-screen\s*\{[^}]*--reader-toolbar-height:\s*112px/);
    expect(phone).not.toMatch(/\.reader-toolbar\s*\{[^}]*--reader-toolbar-height/);

    // 栏退场的那 260ms 里它还在树上淡出：胶囊这时跟着一起淡出（`is-leaving` 就是这一档）。
    // 它不再有「落位」要推迟——胶囊在栏在/退场期间根本不移动，所以这里只断言淡出，并断言
    // 那条为「从栏顶滑到屏幕底、横穿整条栏」写的 `bottom` 过渡已经不在（它服务的动作没了）。
    const leavingPill = ruleBody(reader, '.reader-page-indicator.is-leaving');
    expect(leavingPill).toMatch(/opacity:\s*0/);
    expect(leavingPill).not.toMatch(/bottom\s+0s/);

    // 2026-10-18 用户报 14：「页码指示器的自动显隐响应有点慢，并且有时候出现缺少动画」。
    // 慢和缺动画是同一处机制的两种表现，所以判据钉在机制上而不是某一条时长：
    // ① 出现/消失各写各的时长，且消失更快。原来进出共用一条 280ms（全应用最慢的一档：
    //    栏 260ms、标准 220ms、快速 140ms）。无头 Edge + CDP 工装实测
    //    （debug_outputs/reader-batch/pill-probe）：修前淡出到 opacity 0 用 276ms、
    //    淡入到 1 用 271ms；修后消失 140ms、出现 220ms。
    // ② 不许再挂 `reader-indicator-in` 关键帧。它是 `backwards` 填充，从安静回到可见时
    //    从 0 重新起播而不是接着当前值走：实测在 opacity 0.209 那一帧被打断，画面先掉到
    //    0 再重新淡入——看起来就是「闪一下/没有动画」（同一处修后 0.209 → 0.21 接着走）。
    // ③ 减弱动效时两个方向都直接落位：只压一半（只压退出）会让「安静下去」瞬移、回来却
    //    还在淡入，同一颗胶囊两个方向两种读法。
    const pillBase = ruleBody(reader, '.reader-page-indicator');
    expect(pillBase, '出现走标准时长').toMatch(/transition:\s*opacity var\(--duration-standard\) var\(--ease-standard\)/);
    const pillQuiet = ruleBody(reader, ".reader-page-indicator[data-visible='false']");
    expect(pillQuiet, '消失比出现快一档').toMatch(/transition-duration:\s*var\(--duration-fast\)/);
    expect(pillQuiet, '消失用加速曲线').toMatch(/transition-timing-function:\s*var\(--ease-exit\)/);
    const readerRules = reader.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(readerRules, '关键帧那条已经删掉').not.toMatch(/@keyframes reader-indicator-in/);
    expect(readerRules, '可见态不再让关键帧兜「刚挂载」那一拍').not.toMatch(/animation:\s*reader-indicator-in/);
    expect(readerRules, '那枚通吃的时长令牌也一起退休').not.toMatch(/--duration-reader-indicator/);
    expect(tokens, '两档时长都在令牌里').toMatch(/--duration-fast:\s*140ms/);
    expect(reader, '减弱动效两个方向都直接落位').toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.reader-page-indicator,\s*\.reader-page-indicator\[data-visible='false'\] \{ transition: none; \}/,
    );

    // 胶囊的落点：桌面可以借右下角那半格，手机永远居中。竖着占满屏幕的页在桌面上会把
    // 胶囊推进右边缝里，可手指也在那里，而且手机上那半格本来就没宽到能放一条「2 / 100」；
    // 还有一档更隐蔽——刚换页时图片还没解码，量到的是盒子不是画出来的那一块，底缝算出
    // 来永远是 0，胶囊于是先跳右下角、等图 load 完再跳回来（用户报的就是翻页那一下的闪）。
    const centred = ruleBody(reader, ".reader-page-indicator[data-placement='bottom']");
    expect(centred, '居中那一档必须真的居中').toMatch(/left:\s*50%/);
    expect(centred).toMatch(/right:\s*auto/);
    expect(centred).toMatch(/transform:\s*translateX\(-50%\)/);
    const indicatorScreen = read('src/components/ReaderScreen.tsx');
    expect(indicatorScreen, '桌面右下角，触屏底部中心').toMatch(/const placement = coarsePointer \? 'bottom' : 'corner';/);
    expect(indicatorScreen, '初始首帧也采用设备默认位置').toMatch(/const indicatorPlacement = coarsePointer \? 'bottom' : 'corner';/);
    expect(indicatorScreen, '只有结论变了（或缩放还在缓动）才排第二趟测量').toMatch(/if \(!measure\(true\)\) settle = window\.setTimeout\(\(\) => \{ measure\(true\); \}, 240\);/);
    expect(indicatorScreen, '还没解码的页不能拿来量底缝').toMatch(/if \(image\.naturalWidth === 0\) continue;/);
    expect(indicatorScreen, '指针类型进了依赖，换设备也要重量一次').toMatch(/\}, \[coarsePointer, effectiveLayout,[^\]]*pageMeasurement[^\]]*bottomPresence\.mounted[^\]]*zoom\.scale\]\);/);
    expect(indicatorScreen, '退场窗口里胶囊要认领 is-leaving').toMatch(/bottomPresence\.leaving \? ' is-leaving' : ''/);
    // 2026-10-15 用户要求：底栏一出现，页码就隐藏。这一条钉的是**安静条件的组成**——
    // 少了 `mounted` 就退回「胶囊压在栏上」，少了 `leaving` 就会在栏淡出的 260ms 里
    // 提前冒出来（栏还在树上）。两处都在同一行，所以一条正则就够。
    expect(indicatorScreen, '栏在或退场时胶囊都安静（不是抬到栏顶）').toMatch(
      /const quiet = [^;]*bottomPresence\.mounted \|\| bottomPresence\.leaving;/,
    );
    expect(indicatorScreen, '胶囊不再用 is-raised 抬到栏顶').not.toMatch(/' is-raised'/);

    // 同一枚「是不是手指」的判据还管着两条栏怎么亮：触屏没有悬停，`hoverChrome` 永远是
    // `undefined`，两条栏只能跟着同一个 `visible` 同亮同灭——手指点在顶栏感应带上，底栏
    // 也一起冒出来（用户报的「点一侧触发两侧」）。所以手指点下去时按落点把那一侧钉住；
    // 「钉住」只给粗指针，桌面照旧点一下两条都出来（靠悬停选边）。钉住的那一侧比
    // `visible` 强势（`topChromeVisible = hoverChrome === 'top'`），三个收起入口都必须
    // 把意见清掉，否则那条栏再也摘不下来。
    expect(indicatorScreen, '手指才按落点钉一侧').toMatch(/pinTappedBand: coarsePointer,/);
    expect(indicatorScreen, '触屏两侧独立记忆，可依次唤出').toContain('const [tappedBands, setTappedBands]');
    expect(indicatorScreen, '自动收起清除两侧的唤出状态').toMatch(/setTappedBands\(\{ top: false, bottom: false \}\);\s*callbacksRef\.current\.onHide\(\)/);
    expect(indicatorScreen, 'Escape 收起也要清意见').toMatch(/setHover\(undefined\);[\s\S]{0,40}setState\(toggleReaderChrome\)/);

    // 底栏的「动」有三件事必须同时在场，少一件它就成了静止的一块：
    // ① 入场走自己的高度（8px 位移在 80dp 的栏上等于没动）；② 指针下按下要比悬停再实
    // 一档（只有悬停一层时，鼠标停在「下一页」上连点翻页看不出点到了）；③ 每翻一页栏顶
    // 铺开一道主题色短线。
    expect(reader, '入场要走栏自己的高度').toMatch(/@keyframes reader-chrome-bottom-in \{\s*from \{\s*opacity:\s*0;\s*transform:\s*translateY\(100%\);?\s*\}\s*\}/);
    expect(ruleBody(reader, '.reader-toolbar')).toMatch(/animation:\s*reader-chrome-bottom-in var\(--motion-slow\) backwards/);
    expect(ruleBody(reader, '.reader-toolbar button:hover')).toMatch(/background:\s*var\(--surface-container-high\)/);
    const pressLayer = ruleBody(reader, '.reader-toolbar button:active:not(:disabled)');
    expect(pressLayer, '按下要比悬停再实一档').toMatch(/background:\s*var\(--surface-container-highest\)/);
    expect(pressLayer).toMatch(/transform:\s*translateY\(1px\) scale\(/);
    // 触屏那一档的收缩与指针那一档是同一份（配色分成两档，手感不能分）。
    expect(ruleBody(reader, '.reader-toolbar button:is(.is-pressed, :active)')).toMatch(/transform:\s*translateY\(1px\) scale\(/);
    expect(reader, '翻页的回应要有一条动画').toMatch(/@keyframes reader-toolbar-turn \{\s*from \{/);
    const cue = ruleBody(reader, '.reader-toolbar-turn');
    expect(cue).toMatch(/animation:\s*reader-toolbar-turn var\(--motion-slow\)/);
    expect(cue).toMatch(/background:\s*var\(--primary\)/);
    // 动画没有 `forwards`，播完就落回基础值：基础值必须是灭的，否则一条主题色的实线会
    // 永久留在栏顶（工装实测过这个形态）。
    expect(cue, '光线的底色必须是灭的').toMatch(/opacity:\s*0/);
    // 重播靠**重新挂载**，不是改属性值：实测（debug_outputs/reader-motion）里把属性在
    // 两个值之间轮流，第二页一条动画都没跑——Blink 只在 `animation-name` 变或元素重挂
    // 时才重播。
    expect(read('src/components/ReaderScreen.tsx'), '光线要按翻页次数换一个新元素')
      .toMatch(/\{showTurnCue && <span key=\{turnCue\} className="reader-toolbar-turn"/);
    // 但「换元素」不能变成「栏一回来就闪一下」：底栏 chrome 收起 260ms 后整棵子树被摘掉，
    // 再出现时是全新的 DOM，一次性动画会跟着重播（用户报的「出现时顶部闪一条线」）。光线
    // 因此只认**这一次翻页**：`playedCue` 记住已播过的那一次，且由 effect 写（渲染期间写
    // ref 会被 StrictMode 的双渲染吃掉）。
    expect(read('src/components/ReaderScreen.tsx'), '光线只在翻页那一轮挂上去')
      .toMatch(/const showTurnCue = turnCue > 0 && playedCue\.current !== turnCue;/);
    expect(read('src/components/ReaderScreen.tsx'), '已播过的那一次由 effect 记下')
      .toMatch(/playedCue\.current = turnCue;/);
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
    expect(source).toMatch(/<ArchiveProgressBar page=\{readingProgressByArchiveId\?\.get\(archive\.archiveId\)\} pageCount=\{archive\.pageCount\} scope=\{progressScope\} cornerAware \/>\s*<\/button>/);
    expect(source).not.toMatch(/<span className="archive-row-copy">\s*<ArchiveProgressBar/);
    expect(shell).not.toMatch(/\.archive-row-copy > \.archive-card-progress\s*\{/);
    const bar = ruleBody(shell, '.archive-list.is-wide .archive-row > .archive-card-progress');
    // 底边贴到 0：卡片的高亮是它自己的 outline（outline-offset: -1px → 画在
    // y ∈ [H-1, H]），曾经为了把这 1px 描边让出来而抬高横条，代价是填充色到不了
    // 卡片底边、底下留一条 1px 的卡片底色（用户：「进度条底部与卡片底部没有完全
    // 贴合，会露出来一点」）。选中态的高亮现在由 `.archive-row…::after` 环层画在
    // 横条之上，这 1px 不必再让。
    expect(bar).toMatch(/inset:\s*auto 0 0/);
    expect(bar, '横条不许再抬高：填充要一路铺到卡片底边').not.toMatch(/inset:\s*auto 0 1px/);
    expect(bar).toMatch(/height:\s*4px/);
    // `.archive-row > span` 的 display: grid 特异性更高，横条必须显式声明 display。
    expect(bar).toMatch(/display:\s*block/);
    // 横条两端不再内缩：它依然横跨整张卡（压住两个圆角），只有填充的长度排除圆角。
    expect(bar).not.toMatch(/padding-inline/);
    expect(shell).not.toMatch(/\.archive-list\.is-wide \.archive-row > \.archive-card-progress\.is-complete\s*\{/);
    const card = read('src/components/ArchiveThumbnailCard.tsx');
    // 档案卡与设置行里的模型下载条是**同一个组件**：量法（`cardProgressWidth`）与
    // 类名都只有一份，两处不可能各画各的。
    expect(card).toMatch(/import \{ CardProgressBar \} from '\.\/CardProgressBar';/);
    expect(card).toMatch(/<CardProgressBar percent=\{percent\} label="阅读进度" cornerAware=\{cornerAware\} \/>/);
    const shared = read('src/components/CardProgressBar.tsx');
    expect(shared).toMatch(/export function cardProgressWidth\(percent: number, trackWidth: number, cornerAware: boolean\): string \{/);
    // 长度只在宽行这一支上排除圆角：预览/网格卡那条压在封面接缝上，没有圆角可让。
    expect(shared).toMatch(/cornerAware = false/);
    expect(shared).toMatch(/calc\(var\(--radius-card\) \+ \(100% - 2 \* var\(--radius-card\)\) \* \$\{percent \/ 100\}\)/);
    // 轨道宽度由组件自己量，且观察的就是轨道本身：容器一变就重新量一次，
    // 不会留下「槽宽更新了、内容还是旧值」的陈旧读数（用户报的标签换行失效是那个毛病）。
    expect(shared).toMatch(/const observer = new ResizeObserver\(measure\);/);
    // 覆盖层必须画在横条之上，几何与卡片 outline 完全重合（inset: 0 + 同一个半径）。
    // 曾经写成 inset: 1px + 半径 - 1px，那是「往里缩一格」而不是「同一条环」：在
    // DPR 1.5 上两条 1px 描边各自吸附设备像素，左/下并成一条、上/右中间空出一个设备
    // 像素的背景，于是选中态看起来是两条线（用户报「顶部和右侧会有两条」）。
    const overlay = ruleBody(shell, ".archive-list.is-wide .archive-row:is(.is-selected, [aria-checked='true'], [aria-pressed='true'])::after,\n.archive-thumb-card:is(.is-selected, [aria-checked='true'], [aria-pressed='true'], [aria-current='page'])::after");
    expect(overlay).toMatch(/inset:\s*0/);
    expect(overlay).toMatch(/z-index:\s*1/);
    expect(overlay).toMatch(/border:\s*1px solid var\(--primary\)/);
    expect(overlay).toMatch(/border-radius:\s*var\(--radius-card\)/);
    expect(overlay).toMatch(/pointer-events:\s*none/);
    // 宽度过渡要挂在真实存在的时长令牌上：`--motion-medium` 全仓从未定义，
    // 那条 transition 一直是死声明。
    expect(ruleBody(shell, '.archive-card-progress-fill')).toMatch(/transition:\s*width var\(--motion-standard\)/);
    // 缩略图卡那条仍压在封面与正文的接缝上，两种卡不共用同一个贴边位置。
    expect(ruleBody(shell, '.archive-card-progress')).toMatch(/inset:\s*-5px 0 auto/);
    // 曾经这里同时挡两件事：一条是 hover 浮动（`.archive-thumb-card:hover` 的
    // translateY(-2px)）把卡片提成合成层后、封面在设备像素取整上越出一线落在进度条
    // 下沿（用户报的「缩略图卡鼠标移上去时进度条底部闪出一丝封面」）。那条浮动已经
    // 删除（见「悬停只换颜色」那条用例），现在多压住的这 1px 只负责封面与正文的接缝
    // 取整，z-index 仍把横条抬到卡片内容之上；同 z-index 时按文档顺序，宽行档的选中
    // 覆盖层仍在它上面。
    const gridBar = ruleBody(shell, '.archive-card-progress');
    expect(gridBar).toMatch(/backdrop-filter:\s*blur\(6px\)/);
    expect(gridBar).toMatch(/height:\s*6px/);
    expect(gridBar).toMatch(/z-index:\s*1/);
  });

  it('keeps hover to colour, so a hovered element never paints over its neighbours', () => {
    const shell = read('src/styles/shell.css');
    // 悬停改几何 = 元素在指针下换了个盒子：要么长到自己盒子外面盖住邻居（导轨刻度
    // 从 9px 长到 15px、两块面板之间那条 2px 的缝被 scaleX(2) 撑成 4px、各压进面板
    // 1px），要么被提成合成层后取整越界（缩略图卡的 translateY(-2px) 让封面压到
    // 进度条上）。用户报「部分 hover 效果异常，会盖住下面的元素」，这三条就是。
    //
    // 白名单只留两类真的需要几何变化的地方：浮在页面之上、谁也不和它共用一个盒子的
    // 按钮，以及「揭示完整标签」那种在自己那一行里重新排版、不覆盖任何东西的展开。
    const allowed = [
      '.scroll-to-top:hover',
      '.metadata-tag.is-measured:hover .metadata-tag-reveal',
      // 填色动作按钮的 1px 抬起：仓库在「悬停要有按下孪生」那条用例里写明了这套规则
      // （tests/design-system-contract.test.ts:874「悬停规则里那点位移按下去不该复刻，
      // 布局一动就会跳」）。它是动作行里的独立控件，没有别的元素跟它共用一个盒子。
      '.primary-action:hover:not(:disabled)',
    ];
    // 只算真的把几何改掉的声明：`transform: none` 这类还原（底栏当前项中和掉缩进、
    // SFW 按下揭示时把模糊与放大一起撤掉）不是覆盖，反而正是「别动几何」那一侧。
    const moved = (body: string) =>
      [...body.matchAll(/(^|[\s;{])(transform|translate|scale|width|height|inset|top|right|bottom|left|margin|padding|position)\s*:\s*([^;]+)/g)].some(
        (match) => !/^(none|0|0px|auto|unset|initial)\b/.test((match[3] ?? '').trim()),
      );
    const hoverRules = (css: string): Array<{ selector: string; body: string }> => {
      const found: Array<{ selector: string; body: string }> = [];
      const blocks = /@media \(hover: hover\)\s*\{/g;
      let block = blocks.exec(css);
      while (block) {
        let depth = 0;
        let end = block.index + block[0].length - 1;
        for (let at = end; at < css.length; at += 1) {
          if (css[at] === '{') depth += 1;
          if (css[at] === '}') {
            depth -= 1;
            if (depth === 0) {
              end = at;
              break;
            }
          }
        }
        const body = css.slice(block.index + block[0].length, end);
        const rules = /([^{}]+)\{([^{}]*)\}/g;
        let rule = rules.exec(body);
        while (rule) {
          found.push({ selector: (rule[1] ?? '').replace(/\s+/g, ' ').trim(), body: rule[2] ?? '' });
          rule = rules.exec(body);
        }
        blocks.lastIndex = end;
        block = blocks.exec(css);
      }
      return found;
    };
    const geometric = moved;
    // 注释先剥掉：扫描器按花括号取规则体，块里的注释会被算进「选择器」里，于是
    // 白名单比对失败、报出来的选择器也带着一整段说明文字。
    const rules = hoverRules(shell.replace(/\/\*[\s\S]*?\*\//g, ''));
    expect(rules.length, '悬停块扫描器没读到东西').toBeGreaterThan(15);
    const offenders = rules.filter((rule) => geometric(rule.body) && !allowed.includes(rule.selector)).map((rule) => rule.selector);
    expect(offenders, '悬停只能换颜色；真需要几何变化的要在白名单里，并写清楚为什么').toEqual([]);
  });

  it('draws the model download bar on the option’s own edge instead of growing the row', () => {
    const base = read('src/styles/base.css');
    const shell = read('src/styles/shell.css');
    // 进度槽是这一项的定位后代、铺满这一行：它不参与行布局，所以「一下载那一栏就变高」
    // 不会发生（用户报的正是这个）。设置项那一层不是它的定位上下文——进度必须画在点
    // 「下载」的那一层里，否则它在菜单遮罩后面。
    const option = ruleBody(shell, '.settings-choice-option');
    expect(option).toMatch(/position:\s*relative/);
    // 行自己把横条两端削成它的圆角——宽行列表卡就是这么做的（`.archive-row` 同一对
    // `overflow: hidden` + `border-radius: var(--radius-card)`）。缺这一句时横条两端
    // 是自由端，圆头直接杵在行的圆角外面，看上去是一条「游离在那一行之外」的独立横条。
    expect(option).toMatch(/overflow:\s*hidden/);
    expect(option).toMatch(/border-radius:\s*var\(--radius-card\)/);
    const slot = ruleBody(base, '.model-download-slot');
    expect(slot).toMatch(/position:\s*absolute/);
    expect(slot).toMatch(/inset:\s*0/);
    expect(slot).toMatch(/opacity:\s*0/);
    // 收起/展开只剩一次 opacity：`fr` 轨道那套（grid-template-rows、子元素的
    // min-height/overflow、槽上的 padding-block）正是把行撑高的东西，不能留着。
    expect(slot).not.toMatch(/grid-template-rows/);
    expect(slot).not.toMatch(/padding/);
    expect(ruleBody(base, '.model-download-slot.is-open')).toMatch(/opacity:\s*1/);
    // 横条本身是同一条 `.archive-card-progress`：贴这一行的底边（留 1px 让行的描边
    // 露出来）、高度按行收成 4px、并且**不留卡片那条投影**（它垫的是封面下沿，行里
    // 没有封面）。原来这里另有一套 `.model-download-track/-fill`：轨道自己带
    // `--radius-pill` 圆头、填充写百分比，于是它既不跟行的圆角走、也不共用档案卡的
    // 量法——用户报的「没有完整复用」。
    const bar = ruleBody(base, '.model-download-slot > .archive-card-progress');
    expect(bar).toMatch(/inset:\s*auto 0 1px/);
    expect(bar).toMatch(/height:\s*4px/);
    expect(bar).toMatch(/box-shadow:\s*none/);
    expect(base).not.toMatch(/\.model-download-(track|fill|status)\s*\{/);
    // 不定量条挂在同一条填充上。
    expect(ruleBody(base, '.archive-card-progress.is-indeterminate .archive-card-progress-fill')).toMatch(/width:\s*40%/);
    const control = read('src/components/ModelDownloadControls.tsx');
    expect(control).toContain('<CardProgressBar');
    expect(control).toContain('indeterminate={percent === undefined}');
    expect(control).toContain('cornerAware');
    // 行里不再有「换行下来的第二行」：那条 `flex: 1 0 100%` 只会在流里再占一行的高度。
    expect(shell).not.toMatch(/\.settings-choice-option > \.model-download-slot\s*\{/);
  });

  it('marks a setting whose models have an update without shaping the mark like a button', () => {
    const shell = read('src/styles/shell.css');
    const mark = ruleBody(shell, '.settings-row-mark');
    expect(mark).toMatch(/background:\s*var\(--primary-container\)/);
    expect(mark).toMatch(/color:\s*var\(--on-primary-container\)/);
    expect(mark).toMatch(/border-radius:\s*var\(--radius-pill\)/);
    // 小签挂在名称上而不是控件槽里，而且它是一件**事**：`span`，不是能点的东西
    // （能点的是菜单里那一行的下载/更新按钮）。
    const choice = read('src/components/SettingsValueControls.tsx');
    expect(choice).toMatch(/<span className="settings-row-mark">\{mark\}<\/span>/);
    expect(choice).toMatch(/mark\?: ReactNode \| undefined;/);
    const settings = read('src/components/SettingsWorkspace.tsx');
    expect(settings).toMatch(/mark=\{outdatedUpscaleIds\.size > 0 \? '有更新' : undefined\}/);
    // 第二个挂点（DLSSNR 组件那一行）走的是 `SettingsRow`：同一枚 pill、同一个画法，
    // 名字后面跟着它，可访问名仍然只算名字（标记是装饰，不参与命名）。
    const row = read('src/components/SettingsRow.tsx');
    expect(row).toMatch(/mark\?: ReactNode \| undefined;/);
    expect(row, '标记画的还是那一枚 pill：行上的挂点要和另一处一模一样的画法，不许另起一套').toMatch(/<span className="settings-row-mark">\{mark\}<\/span>/);
    expect(row).toMatch(/ariaLabel \?\? \(typeof label === 'string' \? label : undefined\)/);
  });

  it('keeps the reader chrome on a layer of its own instead of moving the page it covers', () => {
    const reader = read('src/styles/reader.css');
    // 「处理中」胶囊只待在一个地方。从前它在顶栏出现时被一条 `:has()` 往下挪 68px 去
    // 躲那条栏——于是在加载中碰一下顶栏，屏幕上的加载指示就跳一下（用户报的正是这个），
    // 而且那条选择器等于拿「栏在不在」当布局输入。
    expect(reader).not.toMatch(/\.reader-chrome:has\(\.reader-chrome-top\)\s+\.reader-deriving/);
    const capsule = ruleBody(reader, '.reader-deriving');
    expect(capsule).toMatch(/z-index:\s*1/);
    // 两条栏在这一层里最上面：栏上来就把胶囊盖住（栏是不透明的），胶囊不必动。
    for (const bar of ['.reader-chrome-top', '.reader-toolbar']) {
      expect(ruleBody(reader, bar), `${bar} 要盖在胶囊与画面之上`).toMatch(/z-index:\s*2/);
    }
    // 而「压住画面」这件事只由那一层容器负责：它自己有 z-index，所以子元素各自往哪排
    // 都还在画面之上，不必每个装饰都去抬一层。
    expect(ruleBody(reader, '.reader-chrome')).toMatch(/z-index:\s*calc\(var\(--z-reader-overview\)\s*\+\s*1\)/);
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

  it('lets the flow routes grow their cached panel, without a tail gap in the scroll extent', () => {
    const shell = read('src/styles/shell.css');
    const routes = read('src/app/routes.tsx');
    // route-cache-panel 的 height:100% 钳制会把溢出尾困在面板外：首页与书架
    // 面板必须随内容生长（is-flow），≤900 则所有路由（含档案库页面滚动）放开。
    expect(routes).toContain("flow={!['/library', '/downloads', '/history', '/watchlist', '/to-read'].includes(key)}");
    expect(read('src/app/RetainedPage.tsx')).toContain("flow ? ' is-flow'");
    expect(shell).toMatch(/\.route-cache-panel\.is-flow \{[\s\S]{0,400}?height:\s*auto/);
    expect(shell).toMatch(/@media \(max-width: 900px\)/);

    // 「美观尾留白」不能住在可滚范围里的任何地方：住在滚动容器上是内容之外那一格，
    // 住在面板上是面板高度多一格，两者都会让「内容只差一格就放满」的页面滚出空带
    // （user report「部分页面能完全显示依然可以上下滚动一点点」）。实测两档都是
    // 24px、去掉后是 0，见 debug_outputs/flow-tail/probe.mjs 与轮次文档。
    expect(shell, '滚动容器不留尾部留白').toMatch(/\.workspace \{[\s\S]{0,900}?padding: var\(--space-8\) clamp\(var\(--space-5\), 4vw, var\(--space-12\)\) 0;/);
    expect(shell, '窄屏同样不留').toMatch(/padding: var\(--space-8\) var\(--space-4\) 0;/);
    const flowPanel = ruleBody(shell, '.route-cache-panel.is-flow');
    expect(flowPanel).toMatch(/height:\s*auto/);
    expect(flowPanel, '长高的面板自己不补尾').not.toMatch(/padding/);
    expect(flowPanel, '也不靠 min-height 伪装成留白').not.toMatch(/min-height/);
    // 首页自己那条也不补尾（否则「刚好放满」的首页照样多滚一格）。
    expect(shell).toMatch(/\.workspace-home\) \{[\s\S]{0,200}?padding: 0;/);
    // 被**遮挡**的那一格是例外：悬浮底栏浮在内容之上，滚到底必须能把最后一屏从栏底下
    // 拉出来，所以这一格照旧留在滚动容器上（`is-floating-nav` 那一对选择器）。
    expect(shell).toMatch(/\.app-shell\.is-floating-nav \.workspace,\s*\n\s*\.app-shell\.is-floating-nav \.workspace\.is-library-workspace \{\s*padding-bottom: calc\(var\(--safe-bottom\) \+ 80px\);\s*\}/);
  });

  it('reads the comment author above the body, with the timestamp in its own column', () => {
    const shell = read('src/styles/shell.css');
    // user report（图4）：用户 ID 应该比正文大一点；时间下方的空白区域太大。
    // 两处根因都在字号与行高上：正文 `<p>` 一直没写字号，吃的是浏览器默认 16px，
    // 而作者名继承 meta 行的 --text-xs(12px) ⇒ 层级刚好是反的（实测 12/16）；
    // 时间戳那行用 `min-height: 32px` + 居中，上传者评论没有投票按钮也照样占满
    // 32px，把时间下方白留一片（实测 21px）。修法：字号都落到令牌上（15 / 14），
    // 投票行贴着内容底、卡片与输入框的底部内边距各收半步。读数见
    // debug_outputs/eh-comments/probe.mjs 与轮次文档（空带 21 → 9px）。
    expect(ruleBody(shell, '.eh-comment-meta strong'), '作者名比正文大一档').toMatch(/font-size: var\(--text-base\)/);
    expect(ruleBody(shell, '.eh-comments-list p'), '正文自己写清字号').toMatch(/font-size: var\(--text-md\)/);
    const votes = ruleBody(shell, '.eh-comment-votes');
    // 2026-10-16：评论 meta 改成两列网格（作者/正文一列、时间一列），投票行落到正文
    // 下面自成一行，于是这条判据从「贴内容底」改成「自成一行、与内容同排」——
    // 它仍然守着同一件事：时间下面不再留一条空带。
    expect(ruleBody(shell, '.eh-comment-meta'), '作者/正文与时间分成两列').toMatch(/grid-template-columns: minmax\(0, 1fr\) minmax\(0, auto\)/);
    expect(votes, '投票行自成一行、与内容同排').toMatch(/align-items: center/);
    expect(votes, '不再靠 min-height 撑出空带').not.toMatch(/min-height/);
    expect(ruleBody(shell, '.eh-comments-list li'), '卡片底部只留半步').toMatch(/padding: var\(--space-3\) var\(--space-3\) var\(--space-2\)/);
    expect(ruleBody(shell, '.eh-comment-composer'), '输入框上方只留半步').toMatch(/padding-top: var\(--space-2\)/);
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
    // 密度是固定节距（18px），不再把 N 个刻度摊满 70% 高——那种写法让
    // `grid-auto-rows: 1fr` 把有限的高度再等分给每个刻度，刻度一多每格只剩 5px，
    // 看起来就是一把密齿梯子（用户「太密了根本用不了」）。行高直接等于节距。
    expect(shell).toMatch(/\.archive-quick-rail-track\s*\{[^}]*--rail-pitch:\s*18px[^}]*grid-auto-rows:\s*var\(--rail-pitch\)/);
    expect(shell).not.toMatch(/\.archive-quick-rail-track\s*\{[^}]*height:\s*min\(/);
    expect(source).toMatch(/className="archive-quick-rail-track" style=\{\{ '--rail-ticks': railSegments\.length \}/);
    expect(shell).toMatch(/\.archive-quick-rail-tick\.is-active\s*\{\s*width:\s*16px;\s*background:\s*var\(--primary\)/);
    // 刻度只有 9×3px，直接拿它当悬停/点击靶太细：一层看不见的伪元素把靶撑到 25×17px
    // （相邻刻度隔 18px，竖向各让 7px、横向各让 8px ⇒ 正好铺满一格，不留缝）。
    expect(shell).toMatch(/\.archive-quick-rail-tick\s*\{[^}]*position:\s*relative/);
    expect(shell).toMatch(/\.archive-quick-rail-tick::before\s*\{\s*content:\s*'';\s*position:\s*absolute;\s*inset:\s*-7px -8px/);
    // 悬停/聚焦时在刻度左边浮一枚标签，写着这个刻度会把你送到哪一天哪个时间——原生
    // `title` 要等一秒、触摸设备上根本没有。
    expect(shell).toMatch(/\.archive-quick-rail-label\s*\{[^}]*position:\s*absolute[^}]*right:\s*calc\(100% \+ 8px\)[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
    expect(shell).toMatch(/\.archive-quick-rail-tick:hover > \.archive-quick-rail-label\s*\{\s*opacity:\s*1/);
    expect(source).toMatch(/className="archive-quick-rail-label"/);
    // 细分规则：越靠近当前越细；刻度总数既要认常量天花板，也要认左栏量出来的高度
    // ——短窗口里 20 个刻度又会挤回密齿，所以上限按「70% 高度 ÷ 18px 节距」算。
    expect(source).toMatch(/RAIL_MAX_TICKS = 20/);
    expect(source).toMatch(/function railTickCapFor\(height: number\): number/);
    expect(source).toMatch(/Math\.min\(RAIL_MAX_TICKS, Math\.floor\(\(height \* RAIL_TICK_SPAN\) \/ RAIL_TICK_PITCH\)\)/);
    expect(source).toMatch(/const railTickCap = railTickCapFor\(railPanelHeight\)/);
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

  it('animates the multi-select bar in and out with one motion', () => {
    // 用户报过「多选操作栏的出现和消失速度不一致，消失会很慢很卡」：收起曾经骑
    // --motion-exit（260ms、缓入），工装 debug_outputs/selection-bar 量出来它前 60ms
    // 只走 2.8%，而出现走 66% —— 两个方向读起来就是两回事。
    const shell = read('src/styles/shell.css');
    const tokens = read('src/styles/tokens.css');
    const closed = ruleBody(shell, '.archive-selection-slot');
    const open = ruleBody(shell, '.archive-selection-slot.is-open');
    const barClosed = ruleBody(shell, '.archive-selection-slot > .archive-selection-bar');
    const barOpen = ruleBody(shell, '.archive-selection-slot.is-open > .archive-selection-bar');
    expect(closed, '收起也要走出场那条令牌，否则两个方向的速度不一样').toMatch(/grid-template-rows var\(--motion-standard\)/);
    expect(closed, '收起不许骑出场曲线：它前 60ms 只走 2.8%，读起来就是「慢」').not.toMatch(/--motion-exit|--ease-exit/);
    expect(open, '出现那条要一直留在入场令牌上').toMatch(/grid-template-rows var\(--motion-standard\)/);
    expect(closed, '隐藏要等动画走完，延迟用的是同一个长度').toMatch(/visibility 0s linear var\(--duration-standard\)/);
    expect(barClosed, '收起归零那一份也要骑同一条令牌').toMatch(/margin-bottom var\(--motion-standard\), padding var\(--motion-standard\)/);
    expect(barOpen, '两态共用同一条过渡，展开那一份不该再写一遍').not.toMatch(/transition:/);
    // 长度本身只有一个来源。
    expect(tokens).toMatch(/--duration-standard:\s*220ms;/);
    expect(tokens).toMatch(/--motion-standard:\s*var\(--duration-standard\) var\(--ease-standard\);/);
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
    // 触屏没有悬停，按住就是桌面上的悬停：钩子是 pressFeedback 打的 `.is-pressed`，
    // 而且必须挂在按钮/卡片这些**载体**上——pressFeedback 只标记 `closest(PRESSABLE)`
    // 命中的元素，封面自己接不住（触屏的 `:active` 也不可用，实测按住期间一直是 false，
    // 所以这里量的两档读数里 `:active` 一次都没命中）。
    const touchReveal = shell.match(/@media \(hover: none\) \{\n  :root\[data-sfw='true'\] \.archive-row:is\(\.is-pressed, :active\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(touchReveal, '触屏要能按住看封面').toMatch(/\.archive-row:is\(\.is-pressed, :active\) \.archive-row-thumb img/);
    expect(touchReveal).toMatch(/\.archive-thumb-card:is\(\.is-pressed, :active\) \.archive-thumb-card-media img/);
    expect(touchReveal).toMatch(/\.archive-detail-cover-trigger:is\(\.is-pressed, :active\) img/);
    expect(touchReveal).toMatch(/\.archive-page-thumbnail:is\(\.is-pressed, :active\) img/);
    // 阅读器概览里那面封面与页缩略图是同一件事；封面外那层框自己不是可点元素，
    // 靠 `data-press-surface` 认领这次按压，否则触屏上它永远糊着。
    const reader = read('src/styles/reader.css');
    expect(reader).toMatch(/\.reader-overview-cover-frame:is\(\.is-pressed, :active\) > \.reader-overview-cover/);
    expect(reader).toMatch(/\.reader-overview-thumbnails button:is\(\.is-pressed, :active\) img/);
    expect(read('src/components/ArchiveOverviewPanel.tsx')).toMatch(/className="reader-overview-cover-frame" data-press-surface/);
    expect(read('src/lib/pressFeedback.ts')).toMatch(/'\[data-press-surface\]'/);
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

  it('shrinks a pressed card on its own box, and the settings row on its contents', () => {
    const base = read('src/styles/base.css');
    const polish = read('src/styles/visual-enhancements.css');
    const workspace = read('src/components/LibraryWorkspace.tsx');
    // 用户 2026-10-17 报「点击设置项、档案卡片的缩小效果消失了」，2026-10-18 又报「缩略图卡片
    // 点击还是没有缩小效果 / 列表卡片只有封面缩小 / 缩小不要使其他卡片位移」。卡片这一档改成
    // 缩**盒子**：虚拟列表的每行绝对定位、高度来自 `estimateSize`，从不回量卡片自己的矩形，
    // 所以纯 transform 不会让别的卡片动；设置行仍然缩内容——它连着悬停底色，缩盒子会让用户
    // 看到「点击时 hover 效果也变小」。
    expect(base).toMatch(/\.settings-row-button:active \{\s*transform: none;/);
    expect(polish).toMatch(/\.archive-thumb-card:is\(\.is-pressed, :active\) \{\s*transform: scale\(0\.97\);/);
    // 列表行整行就是卡片，0.97 在满宽行上要缩掉三十多像素（用户 2026-10-18 报「列表档案卡片的
    // 缩小程度太大了」），所以那一档单独收窄到 0.99。
    expect(polish).toMatch(/\.archive-row:is\(\.is-pressed, :active\) \{\s*transform: scale\(0\.99\);/);
    // 行高由虚拟列表给死，且没有把卡片重新量一遍的钩子——这是「别的卡片不会跟着动」的依据。
    expect(workspace).toMatch(/className="archive-thumb-grid-row"[\s\S]{0,320}?height: virtualRow\.size/);
    expect(workspace).not.toMatch(/measureElement/);
    // 封面那层只剩悬停的放大：按下的缩放已经移到盒子上。
    expect(polish).not.toMatch(/\.archive-thumb-card:is\(\.is-pressed, :active\) \.archive-thumb-card-media/);
    expect(polish).toMatch(/\.archive-thumb-card:hover \.archive-thumb-card-media,\s*\.archive-row:hover \.archive-row-thumb \{\s*transform: scale\(1\.02\);/);
    // 设置行缩的是行里那几块内容；原点错开，间距看起来才是整体缩小。
    expect(base).toMatch(/\.settings-row-button:is\(\.is-pressed, :active\) > \.settings-row-copy \{\s*transform-origin: left center;/);
    expect(base).toMatch(/\.settings-row-button:is\(\.is-pressed, :active\) > \.settings-row-icon,[\s\S]{0,240}?transform-origin: right center;/);
    // 用户 2026-10-18 又报「按钮的点击缩小效果缺少动画」：`button:active` 那条只给几何、不给
    // 过渡，于是凡是没有自己声明 transition 的按钮/链接、以及设置行里那三块内容，按下去那一拍
    // 都是瞬变。父行的 transition 管不到子元素的 transform，所以这一条必须落在子元素上。
    expect(base, '按钮/链接的按压要有过渡').toMatch(/button,\s*a \{\s*transition: transform var\(--motion-crisp\);/);
    expect(base, '设置行内容的按压要有过渡').toMatch(/\.settings-row-button:is\(\.is-pressed, :active\) > \.settings-row-icon,[\s\S]{0,320}?transition: transform var\(--motion-crisp\);/);
  });

  it('keeps the DLSSNR labels short and puts the supported series on the same line', () => {
    // 用户 2026-10-17 报「FP16 版的文字溢出了，去掉 30 系后面的文字」⇒ 标签收短；2026-10-18 先要
    // 「把各 DLSSNR 的适配显卡系列补回来」，同日又报「把图中这些版本名字改回一行」⇒ 系列回到标签
    // 后面**同一行**（行内 nowrap，系列跟在名字后、不再独占一行）。这一条守的是**随包那份**兜底
    // 清单；线上那份在模型仓库（Kelcoin/Yomika-Models），改它要单独提交。
    const manifest = JSON.parse(read('src-tauri/resources/dlssnr/dlssnr-manifest.json')) as {
      variants: Array<{ id: string; label: string; note?: string }>;
    };
    expect(manifest.variants.length).toBeGreaterThan(0);
    for (const variant of manifest.variants) {
      expect(`${variant.id}:${variant.label}`).toMatch(/^[a-z0-9-]+:.{2,12}$/);
      // 系列仍写在 note 里（悬停可见），选项行把它渲染在名字后面。
      expect(variant.note ?? '').toMatch(/RTX\s*\d{2}/);
    }
    const group = read('src/components/DlssnrSettingsGroup.tsx');
    expect(group).toMatch(/formatSeries/);
    expect(group).toMatch(/className="settings-choice-option-series"/);
    const shell = read('src/styles/shell.css');
    // 一行：行内不换行；系列跟在名字后面（不是 `flex: 0 0 100%` 那种独占一行）。
    expect(shell, '名字与系列必须同排一行').toMatch(/\.settings-choice-option-main \{[\s\S]{0,900}?flex-wrap: nowrap;/);
    expect(shell, '系列跟在名字后面').toMatch(/\.settings-choice-option-series \{[\s\S]{0,200}?flex: none;/);
    expect(shell, '系列不许再独占一行').not.toMatch(/\.settings-choice-option-series \{[\s\S]{0,200}?flex: 0 0 100%/);
    expect(shell).toMatch(/\.settings-choice-option-series \{[\s\S]{0,200}?font-size: var\(--text-xs\)/);
  });

  it('paints the progress bar with the theme, never a fixed gradient', () => {
    // 用户 2026-10-18 报「部分元素比如进度条似乎没有接入主题」，同一条报里的「锯齿」也是它：
    // 填充曾经被覆写成写死的 `--primary-gradient`（tokens.css 里那条两段竖直红），换配色不跟
    // 着变，而且在 4–6px 高的条上就是两条硬边色带。现在填充走主题的 `--primary`，渐变由调色
    // 板自己从 accent 派生。
    const polish = read('src/styles/visual-enhancements.css');
    const shell = read('src/styles/shell.css');
    const presets = read('src/lib/cssThemePresets.ts');
    expect(polish).not.toMatch(/\.archive-card-progress-fill \{\s*background: var\(--primary-gradient\)/);
    expect(shell).toMatch(/\.archive-card-progress-fill \{[^}]*background: var\(--primary\)/);
    expect(presets).toMatch(/--primary-gradient: linear-gradient\(180deg, \$\{p\.accent\} 0%, \$\{p\.accentHover\} 100%\);/);
  });

  it('answers overscroll by moving the list, and pins the refresh disc over it', () => {
    const shell = read('src/styles/shell.css');
    const workspace = read('src/components/LibraryWorkspace.tsx');
    // The notice that faded in over the first row and could outstay the gesture
    // is gone, along with the wheel-delta heuristic that fired it.
    expect(shell).not.toMatch(/library-refresh-hint/);
    expect(workspace).not.toMatch(/library-refresh-hint|pullTicks/);
    // The gesture is answered by the content: one signed offset slides the list
    // past either end, and the release springs it back. 2026-10-17 改口：三种状态
    // 各说一句话——跟手（wheel / touch）不许有过渡（每格滚轮都拖一条 100ms 的尾巴，
    // 用户报的就是「非常卡」），回弹（settle）必须有过渡（原来触摸那档一直挂着
    // `transition: none`，写回 0 就是瞬移），三者都要把这一层提成合成层（几千像素高
    // 的列表，不给提示就每帧重绘它）。
    expect(workspace).toMatch(/className="archive-list-pull"/);
    expect(workspace).toMatch(/data-overscroll=\{overscrollSettle \? 'settle' : \(overscrollGesture \?\? undefined\)\}/);
    expect(shell).toMatch(/\.archive-list-pull\[data-overscroll='wheel'\],\s*\.archive-list-pull\[data-overscroll='touch'\] \{ transition: none; \}/);
    expect(shell).toMatch(/\.archive-list-pull\[data-overscroll='settle'\] \{ transition: transform 240ms cubic-bezier\(\.2, \.8, \.2, 1\); \}/);
    expect(shell).toMatch(/\.archive-list-pull\[data-overscroll='wheel'\],\s*\.archive-list-pull\[data-overscroll='touch'\],\s*\.archive-list-pull\[data-overscroll='settle'\] \{ will-change: transform; \}/);
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
    // 一个 touchmove 就 preventDefault 等于把整段手势从浏览器手里抢走：手机上起手
    // 那几像素常常先往下抖一下，这一抖冒领之后页面再也滚不动，只剩过滚刷新能用。
    // 认定距离之前一个字都不说，手指转向滚动那一侧就把这次手势整个还回去。
    expect(workspace).toMatch(/const PULL_CLAIM_PX = EDGE_CLAIM_PX;/);
    expect(read('src/lib/motion.ts')).toMatch(/EDGE_CLAIM_PX = 4;/);
    expect(workspace).toMatch(/if \(travel < PULL_CLAIM_PX\) return;/);
    expect(workspace).toMatch(/overscrollClaimed\.current = true;[\s\S]{0,1200}event\.preventDefault\(\);/);
    // 认定距离那 12px 是浏览器的：真机上这段里页面已经滚了一点点。认领时要把这一段放回去，
    // 并且认领之后那一层要是还在动就让位——两套滚动叠着走就是用户 2026-10-15 报的
    // 「顶部搜索框滚出视口 + 卡片与顶栏之间一大段空隙」（档案库那一处）。
    expect(workspace, '认领时把浏览器先滚掉的那一点放回去').toMatch(/scroller\.scrollTop = startScrollTop;/);
    expect(workspace, '认领后那一层还在动就让位').toMatch(
      /scroller\.scrollTop !== overscrollClaimedScrollTop\.current\) \{[\s\S]{0,120}cancelOverscroll\(\);/,
    );
    // 位置直接写 DOM：每一像素走一次 setState 会让整棵虚拟化列表每帧重渲染一遍，
    // 真机上就是「过滚刷新非常非常卡」。state 只在静止/位移边界变化，回零必须同步隐藏图标。
    expect(workspace).toMatch(/pull\.style\.transform = `translateY\(\$\{offset\}px\)`;/);
    expect(workspace).toContain('if (Math.sign(previous) !== Math.sign(offset)) setOverscroll(Math.sign(offset))');
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

  it('keeps every light colour scheme off pure white', () => {
    // 用户报过「几个预设配色的浅色模式基本就是纯白」：elevated 那一档直接取了 #fbfdfa
    // 这类近乎纯白的值，铺满对话框与卡片之后整屏发白。这条钉三件事：底色够深、
    // 三档之间分得开（画布 < panel < elevated）、最上面那一档仍然不是纯白。
    const source = read('src/lib/cssThemePresets.ts');
    const schemes = source.slice(
      source.indexOf('export const COLOR_SCHEMES'),
      source.indexOf('export const CSS_THEME_PRESETS'),
    );
    const palettes = [...schemes.matchAll(
      /\{ canvas: '(#[0-9a-f]{6})', panel: '(#[0-9a-f]{6})', elevated: '(#[0-9a-f]{6})', muted: '(#[0-9a-f]{6})'/gi,
    )].map(([, canvas, panel, elevated, muted]) => ({
      canvas: canvas ?? '', panel: panel ?? '', elevated: elevated ?? '', muted: muted ?? '',
    }));
    const luminanceOf = (hex: string) => {
      const [red, green, blue] = rgb(hex);
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };
    // 每个配色给浅深两份调色板，浅色在前：只看每对的头一份。
    expect(palettes.length % 2, '每个配色都该给出浅深两份调色板').toBe(0);
    const lights = palettes
      .filter((_, index) => index % 2 === 0)
      .map((palette) => ({
        canvas: luminanceOf(palette.canvas),
        panel: luminanceOf(palette.panel),
        elevated: luminanceOf(palette.elevated),
        muted: luminanceOf(palette.muted),
      }));
    expect(lights.length, '一份浅色配色都没读到').toBeGreaterThanOrEqual(4);
    for (const light of lights) {
      expect(light.canvas, '浅色模式的画布已经很白了').toBeLessThanOrEqual(0.82);
      expect(light.panel - light.canvas, 'panel 与画布分不开').toBeGreaterThanOrEqual(0.05);
      expect(light.elevated - light.panel, 'elevated 与 panel 分不开').toBeGreaterThanOrEqual(0.04);
      expect(light.elevated, '最上面那一档又变成纯白了').toBeLessThanOrEqual(0.95);
      expect(light.muted, 'muted 该比画布深').toBeLessThan(light.canvas);
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
    // 横向导轨的手势归**浏览器**管：导轨是 `overflow-x: auto`，另一轴的 computed 值随
    // 之变成 `auto`，所以 touch-action 只写 `pan-x` 时整条命中链的交集把纵向平移摘掉
    // 了——手指落在导轨里（卡片上、卡片之间的缝隙里都算）纵向拖拽根本滚不动页面。
    // 2026-10-14 起照参考项目（Readoshi）分档：滚轮由脚本接管（捕获 + preventDefault +
    // 横向重映射），触摸整条交给浏览器，鼠标按下才换成抓手光标。分档按设备逐条内联在
    // src/lib/horizontalScroller.ts 里；CSS 只是首帧/无脚本时的兜底，两处必须说同一件事。
    // 这条断言钉住「别再把某一条轴从浏览器手里抢走」——把 CSS 或触摸档改回 pan-x 就转红。
    const railGrid = ruleBody(read('src/styles/shell.css'), '.archive-rail-grid');
    expect(railGrid).toMatch(/overflow-x:\s*auto/);
    const railTouch = railGrid.match(/touch-action:\s*([^;]+);/)?.[1]?.trim() ?? '';
    expect(railTouch, '导轨不能整块吃掉手势').not.toMatch(/\bnone\b/);
    expect(railTouch, '导轨的两条轴都留给浏览器；分档靠内联样式而不是这里的限制').toMatch(/\bauto\b/);
    expect(railGrid, '导轨自己的横向过量滚动不该链给页面').toMatch(/overscroll-behavior-x:\s*contain/);
    const horizontalScroller = read('src/lib/horizontalScroller.ts');
    expect(horizontalScroller, '触摸这一档必须是「浏览器自己滚」').toMatch(/touchAction:\s*'auto'/);
    expect(horizontalScroller, '鼠标这一档才是抓手').toMatch(/cursor:\s*'grab'/);
    // 浏览器自带的另一件「拖」：按住不放（手机上就是长按）再移动，会把 `<a href>` 拖成
    // 一条链接、把图片拖成一张图。挡掉图片之后 Blink 会退到最近的可拖祖先——外面那个
    // `<a>`，所以三类元素都要在同一条「不给拖」的规则里。debug_outputs/drag-out 工装用
    // 真鼠标事件量过：修好前 `<A>` 的 dragstart 带着 text/uri-list（就是那条超链接），
    // 修好后整页 dragstart 为 0。
    const undraggable = [...base.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /-webkit-user-drag:\s*none/.test(body ?? ''))
      .map(([, selector]) => selector ?? '')
      .join(',');
    for (const selector of ['img', 'svg', 'a']) {
      expect(undraggable, `${selector} 要写进「不给拖」的那条规则`).toMatch(new RegExp(`(^|[\\s,])${selector}([\\s,]|$)`));
    }
    // The soft keyboard resizes the viewport instead of covering the controls.
    expect(read('index.html')).toMatch(/interactive-widget=resizes-content/);
    // Machine values dominate, so the defaults are off at the root and the two
    // prose fields opt back in.
    expect(read('index.html')).toMatch(/autocapitalize="off"/);
    const metadata = read('src/components/MetadataEditRoute.tsx');
    expect(metadata).toMatch(/<label>标题<input value=\{title\} autoCapitalize="sentences"/);
    expect(read('src/components/LibraryWorkspace.tsx')).toMatch(/enterKeyHint="search"/);
  });

  it('defines the viewport height once, behind a fallback a minifier cannot drop', () => {
    // `dvh` 要 WebView 108+。认不得它的环境里整条声明会被丢掉——`.app-shell{height:100dvh}`
    // 一丢，高度就退回 `auto`，`.app-main{height:100%}` 跟着 auto，`.workspace{height:100%;
    // overflow-y:auto}` 于是永不溢出：**整页一个滚动容器都不存在**，而 html/body 是
    // `overflow:hidden`，900px 以下的内容既滚不到也拿不到——真机上读作「没法上下滚动」，
    // 下半屏看上去像被什么东西盖住了。2026-10-14 的移动端复测把 dvh 声明整条删掉就复现了
    // 这个形态（`scrollers: []`，`/library` 的 scrollHeight 4253 而 clientHeight 900）。
    //
    // 并排写两行（`height: 100vh;` 再 `height: 100dvh;`）**不够**：构建时压缩器知道目标
    // 支持 `dvh`，会把前一行当冗余删掉——实测 `dist/assets/main-*.css` 里只剩
    // `height:100dvh`，兜底根本没进包。所以视口高度只定义一份变量，升级写在 `@supports`
    // 里（压缩器证明不了 `@supports` 里的声明冗余，兜底这才活得下来）。
    const base = read('src/styles/base.css');
    const fallback = base.indexOf('--viewport-height: 100vh');
    const upgrade = base.indexOf('@supports (height: 1dvh)');
    expect(fallback, 'base.css 必须在 @supports 之外先给出 vh 兜底').toBeGreaterThan(-1);
    expect(upgrade, 'base.css 要用 @supports (height: 1dvh) 升到 dvh').toBeGreaterThan(fallback);
    expect(base.slice(upgrade), '@supports 里要把变量升成 100dvh').toMatch(
      /--viewport-height:\s*100dvh/
    );
    for (const path of ['src/styles/shell.css', 'src/styles/reader.css']) {
      const css = read(path).replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
      // 只钉**高度链**（`height` / `min-height`）：`max-height: calc(100dvh - 32px)` 那类
      // 限高不进高度链，丢掉了只是少一层上限，不会让整页失去滚动容器。
      for (const [index, line] of css.split('\n').entries()) {
        if (!/^\s*(min-)?height\s*:/.test(line)) continue;
        expect(line, `${path}:${index + 1} 的布局高度要读 --viewport-height，不写裸的 100dvh`).not.toMatch(/100dvh/);
      }
      expect(css, `${path} 的布局高度必须读 --viewport-height`).toMatch(/var\(--viewport-height\)/);
    }
    // 其余 `N dvh` 不进高度链：丢掉了只是元素少一层上限，不会让整页失去滚动容器。
    // 这里**不再**要求限高那一类写 `vh` 双写：压缩器会把同一选择器里后写的那条当冗余
    // 删掉，双写根本发不出去，留着只是「看着像兜底」的死声明（2026-10-16 规范注释时
    // 删掉了 `.dedup-relations-list` 那对 46vh/46dvh，剩下的同类也一并删了）。
    // 要给旧 WebView 兜底得走 base.css 里 `--viewport-height` 那种 @supports 变量，
    // 滚动链由上面 `--viewport-height` 那一段守；限高没有兜底是已知缺口，记在 docs/163 §11。
    // 唯一的例外是 base.css 里那份变量升级——它由上面的 `@supports` 守着。
    for (const path of ['src/styles/shell.css', 'src/styles/reader.css', 'src/styles/base.css']) {
      // 先把注释挖成空白（保留换行，行号不变）：注释里提到 `100dvh` 不是声明。
      const strippedCss = read(path).replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
      const lines = strippedCss.split('\n').map((line) => line.replace(/\r$/, ''));
      lines.forEach((line, index) => {
        if (!line.includes('dvh')) return;
        if (/--viewport-height\s*:/.test(line)) return;
        // `@supports (height: 1dvh) {` 是条件本身，不是声明，它不需要 vh 兜底。
        if (/^\s*@supports\b/.test(line)) return;
        // 限高（`max-height`）不要求双写：双写发不出去，见上面的说明。
        if (/max-height\s*:/.test(line)) return;
        expect(lines[index - 1], `${path}:${index + 1} 的 dvh 前面要有 vh 兜底`).toBe(line.replace(/dvh/g, 'vh'));
      });
    }
  });

  it('takes the panel inline touch-action back on a coarse pointer', () => {
    // react-resizable-panels 把 `touch-action` 写**内联**在 Group / Panel 上
    // （`orientation="horizontal"` 时是 `pan-y`，见它的 dist：`touchAction: c ===
    // "horizontal" ? "pan-y" : "pan-x"`）。内联样式压过任何不带 `!important` 的规则，
    // 于是真手指落在首页 / 档案库 / 书架 / 本地档案里横滑不动（横轨）、也捏不动（缩放）。
    // 这条钉住那份抢回来的声明；`horizontalScroller.ts` 那一套「滚轮与触摸分开对待」
    // 在 CSS 这一层被抵消过，是 2026-10-14 实测发现的。
    const shell = read('src/styles/shell.css');
    expect(shell, '面板上的内联 touch-action 必须被 !important 抢回来')
      .toMatch(/\.app-shell \[data-group\][^{]*\{[^}]*touch-action:\s*auto\s*!important/);
    // 设备判据在仓库里只留一份：阅读器与横轨必须问同一句。
    const scroller = read('src/lib/horizontalScroller.ts');
    expect(scroller).toMatch(/COARSE_POINTER_QUERY = '\(hover: none\), \(pointer: coarse\)'/);
    const reader = read('src/components/ReaderScreen.tsx');
    expect(reader).toMatch(/useMediaQuery\(COARSE_POINTER_QUERY\)/);
    expect(reader, '别再另写一份只有 hover: none 的判据').not.toMatch(/useMediaQuery\('\(hover: none\)'\)/);
  });

  it('keeps the floating nav off the last row of every list', () => {
    // Compact panels now flow inside the workspace scroll surface. Reserve the
    // floating bar once there; padding retained nested lists doubles the gap.
    const shell = read('src/styles/shell.css');
    expect(shell.match(/padding-bottom: calc\(var\(--safe-bottom\) \+ 80px\)/g)).toHaveLength(1);
    expect(shell).not.toMatch(/\.app-shell\.is-floating-nav \.library-shell-list,[^}]*padding-bottom/);
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
    // 带边框的小盒子（推荐/同作者）不能靠长身高解决：盒子长高，1px 描边跟着长高，
    // 手机上一个 16px 的字被 50px 的描边盒围住。它走 ::before 那条路 —— 盒子保持
    // 28px 的画出高度，命中区透明地长到 44px。
    const tapHeightRule = coarse.match(/([^{}]*)\{\s*min-height:\s*var\(--tap-min\);/)?.[1] ?? '';
    expect(tapHeightRule, '推荐栏的描边盒不能进「行直接长身高」那张表')
      .not.toMatch(/archive-recommendations-tabs/);
    const tabOverlay = coarse.match(/\.archive-recommendations-tabs button::before[^{}]*\{([^{}]*)\}/)?.[1] ?? '';
    expect(tabOverlay, '推荐栏两段的命中区必须长在 ::before 上').toMatch(/height:\s*max\(100%,\s*var\(--tap-min\)\)/);
    expect(tabOverlay, '推荐栏两段的命中区必须长在 ::before 上').toMatch(/width:\s*max\(100%,\s*var\(--tap-min\)\)/);
    const tabRelative = coarse.match(/([^{}]*)\{\s*position:\s*relative;/)?.[1] ?? '';
    expect(tabRelative, '推荐栏两段的 ::before 要有定位上下文').toMatch(/\.archive-recommendations-tabs button/);
    // 展开态的 `overflow: hidden`（收起成 0 宽时要的）会把命中区一起裁掉，所以
    // 触屏那条路径上要放它出来；桌面那条仍留着。
    const creatorCoarse = coarse.match(/\.archive-recommendations-tabs \.archive-recommendations-tab-creator\s*\{([^{}]*)\}/)?.[1] ?? '';
    expect(creatorCoarse, '展开态的 overflow: hidden 会把 44px 命中区裁掉').toMatch(/overflow:\s*visible/);
    expect(ruleBody(shell, '.archive-recommendations-tabs .archive-recommendations-tab-creator'))
      .toMatch(/overflow:\s*hidden/);
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

  it('gives a whole-region wait the empty state’s geometry instead of a corner sentence', () => {
    // 本地档案页从前是「空的时候一块居中的空状态、读的时候左上角一行小字」：同一件
    // 事的两种状态长得不像一件事，读的那一态看着像页面坏了。`is-region` 是那一档：
    // 几何照抄 .empty-state，标记放大到 is-sm（28px），别再让小圈挂在正中。
    const status = read('src/components/StatusLine.tsx');
    expect(status).toMatch(/region\?: boolean;/);
    expect(status).toMatch(/region \? ' is-region' : ''/);
    const css = read('src/styles/shell.css');
    const region = /\.status-line\.is-region \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(region, 'region 那一档要有自己的几何').toContain('display: grid');
    expect(region).toContain('place-content: center');
    expect(region).toContain('min-height: 320px');
    expect(region).toContain('text-align: center');
    expect(css).toMatch(/\.status-line\.is-region \.loading-mark svg \{ width: 28px; height: 28px; \}/);
    // 空状态是整块区域、加载态也必须整块区域的那两处（列表里、卡片里的行不加）。
    for (const path of ['src/components/LocalArchivesWorkspace.tsx', 'src/components/DeduplicationWorkspace.tsx']) {
      const source = read(path);
      expect(source, path).toMatch(/<(?:ArchiveListSkeleton|ContentSkeleton)/);
      expect(source, path).toMatch(/<EmptyState/);
    }
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

  it('keeps the one actionable toast reachable on a phone', () => {
    // 计算进程坏掉那条提示（`ComputeWorkerToasts`）是 toast 上唯一长着按钮的一张：常驻条
    // `ComputeWorkerNotice` 删掉之后，宿主那道 `compute_retry_worker`（清 broken、按需再拉
    // 起）就只剩这里能进去。桌面卡片上按钮和关闭按钮并排；手机那条提示是穿透的胶囊
    // （上面那条判据钉着 `pointer-events: none`），所以按钮必须自己把点击收回来——否则
    // 手机上 worker 一坏就再也没有恢复的入口，只能重启应用。
    const shell = read('src/styles/shell.css');
    const action = ruleBody(shell, '.toast-action');
    expect(action).toMatch(/color:\s*var\(--primary\)/);
    expect(action).toMatch(/min-height:\s*36px/);
    const phone = nestedRuleBody(shell, '.toast-action');
    expect(phone, '手机上的动作按钮要自己收点击').toMatch(/pointer-events:\s*auto/);
    // 按钮从 `Toast` 的卡片里长出来，由 `ComputeWorkerToasts` 挂上真命令。
    const toast = read('src/components/Toast.tsx');
    expect(toast).toMatch(/\{item\.action && <button className="toast-action"/);
    const bridge = read('src/components/ComputeWorkerToasts.tsx');
    expect(bridge).toMatch(/action: \{ label: '重试', run: \(\) => \{ lastKey = ''; void repository\.retryWorker\(\); \} \}/);
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

  it('strips the reader loading mark back to a liquid drop', () => {
    // 2026-10-15 用户要求：阅读器的加载动画「去掉其背景部分，并令其更具液态感」。
    // 「背景」就是 M3 那圈淡轨道（`.loading-indicator-track`）：阅读器这两块容器本来就是
    // 纯色画布，淡圈既不是页面也不是台面，只是噪声。去掉之后只留一段会伸缩的弧，并把
    // 等速的伸缩换成「一滴水拉长—回缩—滑走」。改动只落在阅读器那两个容器上：全应用那
    // 一个 M3 指示器（`.loading-indicator`）保持原样，别处的加载圈不受影响。
    const reader = read('src/styles/reader.css');
    // 轨道是「两条选择器合一条规则」写的（整页加载 + 单页加载），所以按整条规则断，
    // 不能用 `ruleBody`（它找的是「选择器紧跟 `{`」，分组里第一条后面是逗号）。
    expect(reader, '阅读器的加载标记不能有那圈淡轨道').toMatch(
      /\.reader-screen-loading \.loading-indicator-track,\s*\n\s*\.reader-page-status \.loading-indicator-track \{ display: none; \}/,
    );
    // 液态那两套动画都落在阅读器的选择器上，而且用的是既有令牌（不新造令牌）。
    expect(ruleBody(reader, '.reader-page-status .loading-indicator-arc'), '阅读器的弧要走液态那套伸缩').toMatch(
      /animation:\s*reader-loading-drop\s+var\(--duration-pulse\)\s+var\(--ease-pulse\)/,
    );
    expect(ruleBody(reader, '.reader-page-status .loading-indicator svg'), '阅读器的整枚标记要带缓动地流动').toMatch(
      /animation:\s*reader-loading-flow\s+var\(--duration-pulse\)\s+var\(--ease-pulse\)/,
    );
    expect(ruleBody(reader, '@keyframes reader-loading-drop'), '液态伸缩的 keyframes 必须在').toMatch(/stroke-dasharray/);
    expect(ruleBody(reader, '@keyframes reader-loading-flow'), '流动的 keyframes 必须在').toMatch(/rotate\(360deg\)/);
    // 2026-10-16 用户要求「中间不要有LOGO啥的，简洁一点」：圈里那枚品牌标拿掉了，运动也
    // 只剩「匀速转 + 弧长伸缩」——再叠 scale 呼吸就会看着在抖，尺寸也统一收到 44px。
    const indicator = read('src/components/LoadingIndicator.tsx');
    expect(indicator, '加载标记里不许再画品牌标').not.toMatch(/YomikaMark|reader-loading-glyph/);
    expect(reader, '阅读器那套 is-reader 规则应当整段删掉，而不是留着不生效').not.toMatch(/reader-loading-glyph|\.loading-indicator\.is-reader/);
    expect(ruleBody(reader, '@keyframes reader-loading-flow'), '整枚标记只匀速转，不再叠 scale 呼吸').not.toMatch(/scale\(/);
    expect(ruleBody(reader, '.reader-page-status .loading-indicator svg'), '两个容器统一收到 44px').toMatch(/width:\s*44px/);
    expect(ruleBody(reader, '.reader-page-status .loading-indicator-arc'), '笔画 3px，别再回到 2.5').toMatch(/stroke-width:\s*3/);
    // 全应用那一个 M3 指示器不能被顺手改掉：轨道与 dash 那套 keyframes 还在 shell.css 里。
    const shell = read('src/styles/shell.css');
    expect(ruleBody(shell, '.loading-indicator-track'), '全应用的 M3 轨道不能被顺手删掉').toMatch(/stroke:\s*color-mix/);
    expect(ruleBody(shell, '@keyframes loading-indicator-dash'), '全应用的 M3 dash 不能被顺手删掉').toMatch(/stroke-dasharray/);
    // 减弱动效下那套液态动画必须被关掉：阅读器的选择器比通杀块具体，不写 !important
    // 压不过它（上面那条 clause 只钉了不带容器前缀的 `.loading-indicator-arc`）。
    const marker = '@keyframes loading-indicator-breathe';
    const start = shell.indexOf('@media (prefers-reduced-motion: reduce)', shell.indexOf(marker));
    const open = shell.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let index = open; index < shell.length; index += 1) {
      if (shell[index] === '{') depth += 1;
      else if (shell[index] === '}' && (depth -= 1) === 0) { end = index; break; }
    }
    const block = shell.slice(open + 1, end);
    expect(block, '减弱动效下阅读器的弧也要停（!important，压过容器前缀那条更具体的选择器）').toMatch(/\.reader-page-status \.loading-indicator-arc[\s\S]*?animation:\s*none\s*!important/);
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

  it('gives the installed-snippet library the shared row and the mirrored switch slot', () => {
    // 用户 2026-10-18 报「dlssnr多个版本没法共存，导致下了一个版本就会顶掉其他版本」：库里
    // 每一种都要看得见、换得回去。这一段不能自造行式——行体走共享的 `.settings-choice-option-main`，
    // 行尾动作必须挂在 `.select-option-download` 上：shell.css 那条
    // `:has(> .select-option-download)` 的镜像留白只认这个类，换成 `.secondary-action`（约 50px）
    // 会让「切换」那一行的字比「正在用」那行偏左几个像素，正是那条规则注释里用户报过的毛病。
    const source = read('src/components/DlssnrSettingsGroup.tsx');
    expect(source).toMatch(/aria-label="已安装的片段"/);
    // 切换按钮自己带上是哪一条（无障碍名），动作本身也走上面那个镜像槽。
    expect(source).toMatch(/aria-label=\{`切换到\$\{name\}`\}/);
    expect(source).toMatch(/className="select-option-download"[\s\S]{0,400}?切换/);
    // 库里的行不许自造类名（自造就意味着脱离共享行式与那条镜像留白）。
    expect(source).not.toContain('dlssnr-library');
    expect(read('src/styles/shell.css')).toMatch(/\.settings-choice-option:has\(> \.select-option-download\)/);
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

  it('hangs the capability chips on the device row itself, never on a row of their own', () => {
    // 用户报的：「去掉图 1 和图 2 里的远端处理能力，以胶囊形式放到图 2 的设备名右侧」。
    // 同一个清单从前在设置组里铺一行、二级菜单底下再念一遍，现在只出现在二级菜单里
    // **当前连上的那一台**的行尾。几何那一半由无头 Edge 量过：菜单在 390px 宽时两列
    // 会让胶囊压在地址上 67.25px，三列 + 640px 折行后是 0。
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const source = read('src/components/ComputeCenterSettingsGroup.tsx');
    expect(shell).not.toMatch(/\.settings-capability-row\s*\{/);
    expect(source).not.toContain('settings-capability-row');
    expect(shell).toMatch(/\.settings-device-option\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)\s*auto/);
    expect(shell).toMatch(/\.settings-device-capabilities\s*\{[^}]*justify-content:\s*flex-end/);
    expect(shell).toMatch(/@media \(max-width: 640px\)\s*\{\s*\.settings-device-option\s*\{\s*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/);
    expect(shell).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.settings-device-capabilities\s*\{\s*grid-column:\s*2/);
    expect(source).toMatch(/className="settings-device-capabilities" role="group" aria-label="远端可用服务"/);
    // 菜单底下那行「DESKTOP-PC · 超分、DLSS5」整行去掉，别再有人捡回来。
    expect(source).not.toMatch(/<p className="settings-menu-desc">\{remote\.name\}/);
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

    // 图③的另一半：最后一行不再需要第二个半径，也不再需要任何「末尾补一点」的内缩。
    // 此前列表正好收尾时面板的下内边距被砍到 space-1、加上内容区那点余量只剩 8.7px，
    // 而左右是 16px——四边不等，12px 的内弧和 28px 的外弧就不平行，于是代码给最后一行
    // 两个下角写死了 `calc(var(--radius-overlay) - 8.7px)`。之后又一度把尾巴挪到内容区
    // 自己身上（`--space-2`），那仍然让末行的左 16 / 右 16 / 下 24 不成套。现在**一处
    // 都不留**：面板四边 16px，内容区内缩 0，末行的两个下角正好落进面板 28px 弧线的
    // 起点（见「四边同内缩」那条），内半径回到 28 − 16 = 12px = `--radius-card`。
    expect(shell).not.toMatch(/\.settings-choice-panel:has\([^)]*\)[^{]*\{\s*padding-bottom/);
    expect(shell).not.toMatch(/settings-menu-body\s*\{\s*padding-bottom/);
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

  it('keeps the error log refreshing itself, with its four actions along the bottom', () => {
    // 用户这一轮要的两件事：①「去掉刷新按钮，让错误日志界面实时更新新日志」——面板自己轮询；
    // ②「去掉更多按钮，像其它设置面板那样，把内部四个按钮放到底部共享宽度显示，SVG 图标+文字」。
    // 另外那档 `--z-menu-over-modal` 是给被删掉的 ⋮ 菜单加的，它得跟着一起走——留着就是
    // 一条只服务于死代码的 z 序。
    const panel = read('src/components/ErrorLogPanel.tsx');
    expect(panel, '刷新按钮已删：面板自己更新').not.toContain('刷新日志');
    expect(panel, '⋮ 菜单已删').not.toContain('DropdownMenu');
    expect(panel, '动作从菜单搬到了底部').not.toContain('log-menu');

    const actions = /<div className="settings-menu-actions" role="group" aria-label="日志操作">([\s\S]*?)<\/div>/.exec(panel);
    expect(actions, '四个动作要在面板底部的一个动作行里').not.toBeNull();
    for (const label of ['复制日志', '导出日志', '错误反馈', '清空日志']) {
      expect(actions![1], `${label} 要带图标（SVG + 文字）`).toContain(`aria-hidden="true" />${label}`);
    }
    expect(actions![1], '清空是破坏性的那一个').toContain('className="secondary-action is-danger"');

    // 实时更新：面板自己开一个定时器去问原生侧，并且是「安静」的那一条路（不闪状态行、
    // 不因为读失败弹 toast），否则每两秒闪一下「正在读取…」比手动刷新还烦。
    expect(panel).toMatch(/export const ERROR_LOG_REFRESH_MS = 2_000;/);
    expect(panel).toMatch(/window\.setInterval\(\(\) => \{ void reload\(\{ quiet: true \}\); \}, ERROR_LOG_REFRESH_MS\)/);
    expect(panel, '面板卸载（菜单关掉）就得停').toMatch(/return \(\) => window\.clearInterval\(timer\);/);
    expect(panel).toMatch(/if \(!quiet\) setBusy\(true\);/);
    expect(panel).toMatch(/else if \(!quiet\) showToast\(response\.error\.message, 'error'\);/);

    // 轮询每两秒换一份列表：展开的那一条按身份记，不按序号，否则会串到隔壁那条上。
    expect(panel).toMatch(/function entryKey\(entry: ErrorLogEntry\): string \{/);
    expect(panel).toMatch(/const \[openEntry, setOpenEntry\] = useState<string>\(\);/);
    expect(panel).toMatch(/const key = entryKey\(entry\);/);

    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(shell, '顶部那一行没有东西可放了').not.toContain('.error-log-head');
    expect(
      ruleBody(shell, '.error-log-panel > .settings-menu-actions'),
      '四个「图标+四个汉字」的按钮塞不进 388px 的一行，排成两等列才不裁字',
    ).toMatch(/display:\s*grid;\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(shell, '菜单没了，它那套样式也走').not.toContain('.log-menu');
    expect(read('src/styles/tokens.css'), '只服务于那个菜单的 z 序也该走').not.toContain('--z-menu-over-modal');
  });

  it('lets the error log inherit the project font, and keeps literal families out of the sheets', () => {
    // ④（用户报的「错误日志里的字体没用项目统一字体」）：WebView2 不认 `ui-monospace`，
    // 写死的等宽（或任何字体族字面量）会落到系统默认字体上，看上去就不像这个应用里的字。
    // 自定义 CSS 那个输入框报的是同一件事，shell.css 里那条修复注释写着同样的理由。
    const sheets = ['src/styles/base.css', 'src/styles/shell.css', 'src/styles/reader.css', 'src/styles/tokens.css'];
    const seen: string[] = [];
    const offenders: string[] = [];
    for (const sheet of sheets) {
      const css = read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of css.matchAll(/font-family:\s*([^;}]+)/g)) {
        const value = match[1]!.trim();
        seen.push(`${sheet}: ${value}`);
        if (!/^(?:var\(--font-(?:body|display|utility)\)|inherit)$/.test(value)) offenders.push(`${sheet}: font-family: ${value}`);
      }
    }
    expect(offenders, '样式表里的字体族只许引 token：写死的族在 WebView2 上会落到系统字体').toEqual([]);
    expect(seen.length, '这条判据要真的扫到东西，不然它什么都没保证').toBeGreaterThan(10);

    const css = (sheet: string) => read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
    const writingSurfaces = sheets.flatMap((sheet) => [...css(sheet).matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(([, selector, body]) => /(?:^|[\s,>+~])(?:textarea|input)(?![-\w])/.test(selector!) && body!.includes('font-family'))
      .map(([, selector]) => `${sheet}: ${selector!.trim().split('\n').pop()}`));
    expect(writingSurfaces, '要在里面写字的控件跟随正文字体（base.css 的 `font: inherit` 就是那条规则）').toEqual([]);

    const errorLogFamilies = [...read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*\.error-log-[\w-]*[^{}]*)\{([^{}]*)\}/g)]
      .filter(([, , body]) => body!.includes('font-family'))
      .map(([, selector, body]) => [selector!.trim().split('\n').pop()!, /font-family:\s*([^;}]+)/.exec(body!)?.[1]?.trim() ?? '']);
    expect(
      errorLogFamilies.filter(([, value]) => value !== 'var(--font-body)'),
      '错误日志里的字只许是项目正文那一族',
    ).toEqual([]);
    // 上一轮把这里的 `font-family` 删掉、指望「继承面板」——`<pre>` 有自己的 UA 规则
    // （`font-family: monospace`），继承不到 `html` 那一族，于是详情又变回系统等宽。
    // 这条判据咬的就是那件事：展开的那一段必须自己声明项目字体。
    const panel = read('src/components/ErrorLogPanel.tsx');
    expect(panel, '判据要跟着真实标记走：详情那一段用的是 .error-log-code').toContain('<pre className="error-log-code">');
    expect(
      ruleBody(read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, ''), '.error-log-code'),
      '展开的详情是 <pre>：不自己声明字体就会落到 UA 的等宽上',
    ).toMatch(/font-family:\s*var\(--font-body\)/);
  });

  it('keeps the severity band of an error log row out of the hover paint', () => {
    // 图②那一半（「hover 效果溢出」）：色带原来是 `box-shadow: inset 3px 0 0`，而悬停底色
    // 画在行内容盒里、圆角还压在色带上——放大看就是色带被高亮底色切成两段。色带改成占位
    // 的左边框：它有自己的那一格，悬停底色再也盖不到它。
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const entry = ruleBody(shell, '.error-log-entry');
    expect(entry, '严重度色带要占住自己那一格，不能是 inset 阴影').toMatch(/border-left:\s*3px solid var\(--state-danger\)/);
    expect(entry, 'inset 阴影会被悬停底色盖住').not.toMatch(/box-shadow/);
    expect(ruleBody(shell, '.error-log-entry.is-warn')).toMatch(/border-left-color:\s*var\(--state-warning\)/);
  });
});

/** 已配对设备的连接要「稳」：一次探测失败不等于断开、点一次本机开关不该换令牌、阅读器
 *  不要被一次失败打回灰。这三条都不是画出来能看出来的（要对面恰好不答才行），所以钉在
 *  源码上——它们对应的都是「设备连上之后又断开、还得重新配对」那条反馈。
 *
 *  `slice` 取一个函数体：从函数头到下一个同级 `async function` 为止。 */
describe('the paired-device link holds still', () => {
  const body = (source: string, from: string) => source.slice(source.indexOf(from)).split('\n  async function ')[0] ?? '';
  /** 注释里会**解释**被删掉的那一行（比如「不要在这里带 rotateToken」），判据得看代码。 */
  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('keeps the last good capability list when a probe comes back empty', () => {
    const group = read('src/components/ComputeCenterSettingsGroup.tsx');
    const connect = body(group, 'async function connectRemote(');
    // 「哪一台」才是过期与否的判据：同一台重探时旧清单要留着。
    expect(connect, '换一台设备才让位，同一台重探时旧清单要留着').toMatch(
      /if \(address !== remoteAddress\) \{ setRemote\(undefined\); setRemoteAddress\(address\); \}/,
    );
    expect(connect, '探失败不许抹掉上一次的答案（那就是「刚连上又断开」）').not.toMatch(/result\.ok\) \{\s*setRemote\(undefined\)/);
  });

  it('never rotates the pairing token from the serving switch', () => {
    // Rust 侧的 `rotate_token` 会 `pairing.clear()`：一出现，所有已配对设备当场失效。
    // 开关那里从前判的是「本机偏好里的令牌空不空」——那只是没同步上，不是「请换令牌」。
    const group = read('src/components/ComputeCenterSettingsGroup.tsx');
    expect(body(code(group), 'async function toggleServing('), '开关一次不该踢掉已配对设备').not.toMatch(/rotateToken/);
  });

  it('rides out a capability probe that fails once in the reader', () => {
    const route = read('src/components/ReaderRoute.tsx');
    expect(route, '一次问不到就重试，别把三枚开关打回灰').toMatch(/for \(let attempt = 0; attempt < 3; attempt \+= 1\)/);
    expect(route, '只有这一台的清单算数：换设备的瞬间旧答案要过期').toMatch(
      /remoteCapabilities\?\.address === remoteAddress \? remoteCapabilities\.value : undefined/,
    );
  });
});

/** 「重置远端」那一下是**原地变形**：点下去以后，用户刚按的那一颗自己变成确认按钮，
 *  它旁边长出一枚「取消」。行为那一半（同一个节点还在、举着没人管会退回去、窗口被切走
 *  也退回去）钉在 `tests/components/settings-workspace.test.tsx` 里；jsdom 看不见的是
 *  「变形」本身——两颗胶囊之间的那一段过渡落在样式表上，所以在这里钉。 */
describe('the destructive confirmation morphs in place', () => {
  const shell = read('src/styles/shell.css');
  const plain = shell.replace(/\/\*[\s\S]*?\*\//g, '');

  it('splits the account row into three equal columns, and the pair into two when armed', () => {
    // 2026-10-15 用户报「部分按钮的宽度不一致了」：真浏览器里量到的是 130 / 130 / 96——
    // 三项的 flex 都是 `1 1 0px`、`min-width` 都是 0，第三项就是不长到另两项的宽度
    // （把三项都改成内联 `flex: 1 1 0`、把它的 basis 改成 `0%`、`width: 0`、去掉内层
    // 按钮的 flex，读数一动不动）。同一行换成 grid 三等分后立刻是 119 / 119 / 119，
    // 所以判据钉在「排法是三等分」上，而不是钉在那份算不准的 flex 上。
    expect(ruleBody(shell, '.settings-menu-account-actions'), '三等分整行').toMatch(/display:\s*grid/);
    expect(ruleBody(shell, '.settings-menu-account-actions')).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(ruleBody(shell, '.settings-menu-reset'), '未变形时只有常驻那一颗，占满第三列').toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(ruleBody(shell, '.settings-menu-reset'), '未变形时不能是两列，否则常驻那颗只拿到半格').not.toMatch(/repeat\(2/);
    expect(ruleBody(shell, '.settings-menu-reset.is-armed'), '变形后跨满三列，两枚各分一半').toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(ruleBody(shell, '.settings-menu-reset.is-armed')).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    // 三等分把每颗压到 96px（390px 宽的手机）：4 个汉字 + 17px 图标 + 两侧 16px 内边距
    // 量出来 103，会被 overflow:hidden 裁掉——所以这一行的内边距与图标间距各收一档，
    // 360px 上再收一档图标与间距（真浏览器实测：390 与 360 下 scrollWidth == clientWidth）。
    expect(shell, '这一行的内边距与图标间距各收一档').toMatch(/\.settings-menu-account-actions > \.primary-action,[\s\S]{0,260}?padding-inline:\s*var\(--space-2\)/);
    expect(shell, '360px 上再收图标与间距').toMatch(/@media \(max-width: 380px\)[\s\S]{0,420}?\.settings-menu-reset > \.secondary-action svg \{ width: 15px/);
  });

  it('draws the account glyph once, on the menu title, and not again in the row', () => {
    // 用户报「同步界面上下的 LOGO 是重复的」：标题的图标槽里已经有一枚 `<Waypoints>`，
    // 账户行里又画了一枚同样的图形。一屏里同一枚图形只画一次——行里那枚去掉了，
    // 连它那条样式也一起删（留着就是死规则）。
    expect(read('src/components/SettingsWorkspace.tsx'), '行里不再画第二枚').not.toMatch(/settings-menu-account-glyph/);
    expect(read('src/styles/shell.css'), '样式也不留死规则').not.toMatch(/settings-menu-account-glyph/);
    // 行首那一列本来是给图标的：去掉之后网格只剩一列，名称才不会被挤进图标宽里。
    expect(ruleBody(read('src/styles/shell.css'), '.settings-menu-account')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('animates the morph instead of snapping between two button sets', () => {
    expect(shell, '常驻那一颗轻轻张开').toContain('@keyframes settings-reset-morph');
    expect(shell, '对手方从左边淡入').toContain('@keyframes settings-reset-partner-in');
    expect(
      ruleBody(shell, '.settings-menu-reset.is-armed > .settings-menu-reset-toggle'),
      '变形动画挂在常驻那颗按钮上，而且用同一档时长',
    ).toMatch(/animation:\s*settings-reset-morph\s+var\(--motion-fast\)\s+backwards/);
    expect(
      ruleBody(shell, '.settings-menu-reset.is-armed > .settings-menu-reset-cancel'),
      '对手方那一半同拍进场',
    ).toMatch(/animation:\s*settings-reset-partner-in\s+var\(--motion-fast\)\s+backwards/);
  });

  it('lets a reader who asked for less motion have the morph turned off', () => {
    const optOut = [...plain.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
      .map(([, body]) => body ?? '')
      .filter((body) => body.includes('.settings-menu-reset.is-armed'));
    expect(optOut, '这两条动画必须有自己那一档「少动效」的出口，而且只该有一条').toHaveLength(1);
    expect(optOut[0]).toMatch(/\.settings-menu-reset\.is-armed > \.settings-menu-reset-cancel \{\s*animation:\s*none/);
  });
});


it('grants tray reopening only event listening permissions to the tray window', () => {
  const capabilities = readdirSync(resolve(root, 'src-tauri/capabilities')).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(read(`src-tauri/capabilities/${name}`)) as { windows?: string[]; permissions: string[] });
  const tray = capabilities.filter((capability) => capability.windows?.includes('tray-menu'));
  expect(tray).toHaveLength(1);
  expect(tray[0]?.windows).toEqual(['tray-menu']);
  expect(tray[0]?.permissions).toEqual(['core:event:allow-listen', 'core:event:allow-unlisten']);
});

it('keeps the generated capability snapshot in step with the hand-written ones', () => {
  // `src-tauri/gen/schemas/capabilities.json` 是 tauri 构建时生成的快照，但它入库之后
  // 没有任何东西看着它：手写的 `src-tauri/capabilities/*.json` 改了、生成物没跟着变，
  // 要等下一次跑 `tauri build` 才暴露——而交付轮恰好是**先提交再构建**，中间这段空窗
  // 里没人能发现漂移。这条判据把两份东西钉在一起：标识、窗口、权限逐项相等，生成物里
  // 也不许留着已经删掉的条目（那种漂移只会在下次构建时把权限悄悄还回来）。
  const written = readdirSync(resolve(root, 'src-tauri/capabilities'))
    .filter((name) => name.endsWith('.json'))
    .map(
      (name) =>
        JSON.parse(read(`src-tauri/capabilities/${name}`)) as {
          identifier: string;
          description?: string;
          windows?: string[];
          permissions: string[];
        },
    );
  const generated = JSON.parse(read('src-tauri/gen/schemas/capabilities.json')) as Record<
    string,
    { identifier: string; description?: string; local?: boolean; windows?: string[]; permissions: string[] }
  >;

  expect(
    Object.keys(generated).sort(),
    '生成物里多出来的条目，说明有 capability 被删掉却没重新生成',
  ).toEqual(written.map((capability) => capability.identifier).sort());
  for (const capability of written) {
    const snapshot = generated[capability.identifier];
    expect(snapshot, `${capability.identifier} 没出现在生成物里`).toBeDefined();
    expect(snapshot?.description).toBe(capability.description);
    expect(snapshot?.windows).toEqual(capability.windows);
    expect(snapshot?.permissions).toEqual(capability.permissions);
    expect(snapshot?.local, '生成器给每条 capability 补的 local: true').toBe(true);
  }
});

it('keeps 仅历史记录 scoped to the two places the setting means', () => {
  // 用户的原话：「仅历史记录是指仅在首页历史记录组件和历史记录页面内显示进度条，全部是指
  // 所有有进度的不管在什么页面都显示进度条」。位置由调用方声明（`progressScope`），组件不
  // 猜路由——这一条钉住那两处真的声明了，免得以后改动丢掉它们，设置又变成「改了没反应」。
  const routes = read('src/app/routes.tsx');
  // 首页那一排：继续阅读是历史派生出来的。这一处 rail 写成一行，按行找最稳
  // （属性里就有 `>`，正则跨不过去）。
  const continueRail = routes.split(/\r?\n/).find((line) => line.includes('title="继续阅读"')) ?? '';
  expect(continueRail, '首页那一排没有声明位置').toContain('progressScope="history"');
  // 历史记录页面：书架的列表只有 name === 'history' 才算历史那两处之一。
  const shelfStart = routes.indexOf('readingProgressByArchiveId={progressByArchiveId}');
  expect(shelfStart, '书架的列表没接进度').toBeGreaterThan(-1);
  expect(routes.slice(shelfStart, shelfStart + 200), '书架没有声明位置').toContain(
    "progressScope={name === 'history' ? 'history' : 'elsewhere'}",
  );

  const card = read('src/components/ArchiveThumbnailCard.tsx');
  expect(card, '档位决定画不画、位置决定在哪儿画').toMatch(
    /const allowed = mode === 'all' \|\| \(mode === 'history' && scope === 'history'\);/,
  );
  expect(card, '「有进度」仍要先成立').toMatch(/const read = typeof page === 'number' && page >= 1;/);

  const workspace = read('src/components/LibraryWorkspace.tsx');
  expect(workspace, '档案库列表里两处进度条都要带上位置').toMatch(/scope=\{progressScope\} cornerAware/);
  expect(workspace).toMatch(/progressScope=\{progressScope\}/);
});

describe('the 2026-10-17 UI batch', () => {
  it('keeps the card hover shadow inside the list padding, and smaller than it was', () => {
    const tokens = read('src/styles/tokens.css');
    const shadows = [...tokens.matchAll(/--shadow-card-hover:\s*([^;]+);/g)].map((match) => match[1] ?? '');
    expect(shadows.length, '亮/暗两档都要有这张卡片阴影').toBeGreaterThanOrEqual(2);
    for (const shadow of shadows) {
      expect(shadow, '横向模糊要收进列表两侧的内边距（12px）里，否则两侧被 overflow 裁掉').toContain('12px');
      expect(shadow, '24px 那一版就是用户看到的「阴影左右被切」').not.toContain('24px');
    }
  });

  it('keeps the detail title skeleton inside the title line box', () => {
    const shell = read('src/styles/shell.css');
    expect(shell, '标题骨架不能写死高度：标题那一行只有 --text-lg × --leading-tight 那么高').toMatch(
      /\.skeleton-line-title \{[^}]*height: 100%;/,
    );
    expect(shell, '写死 34px 就是下缘被切掉的那一版').not.toMatch(/\.skeleton-line-title \{[^}]*height: 34px;/);
  });

  it('cannot wrap a DLSSNR variant label', () => {
    const shell = read('src/styles/shell.css');
    expect(shell, '变体名要单行省略，不能换行').toMatch(
      /\.settings-choice-option-main:not\(\.settings-device-option\) > span \{[^}]*white-space: nowrap;/,
    );
    const manifest = JSON.parse(read('src-tauri/resources/dlssnr/dlssnr-manifest.json')) as {
      variants: { label: string }[];
    };
    for (const variant of manifest.variants) {
      // 最长的合法名字是「Lecram 版」（8 字）；原先那一串带括号的说明会折行。
      expect(variant.label.length, `变体名要短到不换行：${variant.label}`).toBeLessThanOrEqual(8);
    }
  });

  it('takes the press scale off the settings rows, and puts the cards’ press scale on the card box', () => {
    const base = read('src/styles/base.css');
    const polish = read('src/styles/visual-enhancements.css');
    expect(base, '全局按压会给 button/a 加 2% 缩小').toMatch(/button:active,[\s\S]{0,80}scale\(0\.98\)/);
    // 设置行必须例外：它连着悬停底色，缩盒子会让用户看到「点击时 hover 效果也变小」。
    expect(base, '设置行必须例外：缩盒子会把悬停底色一起缩掉').toMatch(
      /\.settings-row-button:active \{[^}]*transform: none;/,
    );
    // 卡片反过来：2026-10-18 用户要求「点击要有缩小效果、别让其他卡片动」，缩放落在卡片盒子上；
    // 同日又报「列表档案卡片的缩小程度太大了」，于是满宽的列表行单独收到 0.99。
    expect(polish, '缩略图卡片按下去要缩自己').toMatch(
      /\.archive-thumb-card:is\(\.is-pressed, :active\) \{\s*transform: scale\(0\.97\);/,
    );
    expect(polish, '满宽列表行只缩一点点').toMatch(
      /\.archive-row:is\(\.is-pressed, :active\) \{\s*transform: scale\(0\.99\);/,
    );
  });

  it('restores a retained page without animating the scroll', () => {
    const retained = read('src/app/RetainedPage.tsx');
    expect(retained, '恢复位置要临时关掉平滑滚动：视觉优化那批给 .workspace 与滚动区开了 scroll-behavior: smooth').toMatch(
      /function writeInstantScroll\(region: HTMLElement, write: \(\) => void\) \{[\s\S]{0,140}region\.style\.scrollBehavior = 'auto';/,
    );
    expect(retained, '工作区那一处要走它').toContain(
      'writeInstantScroll(workspace, () => { workspace.scrollTop = positions.current.get(workspace) ?? 0; })',
    );
    expect(retained, '滚动区那一处也要走它').toContain(
      'writeInstantScroll(region, () => { region.scrollTop = top; })',
    );
  });

  it('keeps automatic sync on, with no switch to turn it off', () => {
    const preferences = read('src/app/preferences.tsx');
    expect(preferences, '自动同步就该一直开着：进门强制打开，不再跟着偏好走').toMatch(
      /useEffect\(\(\) => \{\s*setAutoSyncEnabled\(true\);\s*\}, \[\]\);/,
    );
    const settings = read('src/components/SettingsWorkspace.tsx');
    expect(settings, '设置里不该再有自动同步开关').not.toMatch(/label="自动同步"/);
  });

  it('draws the vote glyph as the Material thumb, buttons first and the score to their right', () => {
    const comments = read('src/components/EhComments.tsx');
    expect(comments, '投票用实心 Material 拇指（用户图 4 的形状）').toContain(
      'M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11z',
    );
    expect(comments, '向下那一枚是同一路径转 180°，两枚永远同形').toContain('rotate(180 12 12)');
    expect(comments, '不再用 Lucide 的描边拇指').not.toMatch(/ThumbsUp|ThumbsDown/);
    const actionsAt = comments.indexOf('eh-comment-votes-actions');
    const scoreAt = comments.indexOf('eh-comment-score');
    expect(actionsAt, '投票按钮那一组在标记里存在').toBeGreaterThan(-1);
    expect(scoreAt, '分数排在按钮之后——DOM 顺序就是视觉顺序，用户要它在按钮右侧').toBeGreaterThan(actionsAt);

    const shell = read('src/styles/shell.css');
    expect(ruleBody(shell, '.eh-comments-list li')).toMatch(/grid-template-columns: minmax\(0, 1fr\) max-content/);
    expect(ruleBody(shell, '.eh-comment-meta')).toMatch(/grid-template-columns: subgrid/);
    expect(ruleBody(shell, '.eh-comment-votes')).toMatch(/grid-column: 2/);
    expect(ruleBody(shell, '.eh-comment-votes')).toMatch(/justify-content: space-between/);
    expect(ruleBody(shell, '.eh-comment-votes-actions button:first-child')).toMatch(/justify-items: start/);
    expect(shell, '两枚按钮永远同一行：容器落回块级就会上下堆、第二枚还会溢出卡片').toMatch(
      /\.eh-comment-votes-actions \{[^}]*display: inline-flex;[^}]*flex-wrap: nowrap;/,
    );
    expect(shell, '分数宽度钉住，+6 与 +119 不会推着按钮左右移动').toMatch(
      /\.eh-comment-votes \.eh-comment-score \{[^}]*flex: none;[^}]*min-width: 4ch;/,
    );
  });
});

/* ---------------------------------------------------------------------------
 * 移动端四项缺陷（用户 2026-10-18 报的 5 / 6 / 7 / 12）。
 * 判据钉行为语义，不钉行号与文本顺序：键盘收不收、高亮在不在、底部有没有多出
 * 一截空带、底栏跟不跟着键盘走。
 * ------------------------------------------------------------------------- */
describe('移动端：软键盘、卡片高亮、底部留白、底栏避让', () => {
  it('hides the soft keyboard when Enter commits an input', () => {
    const library = read('src/components/LibraryWorkspace.tsx');
    expect(library, '搜索框的 Enter 分支：preventDefault 掉默认提交之后输入法不会自己落下，得把焦点从输入框上拿走').toMatch(
      /if \(event\.key !== 'Enter'\) return;\s*\n\s*event\.preventDefault\(\);[\s\S]{0,400}?event\.currentTarget\.blur\(\);/,
    );
    const dialog = read('src/components/TextInputDialog.tsx');
    expect(dialog, '对话框输入框的 Enter 分支同理：先失焦再提交，元素被摘掉并不保证键盘跟着落下').toMatch(
      /if \(event\.key === 'Enter'\) \{ event\.preventDefault\(\); event\.currentTarget\.blur\(\); void submit\(\); \}/,
    );
  });

  it('keeps the open-detail highlight off the compact card list', () => {
    const library = read('src/components/LibraryWorkspace.tsx');
    expect(library, '紧凑档详情本来就是整屏，列表上那圈 primary 高亮只剩「失焦也不消失」这一种读法，所以卡片高亮必须把 compact 算进去').toMatch(
      /const pressed = !compact && archive\.archiveId === detailArchiveId;/,
    );
  });

  it('leaves no tail padding inside the library scrollers', () => {
    const shell = read('src/styles/shell.css');
    expect(shell, '详情面板不再单独补一份底部留白：面板在宽档自己就是滚动容器，补进去的留白只会落在滚动范围里').not.toMatch(
      /\.library-shell-detail \{[^}]*padding-bottom/,
    );
    expect(shell, '详情路由也不再补：min-height: 100% 配底部内边距撑不掉那截空带').not.toMatch(
      /\.archive-detail-route \{[^}]*padding-bottom/,
    );
    expect(shell, '两个面板在窄档的下内边距同样归零（窄档滚动的是 .workspace 自己）').toMatch(
      /\.library-shell-list,\s*\.library-shell-detail \{ padding: var\(--space-4\) var\(--space-4\) 0;/,
    );
    expect(shell, '遮挡格仍只由唯一的滚动容器补：悬浮底栏那一格').toMatch(
      /\.app-shell\.is-floating-nav \.workspace,[\s\S]{0,160}padding-bottom: calc\(var\(--safe-bottom\) \+ 80px\);/,
    );
  });

  it('keeps the floating nav where it is when the soft keyboard opens', () => {
    const main = read('src/main.tsx');
    expect(main, '布局视口被键盘缩短了多少，写成 --keyboard-inset（visualViewport 的收缩量）').toMatch(
      /visualViewport[\s\S]{0,600}setProperty\('--keyboard-inset'/,
    );
    const base = read('src/styles/base.css');
    expect(base, '变量得有声明在 html 上的兜底值，否则 calc() 整条失效').toMatch(/--keyboard-inset: 0px;/);
    const shell = read('src/styles/shell.css');
    expect(shell, '悬浮底栏把这份缩短量反向减掉：屏幕上原地不动、由键盘盖过去，而不是跟着往上避让').toMatch(
      /\.compact-nav\.is-floating \{[\s\S]{0,600}bottom: calc\(var\(--safe-bottom\) \+ var\(--space-3\) - var\(--keyboard-inset\)\);/,
    );
    expect(shell, '这套补偿只给悬浮底栏：停靠底栏与对话框要留在键盘之上').not.toMatch(
      /\.compact-nav \{[^}]*--keyboard-inset/,
    );
  });
});
