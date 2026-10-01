//! Windows：同一份数据只允许一个进程在跑。
//!
//! 双击两次图标、托盘还在的时候又点一次快捷方式、或者自启之外再手动打开——都会得到
//! 两个进程同时写同一份数据库与同一份图片缓存。这里用内核的具名互斥体判定「已经有
//! 实例在跑」，并且把已经在跑的那个窗口叫到前面：用户按了图标总得看见点反应，否则
//! 看起来就是「点了没反应」。
//!
//! 为什么用互斥体而不是锁文件：进程被强杀/崩溃时锁文件会留下一份假占用，把用户永久
//! 挡在门外；内核对象随进程消亡自动回收。为什么不用 `tauri-plugin-single-instance`：
//! 那要多一个 crate（要联网拉包、要动 lockfile），而 `windows` 本来就是 Windows 目标
//! 的依赖，这条路既离线又复用现成的窗口标题。

use std::sync::atomic::{AtomicUsize, Ordering};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
};

/// 第一个实例拿到的句柄。存成 `usize` 是因为 `HANDLE` 里是裸指针，既不是 `Send` 也不是
/// `Sync`，塞不进 `static`。有意不关：进程活着它就得活着，进程退出时内核自己收走。
static HELD: AtomicUsize = AtomicUsize::new(0);

/// 应用自己的守卫：名字带 `Local\`，只在当前登录会话内生效——同机换用户登录各跑各的，
/// 我们拦的是「同一个桌面上开了两份」。
pub fn claim_app_instance() -> bool {
    claim(w!("Local\\app.yomika.reader.single-instance"))
}

/// 把已经在跑的那个主窗口叫到前面（还原 + 置前）。
pub fn focus_main_window() {
    // 标题必须与 `src-tauri/tauri.conf.json` 里 `main` 窗口的 `title` 一致。
    focus(w!("Yomika"));
}

/// 抢到独占权返回 `true`；已经有实例在跑返回 `false`。
fn claim(name: PCWSTR) -> bool {
    // 建不出来（权限异常之类）时不拦：单实例是体验问题，不该因为它启动不了应用。
    let Ok(handle) = (unsafe { CreateMutexW(None, false, name) }) else {
        return true;
    };
    // 名字已存在时 `CreateMutexW` 照样成功返回句柄，只把最后一个错误码置成 183——
    // 这个错误码就是「已经有实例在跑」的判定依据。
    let taken = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if taken {
        // 重复的这一个句柄马上就用不上了；互斥体本身还活在第一个进程手里，关掉无碍。
        let _ = unsafe { CloseHandle(handle) };
        return false;
    }
    let _ = HELD.compare_exchange(0, handle.0 as usize, Ordering::SeqCst, Ordering::SeqCst);
    true
}

/// 把标题匹配到的窗口还原并置前。找不到就安静收场：叫不动一个窗口，不该拦住
/// 「把重复的那个进程收掉」这件事。
fn focus(title: PCWSTR) {
    let Ok(window) = (unsafe { FindWindowW(PCWSTR::null(), title) }) else {
        return;
    };
    unsafe {
        // 最小化或藏在托盘里的窗口先还原成正常大小，否则置前多半只会闪一下任务栏。
        let _ = ShowWindow(window, SW_RESTORE);
        let _ = SetForegroundWindow(window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_second_instance_is_refused() {
        // 名字带 `.test`：测试进程不该去抢用户正开着的那个应用手里的互斥体。
        // 内核按对象名判重，所以同一进程里问第二次同样会拿到 ERROR_ALREADY_EXISTS，
        // 这正是「第二个实例」的情形。
        assert!(claim(w!("Local\\app.yomika.reader.single-instance.test")));
        assert!(!claim(w!("Local\\app.yomika.reader.single-instance.test")));
    }
}
