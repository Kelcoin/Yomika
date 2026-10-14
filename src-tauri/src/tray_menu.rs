//! 托盘右键菜单：一个应用自己画的小窗口。
//!
//! 原来是 `MenuBuilder` + `TrayIconBuilder::menu`，也就是让系统画。系统菜单有两处改不了
//! （用户 2026-09-30 报的）：宽度由系统按「图标栏 + 内边距」算出来，两个双字条目也要
//! 一百二十来像素；悬停高亮是矩形，和圆角边框对不上。这两件事都只能自己画。
//!
//! 所以这里是一个 84×62 的无边框透明窗口（尺寸和 `styles/tray-menu.css` 一一对应，
//! 契约测试盯着这一对），`tray-menu.html` 那个入口渲染两条菜单项。定位是纯几何，单独
//! 测（`menu_origin`）。

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::domain::result::CommandResult;

/// 菜单窗口的标签。`lib.rs` 的窗口事件里也按它认人。
pub const MENU_WINDOW: &str = "tray-menu";
/// 逻辑像素。CSS 里菜单是 `position: fixed; inset: 0`，也就是铺满整个窗口；两条 26px
/// 的条目 + 容器 4px 内边距 + 1px 边框 = 62，所以窗口也是 62 高——多一像素就是底下多一条
/// 透明边，少一像素就是边框被切掉。
///
/// 这两个数曾经是 96×74（32px 的条目、14px 的字号）：用户 2026-09-30 报「菜单太大」——
/// 一个双字条目在 13px 字号下只有 26px 宽的文字，其余都是空处，于是整块收到 84×62。
pub const MENU_WIDTH: f64 = 84.0;
pub const MENU_HEIGHT: f64 = 62.0;

/// 菜单左上角的位置（物理像素）。
///
/// 默认从光标**向左上**展开——托盘在右下角，往这两个方向才是屏幕里侧。放不下就翻到
/// 光标另一侧（任务栏可以在上边或左边），最后无论如何夹进这个显示器的范围，绝不把菜单
/// 放到看不见的地方。
pub fn menu_origin(
    cursor: (f64, f64),
    size: (f64, f64),
    bounds: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (cx, cy) = cursor;
    let (width, height) = size;
    let (left, top, right, bottom) = bounds;
    let mut x = cx - width;
    let mut y = cy - height;
    if x < left {
        x = cx;
    }
    if y < top {
        y = cy;
    }
    let max_x = (right - width).max(left);
    let max_y = (bottom - height).max(top);
    (x.clamp(left, max_x), y.clamp(top, max_y))
}

/// 建好那个隐藏的菜单窗口。桌面端启动时一次。
pub fn install(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    // 这条链里只有这几个选项是跨平台的；最大化 / 最小化 / 系统装饰 / 阴影 / 任务栏 /
    // 置顶都在 tauri 的 `#[cfg(desktop)] impl WebviewWindowBuilder` 里，Android 目标
    // 编不过。这个窗口只在 Windows 装（`install` 的调用点在 `lib.rs` 的 Windows
    // 分支），但模块本身是跨平台编的，所以两截要分开写。
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, MENU_WINDOW, WebviewUrl::App("tray-menu.html".into()))
        .title("")
        .inner_size(MENU_WIDTH, MENU_HEIGHT)
        .resizable(false)
        // 透明：12px 圆角之外必须是桌面本身，不然四角会带一块底色。
        .transparent(true)
        .visible(false);
    #[cfg(desktop)]
    {
        builder = builder
            .maximizable(false)
            .minimizable(false)
            .decorations(false)
            .shadow(false)
            .skip_taskbar(true)
            .always_on_top(true);
    }
    let window = builder.build()?;
    // **创建**时的尺寸会被系统夹到 `SM_CXMINTRACK`（这台机器上 96 DPI 下实测 136×39，
    // 150% 缩放下是 202×56），所以上面那句 `inner_size(84, 62)` 建出来其实是 **136×62**
    // ——菜单铺满窗口就成了一条 136 宽的菜单，比系统菜单（约 121）还宽，正好是用户要修的
    // 那一条。`SetWindowPos` 不受这个下限约束（实测把它压到 84×62 成功），所以建好之后再
    // 显式设一次。
    let _ = window.set_size(tauri::LogicalSize::new(MENU_WIDTH, MENU_HEIGHT));
    Ok(window)
}

