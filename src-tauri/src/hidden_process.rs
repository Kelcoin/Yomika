//! 从宿主里拉起**控制台程序**（`reg.exe` 这类）时的唯一入口。
//!
//! 为什么必须有这么一个入口：宿主自己编译成 GUI 子系统
//! （`src/main.rs` 的 `windows_subsystem = "windows"`），进程里**没有控制台**；而
//! `reg.exe` 是控制台子系统。父进程没有控制台、子进程自己又是控制台子系统、又不带
//! `CREATE_NO_WINDOW` 时，Windows 会**给子进程新开一个控制台窗口**——它只在命令跑完
//! 之前存在，用户看到的就是「启动程序时先闪一个来源不明的窗口」。主窗要等首帧画完
//! 才 `show()`（`index.html` 的品牌帧 → `frontend_ready`），所以那个窗口一定出现在
//! 主窗**之前**。启动路径上唯一一条这样的命令是 `lib.rs` 里的开机自启对账
//! （`settings::reconcile_windows_autostart` → `reg query`），写/删那两条分支上还有
//! 第二条。`manager` 里拉起 worker 用的 `hide_console` 也是同一个标志，它现在从这里
//! 走，于是全仓只有一个地方能忘了加它。
//!
//! 这一条为什么躲得过测试：`cargo test` 自己跑在控制台里，子进程继承父进程的控制台，
//! **不会**新开窗口——只有宿主那种「没有控制台的 GUI 进程」才会。所以判据不能只看
//! 「命令跑起来没有」，得看子进程有没有控制台：本文件底下那条
//! `a_child_started_this_way_has_no_console_window` 让子进程（`the_child_reports_whether_it_has_a_console`）
//! 自己报告 `GetConsoleWindow()`，并且做一次反向对照。
//!
//! 结论：**别再让任何调用点自己记得加那个标志。**

use std::process::Command;

/// 准备一条控制台程序的命令行。Windows 上带 `CREATE_NO_WINDOW`，别的平台上就是普通
/// 的 `Command`（那里的「闪一个窗口」不是同一个问题）。
pub fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    hide_console(&mut command);
    command
}

/// 给一条已经配好的命令行补上「不要窗口」。非 Windows 上是空操作。
///
/// 与 [`command`] 的关系：`command` 只负责「从程序名新建一条」，已经在配别的参数
/// （比如 worker 那一长串）的地方用这个。
#[cfg(windows)]
pub fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    /// 子进程不要控制台窗口（`winbase.h`）。少了它，GUI 宿主拉起的控制台程序
    /// 会自己长出一个窗口闪一下。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console(_command: &mut Command) {}

#[cfg(all(test, windows))]
mod tests {
    /// 带上那个标志之后命令照样要真跑：`CREATE_NO_WINDOW` 是「不要窗口」，不是
    /// 「不要执行」。这一条钉的是「加标志没把命令弄坏」。
    #[test]
    fn a_registry_query_through_this_entry_still_runs() {
        let output = super::command("reg.exe")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "Yomika",
            ])
            .output()
            .expect("拉起 reg.exe");
        // 值在不在都行（这台机器上多半没有）；要的是它正常结束、留下了一份输出。
        assert!(output.status.code().is_some(), "reg.exe 没有正常结束");
    }

    /// 子进程那一半：把自己有没有控制台打出来，父进程那一条靠这一行取证。
    ///
    /// 它**只作为子进程**被跑（父进程用 `--exact` 点名），单独跑没有任何断言——
    /// 「子进程的报告是不是真的」由父进程那一条里的反向对照来钉。
    #[test]
    fn the_child_reports_whether_it_has_a_console() {
        use windows::Win32::System::Console::GetConsoleWindow;
        let window = unsafe { GetConsoleWindow() };
        println!(
            "YOMIKA_CONSOLE_WINDOW={}",
            if window.0.is_null() { "none" } else { "some" }
        );
    }

    /// 缺陷形态那一半的对照：一条**确定**带控制台的命令行。
    ///
    /// 直接用 `std::process::Command` 是不够的——子进程有没有控制台取决于**父进程**
    /// 有没有：在终端里跑测试时它继承父进程那个（于是这条对照不会在终端里闪窗口），
    /// 而 `cargo test` 被一个没有控制台的程序拉起时（CI、被别的工具驱动、无控制台的
    /// runner），缺陷形态也会报 `none`，判据就退化成「在这台机器上量不到东西」。
    /// 父进程没有控制台时改用 `CREATE_NEW_CONSOLE` 显式要一个，对照与被测路径之间
    /// 始终有确定的区别。
    fn defect_shaped_command(exe: &str, args: &[&str]) -> std::process::Command {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Console::GetConsoleWindow;
        /// 给子进程新开一个控制台（`winbase.h`）。
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let parent_has_console = unsafe { !GetConsoleWindow().0.is_null() };
        let mut command = std::process::Command::new(exe);
        command.args(args);
        if !parent_has_console {
            command.creation_flags(CREATE_NEW_CONSOLE);
        }
        command
    }

    /// 判据（缺陷 2）：从这一路拉起的控制台程序，**不许给自己长出一个控制台窗口**。
    ///
    /// 两个方向一起量：生产入口必须报 `none`，而「直接 `Command::new`」这个缺陷形态
    /// 必须报 `some`。少了后半句，前半句在一条量不到东西的机器上也会绿——那就是把
    /// 「没量到」当成了「量过」。缺陷形态的构造见 [`defect_shaped_command`]。
    #[test]
    fn a_child_started_this_way_has_no_console_window() {
        let exe = std::env::current_exe().expect("当前测试二进制");
        let exe = exe.to_str().expect("测试二进制路径").to_string();
        let child = "hidden_process::tests::the_child_reports_whether_it_has_a_console";
        let args = ["--exact", child, "--nocapture"];

        let ours = super::command(&exe)
            .args(args)
            .output()
            .expect("拉起子进程（生产入口）");
        let ours = String::from_utf8_lossy(&ours.stdout).to_string();
        assert!(
            ours.contains("YOMIKA_CONSOLE_WINDOW=none"),
            "这一路拉起的子进程长了控制台窗口——宿主自己没有控制台，它就是启动时先闪的那个窗口：{}",
            ours.trim()
        );

        let defect = defect_shaped_command(&exe, &args)
            .output()
            .expect("拉起子进程（缺陷形态）");
        let defect = String::from_utf8_lossy(&defect.stdout).to_string();
        assert!(
            defect.contains("YOMIKA_CONSOLE_WINDOW=some"),
            "不带 `CREATE_NO_WINDOW` 也报「没有控制台」，说明这条判据在这台机器上量不到东西：{}",
            defect.trim()
        );
    }
}
