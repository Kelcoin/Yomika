//! 把进程的工作集还给操作系统。
//!
//! 增强一页图的内存是这么走的：整页 RGBA（3000×4000 的一页就是 48MB）→ 模型放大
//! 输出（25MP = 256MB）→ 缩回 2× → PNG 编码缓冲。每一步都在调用返回时被释放，
//! Rust 的分配器也确实把页还给了堆，但 Windows 不一定会立刻把这些页从**进程工作集**
//! 里收回去——只在内存吃紧时才收。于是「已经 free」与「任务管理器里还挂着」是两件
//! 事：实测读到后面、退出阅读器之后仍然有 4GB 落不下来，用户看到的就是「退出后内存
//! 依然高达 4G」。
//!
//! `SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX)` 就是让内核
//! 把当前不在用的页全部移出工作集（两个参数都传 `(SIZE_T)-1` 是官方文档里「尽量清空」
//! 的写法），代价是下次碰到这些页要重新软缺页读回来。所以调用点只有一个：**用户离开
//! 阅读器的那一刻**——接下来一段时间反正不会读下一张图，缺页的代价落在没人看的时候。
//!
//! 千万别每页都调。超分的 ONNX 模型和 `nvngx_dlssnr.dll`（约 165MB，加载后从不
//! `FreeLibrary`）都是常驻的，工作集被清空时它们一起走，下一页的
//! 第一张图就要重新从磁盘把这几百 MB 读回来：省下的是任务管理器里的数字，赔上的是
//! 翻页卡顿。
//!
//! 命令挂的是 `#[tauri::command(async)]`：清一个几 GB 的工作集要走内核的页表，不该
//! 压在那条同时管着 `WM_MOVING` 的 UI 线程上（同理见 `src/command_dispatch.rs`）。
//!
//! **离开阅读器时还有另一半要做，它不在这里**：DLSSNR 的工作区与每个 NGX feature 的
//! 资源是按「层数 × 页面积」占**提交内存**的（实测一页 2731×4096 五层 → 提交内存
//! 9.5GB，见 `dlssnr::device::release_cached_workspaces`），清工作集**收不回**提交
//! 内存。所以前端离开阅读器时连着调两条命令：`dlssnr_release_workspaces` 交回纹理、
//! `trim_process_memory` 清工作集。这里刻意不把两件事并进一条命令：清工作集会把那份
//! 165MB 的 DLL 和常驻的 ONNX 模型一起扫出去，而「交回纹理」这件事在别的时候（整本预
//! 处理停下来一会儿）也需要单独做一次。

/// 尽量把当前进程的工作集还给系统。失败就失败——它只是让内存晚点还，不影响正确性。
pub fn trim_working_set() {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Threading::{GetCurrentProcess, SetProcessWorkingSetSize};

        // SAFETY: `GetCurrentProcess` 返回的是伪句柄（-1），不需要也不能关闭；两个
        // `usize::MAX` 就是文档里「尽量清空工作集」的写法。失败时返回 `Err`，这里
        // 刻意不看：清不掉只是内存晚点还，没有任何调用方需要据此做决定。
        let _ = unsafe { SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX) };
    }
    // 其它平台没有等价的系统调用：Linux 的 `madvise(MADV_DONTNEED)` 是按区间、按
    // 映射清的，macOS 的 `malloc_zone_pressure_relief` 是给分配器压力提示——都不是
    // 「把整个进程的工作集交回去」这件事，所以这里留空而不是硬凑一个近似。
}

/// 前端在离开阅读器时调一次（见 `src/components/ReaderRoute.tsx` 里 `pageActive`
/// 变 false 的那个 effect）。
#[tauri::command(async)]
pub fn trim_process_memory() -> crate::domain::result::CommandResult<()> {
    trim_working_set();
    crate::domain::result::CommandResult::success(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trimming_the_working_set_twice_is_harmless() {
        // Windows 上真的调两次 `SetProcessWorkingSetSize`（不能 panic、不能因为
        // 权限或旧系统把结果当成错误抛出来）；其它平台上这就是个空函数，同样不许
        // 出声。这条测试同时钉住「命令体没有额外前提」——它不取库锁、不等子进程、
        // 不碰凭据库，所以从 UI 线程之外任何地方调都是安全的。
        trim_working_set();
        trim_working_set();
    }

    #[test]
    fn the_command_answers_with_nothing() {
        // 前端用 `VoidResponseSchema`（null / undefined）解这条命令的结果：真编成
        // 别的形状，桥那层会把它记成 `INVALID_RESPONSE`。
        match trim_process_memory() {
            crate::domain::result::CommandResult::Success { ok, value } => {
                assert!(ok);
                assert_eq!(value, ());
            }
            crate::domain::result::CommandResult::Failure { error, .. } => {
                panic!("清理工作集没有失败的理由：{}", error.message)
            }
        }
    }
}
