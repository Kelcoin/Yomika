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
    const shell = read('src/styles/shell.css');
    expect(tokens).toMatch(/--shadow-card:/);
    expect(tokens).toMatch(/--brand-vermilion-strong:/);
    expect(tokens).toMatch(/--reader-border:/);
    expect(tokens).toMatch(/--reader-backdrop:/);
    expect(tokens).toMatch(/--z-reader-chrome:/);
    expect(tokens).toMatch(/--z-reader-overview:/);
    expect(reader).not.toMatch(/rgb\(255 255 255|rgb\(0 0 0/);
    expect(reader).not.toMatch(/--radius-panel/);
    expect(shell).not.toMatch(/color-mix\([^;]*#000/);
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
    // 自绘标题栏只属于 Windows，且自己吃掉顶部安全区。
    const titlebar = ruleBody(read('src/styles/shell.css'), '.titlebar');
    expect(titlebar).toMatch(/height:\s*calc\(44px \+ var\(--safe-top\)\)/);
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

  it('keeps app-level overlays out of the page’s own stacking contexts', () => {
    // 浮层的 z-index 要真的比底栏大，两边就得在同一个层叠上下文里。页面容器会自己
    // 建层叠上下文——`.library-shell-list` 的 --z-raised 是为了让列表面板压在详情
    // 面板上，`.workspace` 的入场动画曾经留下一个 translateY(0)——手写的全屏浮层
    // 留在里面，z-index 就被关住了，底栏于是永远压在设置菜单 / 检索预设 / 封面预览
    // 之上。Radix 的对话框（Dialog.Portal）和标签建议一直是挂到 body 的，手写浮层
    // 现在也走同一条路。
    const shell = read('src/styles/shell.css');
    const settings = read('src/components/SettingsWorkspace.tsx');
    const preset = read('src/components/SearchPresetField.tsx');

    expect(read('src/components/OverlayLayer.tsx')).toMatch(/createPortal\(children, document\.body\)/);
    expect(settings).toMatch(/<OverlayLayer>\s*<div className="settings-choice-overlay"/);
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
    expect(settings).toContain('model-download-progress');
    expect(settings).toContain('model-download-status');
  });

  it('uses the content surface behind short workspaces instead of exposing canvas', () => {
    const shell = read('src/styles/shell.css');
    const appMain = ruleBody(shell, '.app-main');
    expect(appMain).toMatch(/background:\s*var\(--surface-panel\)/);
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

  it('scrolls the settings menu body instead of clipping a tall form', () => {
    const shell = read('src/styles/shell.css');
    // 面板是 flex 列：只有 flex 会按 max-height 收内容盒，网格的自动行按内容撑开，
    // 长表单会被 overflow:hidden 直接切掉（保存/取消够不着，也无法滚动）。
    const panel = ruleBody(shell, '.settings-choice-panel');
    expect(panel).toMatch(/display:\s*flex/);
    expect(panel).toMatch(/flex-direction:\s*column/);
    expect(panel).toMatch(/max-height:\s*min\(85vh,\s*760px\)/);
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
    // 的内边距，容器只留 4dp）、24dp 图标、标题 title-large（22/28）、底栏容器是
    // surface-container（比顶栏的 surface 高一档）。
    const reader = read('src/styles/reader.css');
    const tokens = read('src/styles/tokens.css');

    expect(tokens).toMatch(/--reader-title-size:\s*22px/);
    expect(tokens).toMatch(/--reader-title-leading:\s*28px/);
    expect(tokens).toMatch(/--reader-toolbar-height:\s*80px/);
    expect(tokens).toMatch(/--reader-primary:\s*#ffb4a9/);
    expect(tokens).toMatch(/--reader-bar-container:/);

    const top = ruleBody(reader, '.reader-chrome-top');
    expect(top).toMatch(/height:\s*calc\(64px \+ var\(--safe-top\)\)/);
    expect(top).toMatch(/padding:\s*var\(--safe-top\)\s+var\(--space-1\)\s+0/);
    // 容器高度是定的，不是 min-height：内容在 64dp 里居中，多一行也不会长高。
    expect(top).not.toMatch(/min-height/);

    const title = ruleBody(reader, '.reader-chrome-top strong');
    expect(title).toMatch(/font-size:\s*var\(--reader-title-size\)/);
    expect(title).toMatch(/font-weight:\s*var\(--weight-regular\)/);
    expect(title).toMatch(/line-height:\s*var\(--reader-title-leading\)/);

    const toolbar = ruleBody(reader, '.reader-toolbar');
    expect(toolbar).toMatch(/height:\s*calc\(var\(--reader-toolbar-height\) \+ var\(--safe-bottom\)\)/);
    expect(toolbar).toMatch(/padding:\s*0 var\(--space-1\) var\(--safe-bottom\)/);
    // IconButtonSpace = 0：动作之间不留缝，间距由每个按钮自己的触控面提供。
    expect(toolbar).toMatch(/gap:\s*0/);
    expect(toolbar).toMatch(/background:\s*var\(--reader-bar-container\)/);

    // 图标按钮是 M3 的 full shape，不是 8px 圆角；图标 24dp。
    expect(ruleBody(reader, '.reader-icon-button,\n.reader-toolbar button')).toMatch(/border-radius:\s*var\(--radius-pill\)/);
    expect(ruleBody(reader, '.reader-error svg,\n.reader-icon-button svg,\n.reader-toolbar svg')).toMatch(/width:\s*24px/);

    // 选中的开关走 M3 standard icon button 的选中态：只有图标换 primary，容器保持
    // 透明。填充式（整块实色）会把一枚控件变成压在画面上的色块。
    const selected = ruleBody(reader, '.reader-toolbar button[aria-pressed="true"]');
    expect(selected).toMatch(/color:\s*var\(--reader-primary\)/);
    expect(selected).not.toMatch(/background/);

    // 概览面板是一枚 M3 对话框：extra-large 圆角 + 24dp 内边距。
    const panel = ruleBody(reader, '.reader-overview');
    expect(panel).toMatch(/border-radius:\s*var\(--radius-overlay\)/);
    expect(panel).toMatch(/padding:\s*var\(--space-6\)/);

    // 页码胶囊压在底栏上，读的是底栏自己的高度令牌，改一边不会让两边错位。
    expect(ruleBody(reader, '.reader-page-indicator.is-raised')).toMatch(/bottom:\s*calc\(var\(--reader-toolbar-height\)/);
  });

  it('keeps the reader chrome on its own fixed dark scheme', () => {
    // 阅读画布两个主题下都是黑的，所以这一层 chrome 只能用 --reader-* 那套固定的
    // 深色方案。引用会随主题翻转的颜色令牌，在浅色主题下就会变成深色落在黑底上：
    // 选中页缩略图的描边（--brand-cyan）、画布焦点环（--focus-ring）都曾如此。
    //
    // 唯一的例外是概览面板（.reader-overview*）：它是一枚对话框，同一个面板还出现
    // 在去重工作区那个跟随主题的对话框里，里面的标签芯片本来就是主题色——所以它跟随
    // 主题，反而必须引用主题角色。把面板的规则剔掉再查。
    const reader = read('src/styles/reader.css');
    const rules = [...reader.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)];
    const chrome = rules.filter(([, selector]) => !(selector ?? '').includes('.reader-overview')).map(([whole]) => whole).join('\n');
    expect(chrome).toMatch(/--reader-chrome/);
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
    const allowedWeights = [400, 500, 600, 700];
    for (const path of ['src/styles/base.css', 'src/styles/shell.css', 'src/styles/reader.css']) {
      const sheet = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      // No raw pixel font sizes anywhere in component CSS.
      expect(sheet).not.toMatch(/font-size:\s*\d+px/);
      for (const [, weight] of sheet.matchAll(/font-weight:\s*(\d+)/g)) {
        expect(allowedWeights).toContain(Number(weight));
      }
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
    // The archive count is UI text, not a monospaced utility string; it renders
    // in a status-bar entry styled with the product font.
    expect(shell).toMatch(/\.status-item\s*\{[^}]*font-family:\s*var\(--font-body\)/);
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
    // resets it and groups by the dated section bars instead.
    expect(shell).toMatch(/\.archive-row-timeline\s*\{[\s\S]*--timeline-rail-center:\s*13px/);
    expect(shell).toMatch(/\.archive-list\.has-timeline\s*\{[\s\S]*right 73px top \/ 2px 100%/);
    expect(shell).toMatch(/\.archive-row-timeline::after\s*\{[\s\S]*left:\s*var\(--timeline-rail-center\)[\s\S]*width:\s*8px[\s\S]*transform:\s*translateX\(-50%\)/);
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
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row-wrap:has\(\.archive-row-timeline\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*82px/);
    // The timeline is rendered as a sibling of the card button, never inside it.
    expect(source).toMatch(/<\/button>[\s\S]{0,400}archive-row-timeline/);
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
    expect(shell).toMatch(/\.search-preset-panel \{[^}]*max-height:\s*min\(70vh, 520px\)/);
    expect(shell).toMatch(/\.settings-choice-panel \{[^}]*max-height:\s*min\(85vh, 760px\)/);
    expect(read('src/components/SettingsRow.tsx')).toMatch(/export function SettingsRow\(/);
    expect(settings).toMatch(/function SettingsChoice\(/);
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
    expect(shell).toMatch(/\.archive-list\.has-timeline\s*\{[^}]*no-repeat right 73px top \/ 2px 100%/);
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
});
