//! Adaptive resource arithmetic; platform sampling is optional.
#[derive(Debug, Clone, Copy)]
pub struct GpuMemory { pub budget_bytes: u64, pub used_bytes: u64 }
#[derive(Debug, Clone, Copy)]
pub struct SystemMemory {
    pub physical_bytes: u64,
    pub available_commit_bytes: u64,
    pub private_commit_bytes: u64,
}
/// Keep a quarter of the OS budget free. Missing telemetry uses a modest working set.
pub fn gpu_available_bytes(memory: Option<GpuMemory>) -> u64 {
    memory.map(|m| m.budget_bytes.saturating_sub(m.used_bytes).saturating_sub(m.budget_bytes / 4))
        .unwrap_or(256 << 20)
}
pub fn auto_tile_size(memory: Option<GpuMemory>, scale: u32, padding: u32, min_edge: u32, fixed: Option<(u32,u32)>) -> u32 {
    if let Some((w,h)) = fixed {
        let constrained = [w,h].into_iter().filter(|edge| *edge > 0).min();
        if let Some(edge) = constrained { return edge.saturating_sub(padding.saturating_mul(2)).max(1); }
    }
    // Activation memory is model-dependent. Start conservatively; allocation recovery below
    // handles models whose hidden tensors exceed this estimate.
    let bytes_per_pixel = 256u64.saturating_mul(u64::from(scale.max(1)).pow(2));
    let edge = ((gpu_available_bytes(memory) / bytes_per_pixel) as f64).sqrt() as u32;
    let edge = edge.saturating_sub(padding.saturating_mul(2));
    (edge / 32 * 32).clamp(min_edge.max(32), 1024.max(min_edge))
}
pub fn next_tile_after_allocation_failure(tile: u32, min_edge: u32, fixed: bool, attempt: u32) -> Option<u32> {
    if fixed || attempt >= 3 || tile <= min_edge.max(32) { return None; }
    Some((tile / 2).max(min_edge.max(32)))
}
pub fn is_allocation_error(error: &crate::error::ComputeError) -> bool {
    let crate::error::ComputeError::InvalidInput(message) = error else { return false; };
    let text = message.to_ascii_lowercase();
    if ["device removed", "device lost", "device hung"].iter().any(|s| text.contains(s)) { return false; }
    ["e_outofmemory", "0x8007000e", "0xbad0000d", "out of memory", "bad_alloc", "failed to allocate", "not enough memory"].iter().any(|s| text.contains(s))
}
#[cfg(windows)]
pub fn system_memory() -> Option<SystemMemory> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::GetCurrentProcess;
    let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
    unsafe {
        GlobalMemoryStatusEx(&mut status).ok()?;
        GetProcessMemoryInfo(GetCurrentProcess(), &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS, std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32).ok()?;
    }
    Some(SystemMemory { physical_bytes: status.ullTotalPhys, available_commit_bytes: status.ullAvailPageFile, private_commit_bytes: counters.PrivateUsage as u64 })
}
#[cfg(not(windows))]
pub fn system_memory() -> Option<SystemMemory> { None }
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tiles_follow_budget_and_current_usage() {
        let low = Some(GpuMemory { budget_bytes: 512 << 20, used_bytes: 400 << 20 });
        let high = Some(GpuMemory { budget_bytes: 24 << 30, used_bytes: 1 << 30 });
        assert!(auto_tile_size(low, 4, 8, 1, None) < auto_tile_size(high, 4, 8, 1, None));
        assert_eq!(auto_tile_size(None, 4, 8, 1, Some((256,256))), 240);
        assert_eq!(auto_tile_size(None, 4, 8, 1, Some((384,256))), 240);
        assert_eq!(auto_tile_size(None, 4, 8, 1, Some((256,0))), 240);
        assert_eq!(next_tile_after_allocation_failure(128, 32, false, 0), Some(64));
        assert_eq!(next_tile_after_allocation_failure(128, 32, false, 3), None);
        assert_eq!(next_tile_after_allocation_failure(128, 32, true, 0), None);
        assert_eq!(next_tile_after_allocation_failure(32, 32, false, 0), None);
    }
    #[test]
    fn only_allocation_errors_are_retryable() {
        use crate::error::ComputeError::*;
        assert!(is_allocation_error(&InvalidInput("ONNX run: E_OUTOFMEMORY".into())));
        assert!(is_allocation_error(&InvalidInput("显存不足（0xBAD0000D）".into())));
        assert!(!is_allocation_error(&Cancelled));
        assert!(!is_allocation_error(&InvalidInput("device removed".into())));
        assert!(!is_allocation_error(&InvalidInput("invalid tensor shape".into())));
    }
}

