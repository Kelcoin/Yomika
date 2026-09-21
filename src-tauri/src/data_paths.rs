use std::{fs, io, path::PathBuf};
#[cfg(not(target_os = "windows"))]
use tauri::Manager;

/// Windows 的数据目录是可执行文件旁边的 `data/`——便携布局，连同程序一起拷走就是
/// 整份资料；其余平台用系统的应用数据目录。只有非 Windows 分支要调 `path()`，所以
/// `Manager` 也跟着那个平台一起进来。
pub fn data_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let executable = std::env::current_exe()?;
        Ok(executable
            .parent()
            .ok_or_else(|| io::Error::other("Executable directory unavailable"))?
            .join("data"))
    }
    #[cfg(not(target_os = "windows"))]
    app.path().app_data_dir().map_err(io::Error::other)
}

/// 建好数据目录，再把随包发布的模型放进去。
///
/// 这里没有从旧 `%APPDATA%\<identifier>` 搬数据的迁移：应用从未正式发布过，不存在
/// 需要照顾的老用户。留一段只为想象中的人服务的搬迁代码，代价是每次启动都多一次
/// 目录扫描，还要靠一个 `storage-layout-v1` 标记来记住"搬过了没有"——标记本身又
/// 成了数据目录里一个没人认识的文件。
pub fn prepare(app: &tauri::AppHandle) -> Result<(), String> {
    let target = data_dir(app).map_err(|error| error.to_string())?;
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    crate::bundled_models::prepare(&target).map_err(|error| error.to_string())
}
