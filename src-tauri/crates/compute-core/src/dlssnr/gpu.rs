//! 显卡探测：跑 DLSSNR 之前要知道这台机器上有没有 NVIDIA 的卡、是哪一代。
//!
//! 判定「能不能用」不靠型号猜：那是 NGX 自己的事（[`crate::dlssnr::ngx`] 用
//! `GetFeatureRequirements` 问 DLL）。这里拿到的是设置页要显示的东西——卡名、
//! 厂商、驱动版本，以及一个用于**提示**（不用于放行）的系列号。
//!
//! [`video_memory`] 也住在这里：显存预算与用量同样是**读数**，不是引擎能力——Task 9
//! 靠它算「还剩多少」，好让宿主在显存吃紧时先丢后台任务（§8.4）。
//!
//! 这一份**不属于引擎那一半**：`detect_gpu` 只调 DXGI（枚举适配器、读描述、查驱动），
//! 不建 D3D12 设备，也不碰 NGX 垫片，所以摘掉 `dlssnr` feature 的宿主仍然要它——「这台
//! 机器有什么卡」是设置页与算力中心都要答的**元数据**（8-g④-b2）。真正必须从宿主进程里
//! 消失的是 `d3d12.dll` 与 NGX 相关的那几项，`dxgi.dll` 留着。`GpuInfo` 这个**数据结构**
//! 也住在元数据那一半（`mod.rs`），因为它要出现在 `DlssnrStatus` 里；这里只借路径，让
//! `gpu::GpuInfo` 这些老名字继续成立。

pub use super::GpuInfo;

/// 显存预算与当前用量（§8.4 的「预留 ≥25%」要有数才算得出来）。
///
/// `budget_bytes` 是**这段预算里我们最多能用多少**（由 DXGI 与系统一起决定，不是显卡总量），
/// `used_bytes` 是**调用进程**在这个适配器上的用量，不含其他进程。
/// 两者都是瞬时值；宿主不能用自己的读数代替计算进程的用量。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoMemory {
    pub budget_bytes: u64,
    pub used_bytes: u64,
}

impl VideoMemory {
    /// 还剩多少可以用。用量超过预算时是 0——负数没有意义。
    pub fn free_bytes(&self) -> u64 {
        self.budget_bytes.saturating_sub(self.used_bytes)
    }
}

/// 问 DXGI 显存还剩多少（`IDXGIAdapter3::QueryVideoMemoryInfo`）。
///
/// 和 [`detect_gpu`] 一样只走 DXGI：不建 D3D12 设备、不碰 NGX，所以它属于**元数据那一半**，
/// 摘掉 `dlssnr` feature 的宿主照样能调（`gpu_reserve_satisfied` 缺的就是这个读数）。
/// 量不到就是 `None`：老驱动没有 `IDXGIAdapter3`、枚举不出卡、查询失败——**不猜一个数**，
/// 让调用方按「没读数就不拦」处理。
#[cfg(windows)]
pub fn video_memory() -> Option<VideoMemory> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
        DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
    };

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    let mut index = 0u32;
    loop {
        // 越界就是枚举完了：没有能答这个问题的卡。
        let adapter = unsafe { factory.EnumAdapters1(index) }.ok()?;
        index += 1;
        let description = match unsafe { adapter.GetDesc1() } {
            Ok(description) => description,
            Err(_) => continue,
        };
        if description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            continue;
        }
        // 和 detect_gpu 认同一块卡：算力是给 N 卡准备的。
        if description.VendorId != 0x10DE {
            continue;
        }
        // IDXGIAdapter3 要 Win10 才有：老驱动上 cast 失败就是量不到。
        let Ok(adapter3) = adapter.cast::<IDXGIAdapter3>() else {
            continue;
        };
        // 本地段（显存），不是非本地段（共享内存）。
        let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
        if unsafe { adapter3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info) }.is_err() {
            continue;
        }
        return Some(VideoMemory {
            budget_bytes: info.Budget,
            used_bytes: info.CurrentUsage,
        });
    }
}

/// Sample the exact DXGI adapter selected by DirectML's device index.
#[cfg(windows)]
pub fn video_memory_for_device_index(index: u32) -> Option<VideoMemory> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    query_adapter_memory(&unsafe { factory.EnumAdapters1(index) }.ok()?)
}