/// 在光标处弹出。位置按 `menu_origin` 算，超出显示器就夹回来。
pub fn show_at(app: &AppHandle, cursor: PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window(MENU_WINDOW) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = (MENU_WIDTH * scale, MENU_HEIGHT * scale);
    let bounds = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .map(|monitor| {
            let position = monitor.position();
            let area = monitor.size();
            (
                f64::from(position.x),
                f64::from(position.y),
                f64::from(position.x) + f64::from(area.width),
                f64::from(position.y) + f64::from(area.height),
            )
        });
    if let Some(bounds) = bounds {
        let (x, y) = menu_origin((cursor.x, cursor.y), size, bounds);
        let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }
    let _ = window.show();
    // 取焦点有两个用处：Esc 与方向键要能进到页面里，而且失焦就是「点到别处了」。
    let _ = window.set_focus();
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MENU_WINDOW) {
        let _ = window.hide();
    }
}

/// 菜单要跟随应用主题：这是个独立窗口，拿不到主窗的 `data-theme`，所以自己问一次。
/// 每次重新可见时也会再问（主题可能在主窗里刚改过）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuState {
    theme: String,
}

/// async：它要读一次库（主题）。同步命令体是在 WebView2 的 UI 线程上就地跑的，而全局
/// 库锁可能正被某个慢的后台持有者握着——菜单弹出来不该等那一下。`command_dispatch` 的
/// 不变量测试盯着这一条（`tray_menu.rs` 已经进了它的文件清单）。
#[tauri::command(async)]
pub fn tray_menu_state(app: AppHandle) -> CommandResult<TrayMenuState> {
    let theme = app
        .try_state::<crate::db::Database>()
        .and_then(|database| {
            let connection = database.connection.lock().ok()?;
            crate::settings::load_preferences_from(&connection).ok()
        })
        .map(|snapshot| snapshot.theme)
        .unwrap_or_else(|| "system".to_string());
    CommandResult::success(TrayMenuState { theme })
}

/// 选了哪一条。窗口先藏起来再做动作——`quit` 之后这个窗口已经不在了。
#[tauri::command]
pub fn tray_menu_choose(app: AppHandle, action: String) -> CommandResult<()> {
    hide(&app);
    match action.as_str() {
        "show" => {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                // `unminimize` 同样只在桌面端存在。
                #[cfg(desktop)]
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
            CommandResult::success(())
        }
        "quit" => {
            app.exit(0);
            CommandResult::success(())
        }
        _ => CommandResult::failure("INVALID_RESPONSE", "未知的托盘菜单动作", false),
    }
}

