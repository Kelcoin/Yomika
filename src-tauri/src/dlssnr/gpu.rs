//! 显卡探测：跑 DLSSNR 之前要知道这台机器上有没有 NVIDIA 的卡、是哪一代。
//!
//! 判定「能不能用」不靠型号猜：那是 NGX 自己的事（[`crate::dlssnr::ngx`] 用
//! `GetFeatureRequirements` 问 DLL）。这里拿到的是设置页要显示的东西——卡名、
//! 厂商、驱动版本，以及一个用于**提示**（不用于放行）的系列号。

/// 一块适配器的信息。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GpuInfo {
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub is_nvidia: bool,
    /// 20 / 30 / 40 / 50 —— 只从卡名里读出来给提示用；NGX 的判定才是准的。
    pub series: Option<u32>,
    /// UMD 版本（例如 `32.0.16.1714`），DXGI 的 `CheckInterfaceSupport` 给的。
    pub driver: Option<String>,
    /// 显存（字节）。
    pub memory_bytes: u64,
}

impl GpuInfo {
    /// 这一代卡用社区包里哪一种 DLL（README 的对应关系）：
    /// 50 系官方原版即可，40 系要社区兼容版，20/30 系要 FP16 兼容版。
    pub fn recommended_variant(&self) -> Option<crate::dlssnr::Variant> {
        match self.series {
            Some(50) => Some(crate::dlssnr::Variant::Official),
            Some(40) => Some(crate::dlssnr::Variant::Community40),
            Some(20) | Some(30) => Some(crate::dlssnr::Variant::SfV2),
            _ => None,
        }
    }
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