/// D3D12 reports its adapter LUID, so hybrid/multi-GPU PCs never sample a
/// different device's budget. All readings belong to the calling process.
#[cfg(windows)]
pub fn video_memory_for_luid(luid: i64) -> Option<VideoMemory> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    let mut index = 0;
    loop {
        let adapter = unsafe { factory.EnumAdapters1(index) }.ok()?;
        index += 1;
        let desc = unsafe { adapter.GetDesc1() }.ok()?;
        let id = ((desc.AdapterLuid.HighPart as i64) << 32) | desc.AdapterLuid.LowPart as i64;
        if id == luid { return query_adapter_memory(&adapter); }
    }
}

/// WGPU may use Vulkan, where a DXGI LUID is unavailable. Only accept an
/// unambiguous hardware identity, otherwise return an unknown reading.
#[cfg(windows)]
pub fn video_memory_for_identity(name: &str, vendor: u32, device: u32) -> Option<VideoMemory> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    let mut index = 0;
    let mut matched = None;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
        index += 1;
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else { continue; };
        let end = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
        if desc.VendorId == vendor && desc.DeviceId == device && String::from_utf16_lossy(&desc.Description[..end]) == name {
            if matched.is_some() { return None; }
            matched = Some(adapter);
        }
    }
    query_adapter_memory(&matched?)
}

#[cfg(windows)]
fn query_adapter_memory(adapter: &windows::Win32::Graphics::Dxgi::IDXGIAdapter1) -> Option<VideoMemory> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{IDXGIAdapter3, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO};
    let adapter: IDXGIAdapter3 = adapter.cast().ok()?;
    let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
    unsafe { adapter.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info) }.ok()?;
    Some(VideoMemory { budget_bytes: info.Budget, used_bytes: info.CurrentUsage })
}

/// 非 Windows 上没有 DXGI：量不到（`None`），不是「没有压力」。
#[cfg(not(windows))]
pub fn video_memory() -> Option<VideoMemory> {
    None
}

/// 枚举适配器，挑一块 NVIDIA 的回来（多卡机器上第一块即可：NGX 自己也认这一块）。
pub fn detect_gpu() -> Result<Option<GpuInfo>, String> {
    static GPU: std::sync::OnceLock<Option<GpuInfo>> = std::sync::OnceLock::new();
    if let Some(found) = GPU.get() { return Ok(found.clone()); }
    let found = detect_gpu_uncached()?;
    let _ = GPU.set(found.clone());
    Ok(found)
}

fn detect_gpu_uncached() -> Result<Option<GpuInfo>, String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};

    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|error| format!("创建 DXGI 工厂失败：{error}"))?;
    let mut found: Option<GpuInfo> = None;
    let mut index = 0u32;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            // 越界就是枚举完了。
            Err(_) => break,
        };
        index += 1;
        let description = match unsafe { adapter.GetDesc1() } {
            Ok(description) => description,
            Err(_) => continue,
        };
        // 虚拟显示适配器（这台机器上就有两个）与 WARP 都不是我们要的。
        if description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            continue;
        }
        let name = String::from_utf16_lossy(
            &description
                .Description
                .iter()
                .take_while(|unit| **unit != 0)
                .copied()
                .collect::<Vec<u16>>(),
        );
        if name.trim().is_empty() {
            continue;
        }
        let is_nvidia = description.VendorId == 0x10DE;
        let info = GpuInfo {
            series: series_from_name(&name),
            name,
            vendor_id: description.VendorId,
            device_id: description.DeviceId,
            is_nvidia,
            driver: umd_version(&adapter),
            memory_bytes: description.DedicatedVideoMemory as u64,
        };
        if is_nvidia {
            return Ok(Some(info));
        }
        found.get_or_insert(info);
    }
    Ok(found)
}