/// 点到别处 / 按 Esc：只藏窗口，不做动作。
#[tauri::command]
pub fn tray_menu_dismiss(app: AppHandle) -> CommandResult<()> {
    hide(&app);
    CommandResult::success(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一块 1920×1080 的显示器，托盘在右下角。
    const SCREEN: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);

    #[test]
    fn opens_up_and_to_the_left_of_the_cursor() {
        // 任务栏在右下角：菜单落在光标左上方，也就是屏幕里侧。
        assert_eq!(menu_origin((1900.0, 1070.0), (84.0, 62.0), SCREEN), (1816.0, 1008.0));
    }

    #[test]
    fn flips_to_the_other_side_when_the_corner_has_no_room() {
        // 任务栏在左上角：往左上没有空间，翻到光标右侧与下方。
        assert_eq!(menu_origin((4.0, 4.0), (84.0, 62.0), SCREEN), (4.0, 4.0));
        // 左边缘但下方有空间：横向翻、纵向仍然往上。
        assert_eq!(menu_origin((4.0, 900.0), (84.0, 62.0), SCREEN), (4.0, 838.0));
    }

    #[test]
    fn never_leaves_the_monitor() {
        // 屏幕比菜单还窄：夹到左上角，而不是算出一个负坐标。
        let tiny = (0.0, 0.0, 40.0, 30.0);
        assert_eq!(menu_origin((20.0, 15.0), (84.0, 62.0), tiny), (0.0, 0.0));
        // 负坐标的显示器（副屏在主屏左边）：往左上展开仍在屏内，所以不翻边。
        let left_monitor = (-1920.0, 0.0, 0.0, 1080.0);
        assert_eq!(menu_origin((-20.0, 1070.0), (84.0, 62.0), left_monitor), (-104.0, 1008.0));
        // 该显示器右边缘附近往左上展开：-94..-10 本来就在屏内，不需要夹。
        assert_eq!(menu_origin((-10.0, 1070.0), (84.0, 62.0), left_monitor), (-94.0, 1008.0));
        // 真正的夹边只有「显示器比菜单还小」这种退化情形：翻边之后仍然放不下，
        // 于是被夹到左上角，而不是返回一个屏外坐标。
        let narrow = (0.0, 0.0, 60.0, 40.0);
        assert_eq!(menu_origin((55.0, 30.0), (84.0, 62.0), narrow), (0.0, 0.0));
    }

    #[test]
    fn the_window_matches_the_stylesheet() {
        // 尺寸是 Rust 与 CSS 两处写死的同一件事：对不上就是菜单被裁一半或四周多一块
        // 透明边。CSS 那份由 design-system-contract.test.ts 一起盯着。
        let css = include_str!("../../src/styles/tray-menu.css");
        assert!(css.contains("inset: 0"), "菜单容器要铺满窗口：{css}");
        assert_eq!(MENU_WIDTH, 84.0);
        assert_eq!(MENU_HEIGHT, 62.0);
    }

    /// 托盘位图是母版 `assets/yomika-mark.svg` 的派生件（`icons/tray-32.png`，与
    /// `icons/32x32.png` 逐字节相同），不是另一张画。这条测试盯的是「它编进来了、
    /// 解得开、而且不是空的」——路径写错、`image-png` 特性掉了、资源被挪走，都会在这里断。
    #[test]
    fn the_embedded_tray_bitmap_decodes_to_a_non_empty_icon() {
        let image = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-32.png"))
            .expect("托盘位图应当能解码");
        assert_eq!((image.width(), image.height()), (32, 32), "托盘位图应当是 32×32");
        let rgba = image.rgba();
        assert_eq!(rgba.len(), 32 * 32 * 4);
        // 与 `icons/32x32.png` 必须是同一份字节：派生链只写一处，谁手工抄回第二份画、
        // 或者只重生成了其中一份，这条就会断。
        assert_eq!(
            include_bytes!("../icons/tray-32.png") as &[u8],
            include_bytes!("../icons/32x32.png") as &[u8],
            "托盘位图与 32×32 应用图标必须是同一份字节"
        );
        // 必须有真正画上去的像素，而且不能是一块实心圆角方（那样就成了一个色块）。
        // 门槛是量出来的（工装 debug_outputs/logo-audit/png-ink.mjs，真像素）：
        // 2026-10-14 这一份母版（阅读印记）在 32px 上是 **130** 个可读墨色像素、16px 上 28 个；
        // 被它换掉的那一版描边母版派生的位图在 32px 上只有 **69** 个、16px 上是 **0** 个
        // （笔画 10/512 落到 32px 是 0.31px，抗锯齿之后全糊成灰）。所以谁把描边版抄回母版，
        // `ink > 100` 会直接失败。
        let opaque = rgba.chunks_exact(4).filter(|pixel| pixel[3] > 200).count();
        let ink = rgba.chunks_exact(4).filter(|pixel| pixel[3] > 200 && pixel[0] > 200).count();
        assert!(opaque > 400, "盘子不该是空的：{opaque} 个不透明像素");
        assert!(ink > 100, "字形不该消失：{ink} 个亮色像素（旧描边版只有 69）");
        assert!(ink < opaque / 2, "字形不该糊满整块盘子：{ink}/{opaque}");
    }

    /// 托盘字形的留白规则（2026-10-14 换成「阅读印记」母版之后重写）。
    ///
    /// 旧母版（几何印记）那一条钉的是「平直侧（左）的空气必须多于圆点侧（右）」——那是
    /// 那一版形状特有的光学性质（满高平直的脊看起来比圆点更靠边）。换成一本书之后左右
    /// 都成了弧线，那一条不再成立，于是这条测试改成钉这一版真正承诺的东西：
    ///
    /// - 字形不许贴到盘子边上：32px 上四边各留 **≥6px**（真像素量出来是 7/8/7/8）；
    /// - 字形不许缩成一小团：墨盒至少 14×14（量出来 18×16@7,8）；
    /// - 盘子铺满整张位图（0,0,31,31）——母版那个圆角方是满幅的，不许把字形缩回盘子里。
    ///
    /// 门槛都是真像素量出来的（工装 `debug_outputs/logo-audit/png-ink.mjs`），
    /// 变异检查用两版历史位图证明它有牙：换成上一版实心母版派生的位图（墨盒 22×24、
    /// 四边 6/4/4/4）会在这里断，换成更早那版描边母版派生的位图（32px 只有 69 个墨色
    /// 像素）会在上一条 `ink > 100` 断。
    #[test]
    fn the_tray_glyph_keeps_air_on_every_side() {
        fn bounds(
            width: usize,
            height: usize,
            hit: impl Fn(usize, usize) -> bool,
        ) -> (usize, usize, usize, usize) {
            let mut found = (width, height, 0, 0);
            for y in 0..height {
                for x in 0..width {
                    if hit(x, y) {
                        found.0 = found.0.min(x);
                        found.1 = found.1.min(y);
                        found.2 = found.2.max(x);
                        found.3 = found.3.max(y);
                    }
                }
            }
            found
        }

        let image = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-32.png"))
            .expect("托盘位图应当能解码");
        let (width, height) = (image.width() as usize, image.height() as usize);
        let rgba = image.rgba();

        let plate = bounds(width, height, |x, y| rgba[(y * width + x) * 4 + 3] > 8);
        let ink = bounds(width, height, |x, y| {
            let pixel = &rgba[(y * width + x) * 4..][..4];
            pixel[3] > 200 && pixel[0] > 200
        });
        assert_eq!(plate, (0, 0, 31, 31), "盘子应当铺满整张位图：{plate:?}");

        let sides = [
            ink.0 - plate.0,
            ink.1 - plate.1,
            plate.2 - ink.2,
            plate.3 - ink.3,
        ];
        for (name, side) in ["左", "上", "右", "下"].iter().zip(sides) {
            assert!(
                side >= 6,
                "{name}边的留白太小：{side}px（四边 {sides:?}）"
            );
        }
        let glyph = (ink.2 - ink.0 + 1, ink.3 - ink.1 + 1);
        assert!(
            glyph.0 >= 14 && glyph.1 >= 14,
            "字形盒太小，缩成一团了：{glyph:?}（四边 {sides:?}）"
        );
        // 这条用的是本文件自己的墨色谓词（alpha>200 && red>200），与工装 `png-ink.mjs`
        // 的 luma 规则差一行，所以这里记的是**这条测试量到的**数：墨盒 18×15、四边 7/8/7/9。
        assert_eq!(glyph, (18, 15), "这一版母版的墨盒应当是 18×15（本谓词量到）");
    }
}
