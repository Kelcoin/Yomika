//! Mobile unified-memory sampling. An absent reading is never treated as a
//! desktop-sized machine; the fallback is deliberately modest.

pub fn fallback_ram_bytes() -> u64 {
    2_u64 << 30
}

#[cfg(target_os = "android")]
pub fn physical_ram_bytes() -> Option<u64> {
    parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

#[cfg(any(target_os = "android", test))]
fn parse_meminfo(text: &str) -> Option<u64> {
    let line = text.lines().find(|line| line.starts_with("MemTotal:"))?;
    let mut fields = line.split_whitespace();
    fields.next()?;
    let kb = fields.next()?.parse::<u64>().ok()?;
    if fields.next()? != "kB" {
        return None;
    }
    kb.checked_mul(1024).filter(|bytes| *bytes > 0)
}

#[cfg(target_os = "ios")]
pub fn physical_ram_bytes() -> Option<u64> {
    use std::ffi::{c_char, c_int, c_void};
    unsafe extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            old: *mut c_void,
            old_len: *mut usize,
            new: *mut c_void,
            new_len: usize,
        ) -> c_int;
    }
    let mut bytes = 0_u64;
    let mut len = std::mem::size_of::<u64>();
    // hw.memsize is a read-only u64 on Darwin; buffers live for the call.
    let result = unsafe {
        sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut bytes as *mut u64).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (result == 0 && len == std::mem::size_of::<u64>() && bytes > 0).then_some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_memtotal_only_and_rejects_bad_or_overflowing_readings() {
        assert_eq!(
            parse_meminfo("MemAvailable: 3 kB\nMemTotal: 4194304 kB\n"),
            Some(4_u64 << 30)
        );
        for text in [
            "MemTotal: 0 kB",
            "MemTotal: 12 MB",
            "MemTotal: -1 kB",
            "MemAvailable: 3 kB",
            "MemTotal: 18446744073709551615 kB",
        ] {
            assert_eq!(parse_meminfo(text), None);
        }
        assert_eq!(fallback_ram_bytes(), 2_u64 << 30);
    }
}