/// `NVIDIA GeForce RTX 5090` → `Some(50)`；认不出来就是 `None`（不猜）。
fn series_from_name(name: &str) -> Option<u32> {
    let upper = name.to_ascii_uppercase();
    // 「RTX 5090」「RTX 5080」这样：RTX 后面第一位就是这一代（20/30/40/50）。
    // 也接受「RTX PRO 6000」这类没有代号的写法——认不出来就返回 None。
    let rest = upper.split("RTX").nth(1)?;
    let digits: String = rest
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    let first = digits.chars().next()?;
    match first {
        '2' => Some(20),
        '3' => Some(30),
        '4' => Some(40),
        '5' => Some(50),
        _ => None,
    }
}

/// UMD 版本：`CheckInterfaceSupport` 返回的 LARGE_INTEGER 按 NVIDIA 的老规矩拆成
/// 四段（例如 32.0.16.1714）。失败就 `None`——驱动版本只是显示，判定交给 NGX。
fn umd_version(adapter: &windows::Win32::Graphics::Dxgi::IDXGIAdapter1) -> Option<String> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;

    // CheckInterfaceSupport 返回 UMD 版本（NVIDIA 的写法是四段 32.0.16.1714）。
    let raw = unsafe { adapter.CheckInterfaceSupport(&IDXGIDevice::IID) }.ok()? as u64;
    let part = |shift: u32| (raw >> shift) & 0xFFFF;
    Some(format!("{}.{}.{}.{}", part(48), part(32), part(16), part(0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_is_read_from_the_marketing_name() {
        assert_eq!(series_from_name("NVIDIA GeForce RTX 5090 D"), Some(50));
        assert_eq!(series_from_name("NVIDIA GeForce RTX 4070 Ti"), Some(40));
        assert_eq!(series_from_name("NVIDIA GeForce RTX 3080"), Some(30));
        assert_eq!(series_from_name("NVIDIA GeForce RTX 2080 SUPER"), Some(20));
        assert_eq!(series_from_name("NVIDIA GeForce GTX 1080"), None);
        assert_eq!(series_from_name("Intel(R) UHD Graphics 630"), None);
        assert_eq!(series_from_name("NVIDIA RTX PRO 6000 Blackwell"), None);
    }

    #[test]
    fn recommended_variant_follows_the_series() {
        let gpu = |series| GpuInfo {
            name: String::new(),
            vendor_id: 0x10DE,
            device_id: 0,
            is_nvidia: true,
            series,
            driver: None,
            memory_bytes: 0,
        };
        assert_eq!(gpu(Some(50)).recommended_variant(), Some(crate::dlssnr::Variant::Official));
        assert_eq!(gpu(Some(40)).recommended_variant(), Some(crate::dlssnr::Variant::Community40));
        assert_eq!(gpu(Some(30)).recommended_variant(), Some(crate::dlssnr::Variant::SfV2));
        assert_eq!(gpu(Some(20)).recommended_variant(), Some(crate::dlssnr::Variant::SfV2));
        assert_eq!(gpu(None).recommended_variant(), None);
    }

    #[test]
    fn the_video_memory_budget_is_readable_on_this_machine() {
        // 这台机器有卡，所以读数必须真的出来：量不到就是我们没读对，而不是「这机器没卡」。
        let memory = video_memory().expect("这台机器有 NVIDIA 卡，DXGI 该答得出显存预算");
        println!(
            "vram: budget={} used={} free={}",
            memory.budget_bytes,
            memory.used_bytes,
            memory.free_bytes()
        );
        assert!(memory.budget_bytes > 0, "预算不可能是 0：{memory:?}");
        // 用量**可以**超过预算（这台机器上别的进程也在用），所以只钉换算关系。
        assert_eq!(
            memory.free_bytes(),
            memory.budget_bytes.saturating_sub(memory.used_bytes),
            "剩下的显存得是「预算减用量」，且被压到 0 以下时是 0"
        );
    }

    #[test]
    fn detection_reports_this_machine_without_failing() {
        // 没有卡也不该报错——「没找到 NVIDIA 卡」是一个正常答案。
        let found = detect_gpu().expect("enumerating adapters must not fail");
        if let Some(gpu) = found {
            println!(
                "adapter: {} (nvidia={}, series={:?}, driver={:?})",
                gpu.name, gpu.is_nvidia, gpu.series, gpu.driver
            );
            assert!(!gpu.name.trim().is_empty());
        } else {
            println!("no adapter found");
        }
    }
}
