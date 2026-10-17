//! NGX 的绑定：把 `nvngx_dlssnr.dll` 当数据加载，参数对象自己实现。
//!
//! 两条路并存：
//!
//! * **核心**（`NgxCore`）：NGX 的客户端实现，来自 DLSS SDK 的静态库，经一层小垫片
//!   DLL 调进来（为什么垫一层见 `vendor/ngx/ngx_shim.c` 与它的 README）。
//! * **片段**（`DlssnrRuntime`）：`nvngx_dlssnr.dll` 运行时 `LoadLibraryExW` 进来，
//!   用到的五个导出按名字取。这一条现在只作备用与排查（调用者检查那一段就是它逼出
//!   来的），正常路径把片段交给核心加载。
//!
//! 唯一需要自己写的是 **参数对象**：`NVSDK_NGX_Parameter` 是一个 C++ 纯虚接口
//! （17 个虚函数，顺序见下方 `ParameterVtable`），NGX 通过它读我们给的一切。
//! 接口布局抄自公开的 `nvsdk_ngx_params.h`；**改这张表之前先对一遍那份头**——
//! 虚表错一个位置就是一次崩溃，而且崩在 DLL 里，栈上看不出是我们传错了对象。
//!
//! 片段有一条硬性要求：它只肯为名叫 `nvngx.dll` 的调用者工作。直接调它时 `load()`
//! 会给片段自己的导入表打一个补丁（见下面「调用者兼容层」一节）——不补这一步，
//! `Init_Ext` 与 `GetFeatureRequirements` 一律以 `PlatformError` 收场（本机实测
//! `0xBAD00002`）。走核心那条路时核心就是它认的调用者，不需要这一层。

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;
use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
use std::sync::Mutex;

use windows::core::{Interface, PCSTR, PCWSTR};
use windows::Win32::Foundation::{
    FreeLibrary, HMODULE, SetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_FUNCTION,
};
use windows::Win32::Graphics::Direct3D12::ID3D12Device;
use windows::Win32::System::Diagnostics::Debug::FlushInstructionCache;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::LibraryLoader::{
    GetModuleHandleExW, GetProcAddress, LoadLibraryExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
};
use windows::Win32::System::Memory::{VirtualProtect, PAGE_PROTECTION_FLAGS, PAGE_READWRITE};
use windows::Win32::System::Threading::GetCurrentProcess;

/// `NVSDK_NGX_Result`：`0x1` 成功，`0xBAD00000 | code` 失败。
pub type NgxResult = u32;
pub const NGX_SUCCESS: NgxResult = 0x0000_0001;
pub const NGX_FAIL_MASK: NgxResult = 0xBAD0_0000;
/// `NVSDK_NGX_Version_API`（`NVSDK_NGX_VERSION_API_MACRO`，1.5.0）。
pub const NGX_VERSION_API: u32 = 0x0000_0015;
/// DLSSNR 在 `NVSDK_NGX_Feature` 里是第 18 号（`Feature_Reserved18`，尚未公开命名）。
pub const FEATURE_DLSSNR: i32 = 18;
/// dlssnr 片段的签名应用号。
pub const DLSSNR_APPLICATION_ID: u64 = 0x0876_232C;

pub fn succeeded(result: NgxResult) -> bool {
    result & 0xFFF0_0000 != NGX_FAIL_MASK
}

/// 把结果码翻成人话：失败码是 `0xBAD00000 | n`，`n` 的含义写在
/// `nvsdk_ngx_defs.h` 的 `NVSDK_NGX_Result` 里。
pub fn describe(result: NgxResult) -> String {
    if succeeded(result) {
        return format!("成功（0x{result:08X}）");
    }
    let code = result & 0x000F_FFFF;
    let reason = match code {
        1 => "这个功能在当前系统/硬件/图形 API 上不支持",
        2 => "平台错误（驱动、系统库或 NvAPI）",
        3 => "同样的功能实例已经存在",
        4 => "找不到对应的功能句柄",
        5 => "参数缺失或类型不对",
        6 => "暂存缓冲区太小",
        7 => "NGX 尚未初始化",
        8 | 14 => "输入缓冲区格式不支持",
        9 => "输出缓冲区缺少读写标志（UAV）",
        10 => "缺少必需的输入",
        11 => "初始化功能失败（很可能找不到它需要的库）",
        12 => "驱动或功能库版本过旧",
        13 => "显存不足",
        15 => "应用数据目录不可写",
        16 => "参数值不受支持",
        17 => "当前应用被 NVIDIA 限制使用该功能",
        18 => "当前版本尚未实现",
        _ => "未列出的失败",
    };
    format!("{reason}（0x{result:08X}）")
}

// ── NGX 的结构体 ─────────────────────────────────────────────────────────────
// 全部按 `nvsdk_ngx_defs.h` 的字段顺序手写；这些是 C ABI 结构，字段顺序与宽度
// 都不能动，下面那组断言把它们钉在头文件上。

#[repr(C)]
#[derive(Clone, Copy)]
struct PathListInfo {
    path: *const *const u16,
    length: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct LoggingInfo {
    callback: *const c_void,
    minimum_level: i32,
    disable_other_sinks: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct FeatureCommonInfo {
    path_list_info: PathListInfo,
    internal_data: *mut c_void,
    logging_info: LoggingInfo,
}

const _: () = {
    assert!(std::mem::size_of::<PathListInfo>() == 16);
    assert!(std::mem::size_of::<LoggingInfo>() == 16);
    assert!(std::mem::size_of::<FeatureCommonInfo>() == 40);
};

// ── 参数对象 ─────────────────────────────────────────────────────────────────

/// `NVSDK_NGX_Parameter` 的虚表：17 个虚函数，顺序抄自公开的 `nvsdk_ngx_params.h`。
///
/// 参数对象**由 NGX 核心分配**（`NVSDK_NGX_D3D12_AllocateParameters`）：我们不实现
/// 这个接口，只按名字调它
/// ——调用时从对象自己的头 8 字节取出虚表（C++ 的对象布局），用它的表调它。这样即
/// 使 NGX 的实现比这张表多几个方法也只多在我们看不到的表尾；索引 0..16 的含义由
/// NGX 自己的表保证。
///
/// 改这张表的顺序前先对一遍 `nvsdk_ngx_params.h`：错一位就是把 `Set` 当 `Get` 调，
/// 崩在 DLL 里，栈上看不出是我们传错了。下面那组 `offset_of!` 断言把顺序钉住。
///
/// 重载不能混：`Set` 有 8 个重载（u64/f64/f32/u32/i32/D3D11/D3D12/void*），NGX 按
/// 重载记下值的类型，`Get` 那边也按类型取：**写进去用什么重载，片段就得用什么重载读**。
/// 所以尺寸走 `unsigned`、布尔与枚举走 `int`、比例走 `float`，别按自己顺手的来。
#[repr(C)]
struct ParameterVtable {
    // 槽位顺序是**实测**出来的，不是照着头文件猜的：`Set` 家族 0..7、`Get` 家族 8..15，
    // 两个资源格夹在 u64 和整数之间。证据：
    //  · 把 1.75f 写进槽位 6、用槽位 14 读回来正好是 1.75（float 的存取就在这两格），
    //    片段自己读 Intensity/MVecScale 用的也正是槽位 14；
    //  · 槽位 0/3/4/7 分别能吃 u64/u32/i32/裸指针（`Width=160`、`PerfQualityValue=1`
    //    这些值片段在创建时确确实实读到了，说明这几格没记错）；
    //  · 片段读资源走的是 u64 那一格，见 `filter.rs` 里 `DLSSNR.Color` 的说明。
    set_u64: unsafe extern "system" fn(*mut c_void, *const c_char, u64),
    set_d3d11: unsafe extern "system" fn(*mut c_void, *const c_char, *mut c_void),
    set_d3d12: unsafe extern "system" fn(*mut c_void, *const c_char, *mut c_void),
    set_u32: unsafe extern "system" fn(*mut c_void, *const c_char, u32),
    set_i32: unsafe extern "system" fn(*mut c_void, *const c_char, i32),
    set_f64: unsafe extern "system" fn(*mut c_void, *const c_char, f64),
    set_f32: unsafe extern "system" fn(*mut c_void, *const c_char, f32),
    set_pointer: unsafe extern "system" fn(*mut c_void, *const c_char, *mut c_void),
    get_u64: unsafe extern "system" fn(*const c_void, *const c_char, *mut u64) -> NgxResult,
    get_d3d11: unsafe extern "system" fn(*const c_void, *const c_char, *mut *mut c_void) -> NgxResult,
    get_d3d12: unsafe extern "system" fn(*const c_void, *const c_char, *mut *mut c_void) -> NgxResult,
    get_u32: unsafe extern "system" fn(*const c_void, *const c_char, *mut u32) -> NgxResult,
    get_i32: unsafe extern "system" fn(*const c_void, *const c_char, *mut i32) -> NgxResult,
    get_f64: unsafe extern "system" fn(*const c_void, *const c_char, *mut f64) -> NgxResult,
    get_f32: unsafe extern "system" fn(*const c_void, *const c_char, *mut f32) -> NgxResult,
    get_pointer: unsafe extern "system" fn(*const c_void, *const c_char, *mut *mut c_void) -> NgxResult,
    reset: unsafe extern "system" fn(*mut c_void),
}

const _: () = {
    // 每个虚函数在表里的槽位（偏移 / 8），从上往下照头的顺序数。
    //
    // 第一槽写成 `0` 而不是 `8 * 0`：后者会被常量折叠成零，默认 Clippy 的
    // `erasing_op` 判红（它要的是「这一行在算槽位」，而不是「这一行恒等于零」）。
    // 断言本身没变——`set_u64` 就是这张表的起点。
    assert!(std::mem::offset_of!(ParameterVtable, set_u64) == 0);
    assert!(std::mem::offset_of!(ParameterVtable, set_f64) == 8 * 5);
    assert!(std::mem::offset_of!(ParameterVtable, set_f32) == 8 * 6);
    assert!(std::mem::offset_of!(ParameterVtable, set_u32) == 8 * 3);
    assert!(std::mem::offset_of!(ParameterVtable, set_i32) == 8 * 4);
    assert!(std::mem::offset_of!(ParameterVtable, set_d3d11) == 8 * 1);
    assert!(std::mem::offset_of!(ParameterVtable, set_d3d12) == 8 * 2);
    assert!(std::mem::offset_of!(ParameterVtable, set_pointer) == 8 * 7);
    assert!(std::mem::offset_of!(ParameterVtable, get_u64) == 8 * 8);
    assert!(std::mem::offset_of!(ParameterVtable, get_f64) == 8 * 13);
    assert!(std::mem::offset_of!(ParameterVtable, get_f32) == 8 * 14);
    assert!(std::mem::offset_of!(ParameterVtable, get_u32) == 8 * 11);
    assert!(std::mem::offset_of!(ParameterVtable, get_i32) == 8 * 12);
    assert!(std::mem::offset_of!(ParameterVtable, get_d3d11) == 8 * 9);
    assert!(std::mem::offset_of!(ParameterVtable, get_d3d12) == 8 * 10);
    assert!(std::mem::offset_of!(ParameterVtable, get_pointer) == 8 * 15);
    assert!(std::mem::offset_of!(ParameterVtable, reset) == 8 * 16);
};

/// NGX 的日志回调：设了 `YOMIKA_NGX_LOG` 就把 NGX 自己的话打到 stderr。
///
/// 「参数缺失或类型不对」这种码只说结论，日志里才有是哪一个参数——排查这条路径时
/// 它是唯一说得清楚的东西。
unsafe extern "system" fn dlssnr_log_callback(message: *const c_char, level: i32, source: i32) {
    if std::env::var_os("YOMIKA_NGX_LOG").is_none() || message.is_null() {
        return;
    }
    let text = unsafe { CStr::from_ptr(message) }.to_string_lossy();
    eprintln!("[ngx {level}/{source}] {}", text.trim_end());
}

/// NGX 会问「缩放比是多少」，答案走这个回调。
///
/// 同分辨率处理下缩放比就是 1，创建参数里必须带上它——少了它就是 `0xBAD00005`
/// （参数缺失），NGX 不会自己猜。
pub(super) unsafe extern "system" fn dlssnr_scaling_ratio_callback(parameters: *mut c_void) -> NgxResult {
    if parameters.is_null() {
        return NGX_FAIL_MASK | 5;
    }
    Parameters::borrow(parameters).set_f32("DLSSNR.ScalingRatio", 1.0);
    NGX_SUCCESS
}

/// 一个 NGX 参数对象（核心分配的，析构也交回核心）。拿到的裸指针交给 NGX。
pub struct Parameters {
    pointer: *mut c_void,
    /// 核心的 `DestroyParameters`（垫片里那一个）：参数块是核心的东西，不能我们 free。
    destroy: Option<ShimDestroyFn>,
}

// NGX 会从它自己的线程读参数（EvaluateFeature 期间），对象的线程安全由它负责；
// 指针只在一次调用里用，故可以跨线程传。
unsafe impl Send for Parameters {}
unsafe impl Sync for Parameters {}

impl Parameters {
    /// 包住核心给的对象（`NgxCore::allocate_parameters`）。Drop 时调核心的
    /// `DestroyParameters`——参数块是核心的东西，不能由我们 free。
    pub(super) fn from_core(pointer: *mut c_void, destroy: ShimDestroyFn) -> Self {
        Self {
            pointer,
            destroy: Some(destroy),
        }
    }

    /// 借用视图：NGX 回调（比如算缩放比）会把同一个参数对象传回来，我们只往上
    /// 写值，**不当它是我们的**——Drop 什么都不做。
    pub(super) fn borrow(pointer: *mut c_void) -> Self {
        Self {
            pointer,
            destroy: None,
        }
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.pointer
    }

    /// 对象自己的虚表（C++ 对象布局：头 8 字节就是虚表指针）。
    fn vtable(&self) -> &ParameterVtable {
        unsafe { &**(self.pointer as *const *const ParameterVtable) }
    }

    fn set(&self, name: &str, value: ParameterValue) {
        let name = CString::new(name).unwrap_or_default();
        let vtable = self.vtable();
        let object = self.pointer;
        unsafe {
            match value {
                ParameterValue::U32(value) => (vtable.set_u32)(object, name.as_ptr(), value),
                ParameterValue::I32(value) => (vtable.set_i32)(object, name.as_ptr(), value),
                ParameterValue::U64(value) => (vtable.set_u64)(object, name.as_ptr(), value),
                ParameterValue::F32(value) => (vtable.set_f32)(object, name.as_ptr(), value),
                ParameterValue::F64(value) => (vtable.set_f64)(object, name.as_ptr(), value),
                ParameterValue::Resource(value) => (vtable.set_d3d12)(object, name.as_ptr(), value),
                ParameterValue::Pointer(value) => (vtable.set_pointer)(object, name.as_ptr(), value),
            }
        }
    }

    pub fn set_u32(&self, name: &str, value: u32) {
        self.set(name, ParameterValue::U32(value));
    }

    /// 布尔与枚举走 `int` 那一格（`Set(name, 1)`）：片段读它们用的是 int，
    /// 用 u32 存进去它读回来是「类型不对」。
    pub fn set_i32(&self, name: &str, value: i32) {
        self.set(name, ParameterValue::I32(value));
    }

    pub fn set_u64(&self, name: &str, value: u64) {
        self.set(name, ParameterValue::U64(value));
    }

    pub fn set_f32(&self, name: &str, value: f32) {
        self.set(name, ParameterValue::F32(value));
    }

    /// 双精度那一格（探针用得上：看 NGX 把哪种标量记成哪种类型）。
    #[cfg(any(test, debug_assertions))]
    pub fn set_f64(&self, name: &str, value: f64) {
        self.set(name, ParameterValue::F64(value));
    }

    /// 资源（`ID3D12Resource*`）必须走 D3D12 那一格。
    pub fn set_resource(&self, name: &str, value: *mut c_void) {
        self.set(name, ParameterValue::Resource(value));
    }

    /// 回调一类的裸指针走 `void*` 那一格（函数指针不是资源，别混）。
    pub fn set_pointer(&self, name: &str, value: *mut c_void) {
        self.set(name, ParameterValue::Pointer(value));
    }

    /// 原始 vtable 指针（探针用：直接按槽位号调用，验证我们记的槽位跟真实的差多少）。
    #[cfg(any(test, debug_assertions))]
    pub fn vtable_pointer(&self) -> *const usize {
        unsafe { *(self.pointer as *const *const usize) }
    }

    /// 读回一个值（按类型）。排查「参数缺失或类型不对」时用得上：设进去的值如果
    /// 读不回来，说明类型对不上。
    #[cfg(any(test, debug_assertions))]
    pub fn read_back(&self, name: &str) -> String {
        let raw_name = name;
        let Ok(name) = CString::new(name) else {
            return "<名字非法>".to_string();
        };
        let vtable = self.vtable();
        let object = self.pointer;
        let mut u32_value = 0u32;
        let mut i32_value = 0i32;
        let mut f32_value = 0f32;
        let mut pointer_value: *mut c_void = std::ptr::null_mut();
        let mut u64_value = 0u64;
        let mut f64_value = 0f64;
        let mut d3d12_value: *mut c_void = std::ptr::null_mut();
        unsafe {
            let as_f64 = (vtable.get_f64)(object, name.as_ptr(), &mut f64_value);
            let as_d3d12 = (vtable.get_d3d12)(object, name.as_ptr(), &mut d3d12_value);
            let as_u32 = (vtable.get_u32)(object, name.as_ptr(), &mut u32_value);
            let as_i32 = (vtable.get_i32)(object, name.as_ptr(), &mut i32_value);
            let as_f32 = (vtable.get_f32)(object, name.as_ptr(), &mut f32_value);
            let as_pointer = (vtable.get_pointer)(object, name.as_ptr(), &mut pointer_value);
            let as_u64 = (vtable.get_u64)(object, name.as_ptr(), &mut u64_value);
            format!(
                "{raw_name}: d3d12={} u32={} i32={} f32={} f64={} ptr={} u64={}",
                if succeeded(as_d3d12) { format!("{d3d12_value:?}") } else { "-".into() },
                if succeeded(as_u32) { format!("{u32_value}") } else { "-".into() },
                if succeeded(as_i32) { format!("{i32_value}") } else { "-".into() },
                if succeeded(as_f32) { format!("{f32_value}") } else { "-".into() },
                if succeeded(as_f64) { format!("{f64_value}") } else { "-".into() },
                if succeeded(as_pointer) { format!("{pointer_value:?}") } else { "-".into() },
                if succeeded(as_u64) { format!("{u64_value}") } else { "-".into() },
            )
        }
    }

    #[cfg(test)]
    pub(super) fn get_i32(&self, name: &str) -> Option<i32> {
        let name = CString::new(name).ok()?;
        let mut out = 0;
        let result = unsafe { (self.vtable().get_i32)(self.pointer, name.as_ptr(), &mut out) };
        succeeded(result).then_some(out)
    }

    #[cfg(test)]
    pub(super) fn get_f32(&self, name: &str) -> Option<f32> {
        let name = CString::new(name).ok()?;
        let mut out = 0.0;
        let result = unsafe { (self.vtable().get_f32)(self.pointer, name.as_ptr(), &mut out) };
        succeeded(result).then_some(out)
    }

    #[cfg(test)]
    pub(super) fn get_u64(&self, name: &str) -> Option<u64> {
        let name = CString::new(name).ok()?;
        let mut out = 0;
        let result = unsafe { (self.vtable().get_u64)(self.pointer, name.as_ptr(), &mut out) };
        succeeded(result).then_some(out)
    }

    /// 读回一个 u32：测试用它确认参数真的进了 NGX 的表。
    pub fn get_u32(&self, name: &str) -> Option<u32> {
        let name = CString::new(name).ok()?;
        let mut out = 0u32;
        let result = unsafe { (self.vtable().get_u32)(self.pointer, name.as_ptr(), &mut out) };
        succeeded(result).then_some(out)
    }
}

/// `Parameters::set` 的入参：只为把 8 个重载收成一处 match。
enum ParameterValue {
    U32(u32),
    I32(i32),
    U64(u64),
    F32(f32),
    F64(f64),
    /// `ID3D12Resource*`（D3D12 那一格）。
    Resource(*mut c_void),
    /// 别的裸指针，比如缩放比回调（`void*` 那一格）。
    Pointer(*mut c_void),
}

impl Drop for Parameters {
    fn drop(&mut self) {
        if let (Some(destroy), false) = (self.destroy, self.pointer.is_null()) {
            let _ = unsafe { destroy(self.pointer) };
        }
        self.pointer = std::ptr::null_mut();
    }
}

// ── 调用者兼容层 ─────────────────────────────────────────────────────────────

/// 这份片段只肯为名叫 `nvngx.dll` 的调用者工作：它拿自己的调用者模块去问
/// `GetModuleFileNameW`，名字不对就一路 `NVSDK_NGX_Result_FAIL_PlatformError`
/// （`0xBAD00002`；本机实测 `Init_Ext` 与 `GetFeatureRequirements` 都是这个码）。
///
/// 我们不是 `nvngx.dll`，所以改掉片段**自己的**导入表：把
/// `KERNEL32!GetModuleFileNameW` 那一格换成下面这个钩子。钩子只回答一种问法——
/// 「这个模块叫什么」——其余一律转发给被顶下来的真 API。
///
/// 三个变体都从 `KERNEL32.dll` 按名字导入它（`tools/pe-imports.py` 可复核）。
type GetModuleFileNameWFn = unsafe extern "system" fn(HMODULE, *mut u16, u32) -> u32;

/// 已经补过的片段模块（0 = 没补过）。同一份 DLL 只补一次。
static PATCHED_MODULE: AtomicIsize = AtomicIsize::new(0);
/// 钩子所在模块的句柄——片段要问的就是它。
static CALLER_MODULE: AtomicIsize = AtomicIsize::new(0);
/// 被顶下来的真 `GetModuleFileNameW`。
static ORIGINAL_GET_MODULE_FILE_NAME_W: AtomicUsize = AtomicUsize::new(0);

/// 报给片段的名字（`L"nvngx.dll"`），含结尾的 NUL。
const AUTHORIZED_CALLER: [u16; 10] = [0x6E, 0x76, 0x6E, 0x67, 0x78, 0x2E, 0x64, 0x6C, 0x6C, 0];
const AUTHORIZED_CALLER_LENGTH: u32 = AUTHORIZED_CALLER.len() as u32 - 1;

/// 片段问「我的调用者是谁」：答 `nvngx.dll`。缓冲区太小时按 Win32 的规矩截断并
/// 置 `ERROR_INSUFFICIENT_BUFFER`、返回所需长度。
unsafe extern "system" fn snippet_get_module_file_name(
    module: HMODULE,
    filename: *mut u16,
    size: u32,
) -> u32 {
    if module.0 as isize == CALLER_MODULE.load(Ordering::Acquire) {
        if filename.is_null() || size == 0 {
            SetLastError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }
        if size <= AUTHORIZED_CALLER_LENGTH {
            if size > 1 {
                std::ptr::copy_nonoverlapping(
                    AUTHORIZED_CALLER.as_ptr(),
                    filename,
                    size as usize - 1,
                );
            }
            *filename.add(size as usize - 1) = 0;
            SetLastError(ERROR_INSUFFICIENT_BUFFER);
            return size;
        }
        std::ptr::copy_nonoverlapping(AUTHORIZED_CALLER.as_ptr(), filename, AUTHORIZED_CALLER.len());
        return AUTHORIZED_CALLER_LENGTH;
    }
    let original = ORIGINAL_GET_MODULE_FILE_NAME_W.load(Ordering::Acquire);
    if original == 0 {
        // 还没接管就有人问别人：宁可报错也不要答错。
        SetLastError(ERROR_INVALID_FUNCTION);
        return 0;
    }
    let original: GetModuleFileNameWFn = std::mem::transmute(original);
    original(module, filename, size)
}

// PE 里要读的那几块（`winnt.h`）。下面的 assert 是照头文件里的偏移与 sizeof
// 写的：布局错一位，读到的就不是导入表了。
#[repr(C)]
struct ImageDosHeader {
    e_magic: u16,
    _rest: [u16; 29],
    e_lfanew: i32,
}

#[repr(C)]
struct ImageFileHeader {
    machine: u16,
    number_of_sections: u16,
    time_date_stamp: u32,
    pointer_to_symbol_table: u32,
    number_of_symbols: u32,
    size_of_optional_header: u16,
    characteristics: u16,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ImageDataDirectory {
    virtual_address: u32,
    size: u32,
}

#[repr(C)]
struct ImageOptionalHeader64 {
    magic: u16,
    major_linker_version: u8,
    minor_linker_version: u8,
    size_of_code: u32,
    size_of_initialized_data: u32,
    size_of_uninitialized_data: u32,
    address_of_entry_point: u32,
    base_of_code: u32,
    image_base: u64,
    section_alignment: u32,
    file_alignment: u32,
    major_operating_system_version: u16,
    minor_operating_system_version: u16,
    major_image_version: u16,
    minor_image_version: u16,
    major_subsystem_version: u16,
    minor_subsystem_version: u16,
    win32_version_value: u32,
    size_of_image: u32,
    size_of_headers: u32,
    check_sum: u32,
    subsystem: u16,
    dll_characteristics: u16,
    size_of_stack_reserve: u64,
    size_of_stack_commit: u64,
    size_of_heap_reserve: u64,
    size_of_heap_commit: u64,
    loader_flags: u32,
    number_of_rva_and_sizes: u32,
    data_directory: [ImageDataDirectory; 16],
}

#[repr(C)]
struct ImageNtHeaders64 {
    signature: u32,
    file_header: ImageFileHeader,
    optional_header: ImageOptionalHeader64,
}

#[repr(C)]
struct ImageImportDescriptor {
    original_first_thunk: u32,
    time_date_stamp: u32,
    forwarder_chain: u32,
    name: u32,
    first_thunk: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ImageThunkData64 {
    value: u64,
}

const _: () = {
    assert!(std::mem::size_of::<ImageDosHeader>() == 0x40);
    assert!(std::mem::offset_of!(ImageDosHeader, e_lfanew) == 0x3C);
    assert!(std::mem::size_of::<ImageNtHeaders64>() == 0x108);
    assert!(std::mem::size_of::<ImageOptionalHeader64>() == 240);
    assert!(std::mem::offset_of!(ImageOptionalHeader64, size_of_image) == 0x38);
    assert!(std::mem::offset_of!(ImageOptionalHeader64, data_directory) == 0x70);
    assert!(std::mem::size_of::<ImageImportDescriptor>() == 20);
};

const IMAGE_DOS_SIGNATURE: u16 = 0x5A4D; // 'MZ'
const IMAGE_NT_SIGNATURE: u32 = 0x0000_4550; // 'PE\0\0'
const IMAGE_NT_OPTIONAL_HDR64_MAGIC: u16 = 0x020B;
const IMAGE_DIRECTORY_ENTRY_IMPORT: usize = 1;
const IMAGE_ORDINAL_FLAG64: u64 = 1 << 63;

/// 片段的 `GetModuleFileNameW` 由谁提供。逐字节比对（`_stricmp` 的等价物）。
const SNIPPET_IMPORT_LIBRARIES: [&str; 3] = [
    "KERNEL32.dll",
    "api-ms-win-core-libraryloader-l1-2-0.dll",
    "api-ms-win-core-libraryloader-l1-1-0.dll",
];

/// 在一个已加载模块的内存映像里找 `function_name` 的 IAT 槽，返回它的地址；
/// 槽里存的就是函数地址。
///
/// # Safety
/// `module` 必须是 `LoadLibraryExW` 交回来的、还活着的句柄：函数会按 PE 头里的
/// RVA 直接读它的映像（映像一定整块提交，越界的 RVA 都做了范围检查）。
unsafe fn imported_function_slot(module: HMODULE, function_name: &str) -> Option<*mut usize> {
    let base = module.0 as *const u8;
    if base.is_null() {
        return None;
    }
    let dos = &*base.cast::<ImageDosHeader>();
    if dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew <= 0 {
        return None;
    }
    let nt = &*base.offset(dos.e_lfanew as isize).cast::<ImageNtHeaders64>();
    if nt.signature != IMAGE_NT_SIGNATURE || nt.optional_header.magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC {
        return None;
    }
    let image_size = nt.optional_header.size_of_image;
    let directory = nt.optional_header.data_directory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if directory.virtual_address == 0
        || directory.size == 0
        || directory.virtual_address >= image_size
        || directory.size > image_size
        || directory.virtual_address > image_size - directory.size
    {
        return None;
    }

    let read_c_string = |rva: u32| -> Option<&CStr> {
        (rva < image_size).then(|| CStr::from_ptr(base.add(rva as usize).cast::<c_char>()))
    };

    let mut at = directory.virtual_address;
    let end = directory.virtual_address + directory.size;
    while at + std::mem::size_of::<ImageImportDescriptor>() as u32 <= end {
        let descriptor = &*base.add(at as usize).cast::<ImageImportDescriptor>();
        if descriptor.name == 0 {
            break;
        }
        at += std::mem::size_of::<ImageImportDescriptor>() as u32;
        if descriptor.original_first_thunk == 0 || descriptor.first_thunk == 0 {
            continue;
        }
        if descriptor.original_first_thunk >= image_size || descriptor.first_thunk >= image_size {
            continue;
        }
        let library = match read_c_string(descriptor.name) {
            Some(name) => name,
            None => continue,
        };
        let named = library.to_bytes();
        if !SNIPPET_IMPORT_LIBRARIES.iter().any(|name| named.eq_ignore_ascii_case(name.as_bytes())) {
            continue;
        }
        let thunk_bytes = std::mem::size_of::<ImageThunkData64>() as u32;
        let mut rva = descriptor.original_first_thunk;
        let mut name_thunk = base.add(rva as usize).cast::<ImageThunkData64>();
        let mut address_thunk = base.add(descriptor.first_thunk as usize).cast::<ImageThunkData64>();
        while rva + thunk_bytes < image_size {
            let value = (*name_thunk).value;
            if value == 0 {
                break;
            }
            // 序号导入（高位是 1）问不出名字，跳过。
            if value & IMAGE_ORDINAL_FLAG64 == 0 {
                // IMAGE_IMPORT_BY_NAME：u16 序号 + 名字。
                let name_rva = value as u32;
                if let Some(imported) = read_c_string(name_rva.saturating_add(2)) {
                    if imported.to_bytes() == function_name.as_bytes() {
                        return Some(address_thunk as *mut usize);
                    }
                }
            }
            name_thunk = name_thunk.add(1);
            address_thunk = address_thunk.add(1);
            rva += thunk_bytes;
        }
    }
    None
}

/// 给片段装上钩子：这是 `load()` 的一步，装不上就别再往下走（没有它，之后每个
/// 调用都只会得到 `PlatformError`）。
///
/// 顺序有讲究：先找到槽并记下原来的函数，再解析钩子自己所在的模块，然后把槽改
/// 可写、亮出「调用者模块」、换指针、还回保护、刷指令缓存。**先亮模块后换指针**
/// ——反过来会有一瞬钩子已经装上、却还不知道该认谁。
///
/// # Safety
/// `module` 必须是 `LoadLibraryExW` 加载的 dlssnr 片段句柄；函数会直接改它内存
/// 映像里的 IAT。
unsafe fn install_caller_compatibility(module: HMODULE) -> Result<(), String> {
    if module.0.is_null() {
        return Err("片段句柄为空".to_string());
    }
    let patched = PATCHED_MODULE.load(Ordering::Acquire);
    if patched == module.0 as isize {
        return Ok(());
    }
    if patched != 0 {
        return Err("调用者兼容层已经装在另一份片段上".to_string());
    }

    let slot = imported_function_slot(module, "GetModuleFileNameW")
        .ok_or_else(|| "片段里没有 KERNEL32!GetModuleFileNameW 的导入槽".to_string())?;
    let original = std::ptr::read_volatile(slot);
    if original == 0 {
        return Err("片段的 GetModuleFileNameW 导入槽还是空的（加载器没写）".to_string());
    }
    let hook = snippet_get_module_file_name as GetModuleFileNameWFn;
    if original == hook as usize {
        // 已经是我们的钩子（两次加载同一份片段，或两个线程同时到这儿）：槽里的
        // 真 API 早就被顶下去了，再补一次反而会把它彻底弄丢。
        PATCHED_MODULE.store(module.0 as isize, Ordering::Release);
        return Ok(());
    }

    let mut owner = HMODULE(std::ptr::null_mut());
    GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        PCWSTR((hook as *const u8).cast::<u16>()),
        &mut owner,
    )
    .map_err(|error| format!("解析钩子所在模块失败：{error}"))?;

    let mut old_protection = PAGE_PROTECTION_FLAGS::default();
    VirtualProtect(
        slot.cast::<c_void>().cast_const(),
        std::mem::size_of::<usize>(),
        PAGE_READWRITE,
        &mut old_protection,
    )
    .map_err(|error| format!("片段 IAT 改成可写失败：{error}"))?;

    CALLER_MODULE.store(owner.0 as isize, Ordering::Release);
    ORIGINAL_GET_MODULE_FILE_NAME_W.store(original, Ordering::Release);
    std::ptr::write_volatile(slot, hook as usize);

    let mut ignored = PAGE_PROTECTION_FLAGS::default();
    if let Err(error) = VirtualProtect(
        slot.cast::<c_void>().cast_const(),
        std::mem::size_of::<usize>(),
        old_protection,
        &mut ignored,
    ) {
        // 保护还不回去不算失败：钩子已经在位，只是这一页多留了一会儿可写。
        eprintln!("Yomika DLSSNR：还原片段 IAT 保护失败：{error}");
    }
    let _ = FlushInstructionCache(
        GetCurrentProcess(),
        Some(slot.cast::<c_void>().cast_const()),
        std::mem::size_of::<usize>(),
    );
    PATCHED_MODULE.store(module.0 as isize, Ordering::Release);
    Ok(())
}

// ── 加载 DLL 与取导出 ────────────────────────────────────────────────────────

/// `LoadLibraryExW`（先在自己所在目录找依赖）+ 按名字取导出。少任何一个导出都算
/// 「这条路径不可用」，不是崩溃：把模块放掉再报人话。
fn load_module(path: &Path, exports: &[&str]) -> Result<(HMODULE, Vec<*const c_void>), String> {
    let wide = wide(path.as_os_str());
    let module = unsafe {
        LoadLibraryExW(
            PCWSTR(wide.as_ptr()),
            None,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        )
    }
    .map_err(|error| format!("加载 {} 失败：{error}", path.display()))?;
    let mut addresses = Vec::with_capacity(exports.len());
    for name in exports {
        match exported(module, name) {
            Some(address) => addresses.push(address),
            None => {
                unsafe { FreeLibrary(module) }.ok();
                return Err(format!("{} 缺少导出 {name}", path.display()));
            }
        }
    }
    Ok((module, addresses))
}

/// 单个导出；缺了就是 `None`（可选导出用得上）。
fn exported(module: HMODULE, name: &str) -> Option<*const c_void> {
    let name = CString::new(name).ok()?;
    unsafe { GetProcAddress(module, PCSTR(name.as_ptr() as *const u8)) }
        .map(|address| address as *const c_void)
}

/// 把路径变成 NGX 要的宽字符串（带结尾的 NUL）。
fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

// ── NGX 核心（DLSS SDK，经垫片 DLL） ────────────────────────────────────────

/// 核心初始化时的项目号与引擎名（`Init_with_ProjectID` 的前三个参数）。
///
/// 项目号只是一个遥测字段（NGX 把它写进日志），真正被校验的是片段那边固定写死的
/// `DLSSNR_SIGNED_SNIPPET_APPLICATION_ID`——两者互不相干，所以这里填一个我们自己的
/// 稳定值就够了，换掉它不影响功能。
const NGX_PROJECT_ID: &str = "7c134ab9-9677-4af5-a2b2-bca943350861";
const NGX_ENGINE_VERSION: &str = concat!("Yomika-", env!("CARGO_PKG_VERSION"));
/// `NVSDK_NGX_ENGINE_TYPE_CUSTOM`（头里的第一个枚举值）。
const NGX_ENGINE_TYPE_CUSTOM: i32 = 0;

/// 构建时没编出垫片时的说法（`build.rs` 会打一条同样的警告）。
const NGX_CORE_MISSING: &str =
    "这个构建没有 NGX 核心（src-tauri/vendor/ngx 里缺 nvsdk_ngx_s.lib 或 ngx_shim.c）";
/// 垫片 DLL 的名字（与 `cc` 编出来的目标名一致）。
#[cfg(ngx_core)]
const SHIM_NAME: &str = "yomika_ngx.dll";

/// 片段的三个导出（核心已经把它加载好了）。
///
/// **这一路现在没有调用点**（2026-10-17 起产品路径直连片段自己的导出，见 `workspace.rs`）：
/// 留着是因为它是「交给核心建 feature」的参考实现与回退开关（`docs/186` 的退路），要退回去
/// 只需让 `workspace.rs` 改回调用 `NgxCore::feature_module()` 那一路。
#[allow(dead_code)]
pub(super) struct FeatureModule {
    create: ShimCreateFeatureFn,
    evaluate: ShimEvaluateFeatureFn,
    release: ShimReleaseFeatureFn,
    /// 可选：特性自己往参数表里补默认值（`PopulateParameters_Impl`）。
    populate: Option<unsafe extern "system" fn(*mut c_void) -> NgxResult>,
}

#[allow(dead_code)] // 与 `FeatureModule` 同一条回退路：核心替我们建 feature 的那三个调用
impl FeatureModule {
    pub(super) fn create(
        &self,
        command_list: *mut c_void,
        parameters: &Parameters,
    ) -> Result<*mut c_void, String> {
        // 先让特性自己往表里补它要的默认值（SDK 的 PopulateParameters 流程）。
        if let Some(populate) = self.populate {
            let result = unsafe { populate(parameters.as_ptr()) };
            if !succeeded(result) {
                return Err(format!("PopulateParameters_Impl 失败：{}", describe(result)));
            }
        }
        let mut feature: *mut c_void = std::ptr::null_mut();
        let result = unsafe {
            (self.create)(command_list, FEATURE_DLSSNR, parameters.as_ptr(), &mut feature)
        };
        if !succeeded(result) {
            return Err(format!("片段 CreateFeature 失败：{}", describe(result)));
        }
        if feature.is_null() {
            return Err("片段 CreateFeature 成功但句柄为空".to_string());
        }
        Ok(feature)
    }

    pub(super) fn evaluate(
        &self,
        command_list: *mut c_void,
        feature: *mut c_void,
        parameters: &Parameters,
    ) -> Result<(), String> {
        let result = unsafe { (self.evaluate)(command_list, feature, parameters.as_ptr()) };
        if !succeeded(result) {
            return Err(format!("片段 EvaluateFeature 失败：{}", describe(result)));
        }
        Ok(())
    }

    pub(super) fn release(&self, feature: *mut c_void) {
        if !feature.is_null() {
            let _ = unsafe { (self.release)(feature) };
        }
    }
}

type ShimInitFn = unsafe extern "system" fn(
    *const c_char,
    i32,
    *const c_char,
    *const u16,
    *mut c_void,
    *const FeatureCommonInfo,
    u32,
) -> NgxResult;
type ShimAllocateFn = unsafe extern "system" fn(*mut *mut c_void) -> NgxResult;
type ShimCreateFeatureFn = unsafe extern "system" fn(*mut c_void, i32, *mut c_void, *mut *mut c_void) -> NgxResult;
type ShimEvaluateFeatureFn = unsafe extern "system" fn(*mut c_void, *mut c_void, *mut c_void) -> NgxResult;
type ShimReleaseFeatureFn = unsafe extern "system" fn(*mut c_void) -> NgxResult;
type ShimDestroyFn = unsafe extern "system" fn(*mut c_void) -> NgxResult;

/// 垫片里那三个函数的地址。模块活到进程结束（和 NGX 一样不许卸载），句柄留在
/// 结构里只是为了不让它被优化掉。
#[cfg(ngx_core)]
#[allow(dead_code)] // `create/evaluate/release_feature` 三个字段现在没有读点：同 `FeatureModule` 那条回退路
struct Shim {
    module: HMODULE,
    init: ShimInitFn,
    allocate: ShimAllocateFn,
    destroy: ShimDestroyFn,
    create_feature: ShimCreateFeatureFn,
    evaluate_feature: ShimEvaluateFeatureFn,
    release_feature: ShimReleaseFeatureFn,
}

#[cfg(ngx_core)]
impl Shim {
    fn load(data_dir: &Path) -> Result<Self, String> {
        let path = shim_path(data_dir).ok_or_else(|| NGX_CORE_MISSING.to_string())?;
        let (module, _) = load_module(
            &path,
            &[
                "yomika_ngx_init",
                "yomika_ngx_allocate",
                "yomika_ngx_destroy",
                "yomika_ngx_create_feature",
                "yomika_ngx_evaluate_feature",
                "yomika_ngx_release_feature",
            ],
        )?;
        Ok(Self {
            module,
            init: unsafe { std::mem::transmute(exported(module, "yomika_ngx_init").expect("init")) },
            allocate: unsafe {
                std::mem::transmute(exported(module, "yomika_ngx_allocate").expect("allocate"))
            },
            destroy: unsafe {
                std::mem::transmute(exported(module, "yomika_ngx_destroy").expect("destroy"))
            },
            create_feature: unsafe {
                std::mem::transmute(exported(module, "yomika_ngx_create_feature").expect("create"))
            },
            evaluate_feature: unsafe {
                std::mem::transmute(exported(module, "yomika_ngx_evaluate_feature").expect("evaluate"))
            },
            release_feature: unsafe {
                std::mem::transmute(exported(module, "yomika_ngx_release_feature").expect("release"))
            },
        })
    }
}

/// 垫片在哪儿：环境变量优先（测试与排查用），其次是应用目录、数据目录旁边，最后是
/// 构建时编出来的那个路径（开发与测试走它）。
#[cfg(ngx_core)]
/// 编进二进制的垫片（`build.rs` 把 `ngx_shim.c` 编成它）。
///
/// **嵌进二进制再解出来**，而不是指望它躺在 exe 旁边：安装包不会替我们带这个文件
/// （它长在 `OUT_DIR` 里），漏了的话装机版会静默变成「这个构建没有 NGX 核心」——
/// 只有开发机上能跑。
#[cfg(ngx_core)]
static EMBEDDED_SHIM: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/yomika_ngx.dll"));

/// 低于这个体积就当「这个构建没编出垫片」（`build.rs` 失败时写的是空文件）。
#[cfg(ngx_core)]
const MIN_SHIM_BYTES: usize = 4096;

/// 找一个能加载的垫片路径。
///
/// 顺序：`YOMIKA_NGX_SHIM`（排查时指到别处）→ exe 同目录（手工放一份）→ 数据目录
/// （从二进制里解出来的那一份）→ `OUT_DIR`（开发时那份）。
#[cfg(ngx_core)]
fn shim_path(data_dir: &Path) -> Option<std::path::PathBuf> {
    let override_path = std::env::var("YOMIKA_NGX_SHIM")
        .ok()
        .map(std::path::PathBuf::from);
    let beside_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|directory| directory.join(SHIM_NAME)));
    resolve_shim(override_path, beside_exe, data_dir, EMBEDDED_SHIM)
}

/// 位置上这一份垫片还算不算「我们这一份」：**字节相等**才算。
///
/// 原来是长度比对。长度对不上当然说明换了 SDK，可长度对得上、内容不一样的那种才是最常
/// 发生的（同一份 `ngx_shim.c` 改两行、或者换一个 `nvsdk_ngx_s.lib` 小版本），而 DLL
/// 一旦被加载过就换不掉了——按长度判旧会**静默**沿用上一份，症状是「一切照常、只是跑
/// 的不是这一份构建」。Task 10 第①条要的正是「包里主 exe／worker／垫片同一次构建」。
#[cfg(ngx_core)]
fn shim_is_current(path: &Path, embedded: &[u8]) -> bool {
    std::fs::read(path)
        .map(|bytes| bytes == embedded)
        .unwrap_or(false)
}

/// 挑一份可加载的垫片。顺序见 [`shim_path`]，判定见 [`shim_is_current`]。
///
/// 四个入口都收成参数，是为着让每一格都能单独量：往测试 exe 所在目录里写文件会污染
/// 别的用例的现场，而「旁边那份是别人的」这件事恰恰是要钉的。
#[cfg(ngx_core)]
fn resolve_shim(
    override_path: Option<std::path::PathBuf>,
    beside_exe: Option<std::path::PathBuf>,
    data_dir: &Path,
    embedded: &[u8],
) -> Option<std::path::PathBuf> {
    // 排查用的显式覆盖：说指哪儿就指哪儿（它不在安装包里，也不会被顺手放进去）。
    if let Some(path) = override_path {
        if path.is_file() {
            return Some(path);
        }
    }
    // 旁边那一份：**我们这一份**才认。它不是「换一份垫片」的入口（那是上面那条），
    // 而是「别处顺手放了一份同一次构建的副本」；放的是别人的就跳过——让一份外来 DLL
    // 顶掉编进二进制的那份，症状是「一切照常、只是跑的不是这一份构建」。
    if let Some(candidate) = beside_exe {
        if shim_is_current(&candidate, embedded) {
            return Some(candidate);
        }
    }
    if embedded.len() >= MIN_SHIM_BYTES {
        let target = data_dir.join(SHIM_NAME);
        // 不是我们这一份就重写：换了 SDK 重新编出来的那份不一样，而 DLL 一旦被加载过
        // 就换不掉了，所以要在加载之前把它换掉。
        let stale = !shim_is_current(&target, embedded);
        if !stale || std::fs::write(&target, embedded).is_ok() {
            return Some(target);
        }
    }
    let fallback = std::path::PathBuf::from(env!("OUT_DIR")).join(SHIM_NAME);
    fallback.is_file().then_some(fallback)
}

#[cfg(not(ngx_core))]
fn shim_path(_data_dir: &Path) -> Option<std::path::PathBuf> {
    None
}

/// NGX 核心：NVIDIA 的 DLSS SDK（静态库 `nvsdk_ngx_s.lib`），经
/// [`shim`](https://) 那一层小 DLL 调进来（为什么垫一层见 `vendor/ngx/ngx_shim.c`）。
///
/// 核心负责两件事，缺一不可：
///
/// 1. `Init_with_ProjectID` —— 建立 NGX 会话。片段的 `Init_Ext` **依赖这个会话**：
///    没有它，片段不给错误码，而是直接把进程带崩（本机实测 `STATUS_ACCESS_VIOLATION`，
///    栈在 DLL 里）。这正是当初绕了很久的那一步。
/// 2. `AllocateParameters` / `DestroyParameters` —— 参数对象由它分配、由它销毁；
///    我们只按名字 Set/Get（见上面「参数对象」）。
///
/// 驱动自带的 `nvngx.dll`（"NGX Runtime Library"）**不能**当这个核心用：它的
/// `Init_ProjectID` 在本机也是直接崩（试过 null 设备、无 FeatureCommonInfo 等几种
/// 参数，全崩），它属于 NVIDIA App 的模型更新那一套。能用的是 SDK 里这份静态库。
/// 「真的把 feature 还给 NGX 了几次」——只在测试里数。
///
/// 交回工作区那条守卫原来的观察量是「缓存条数归零 + 同一页结果逐像素相同」，而这两样
/// **分不出**「还回去了」与「把 `Workspace` 丢掉、让 NGX 那份 feature 烂在进程里」：
/// 实测把 `workspace.release(core)` 换成 `context.workspaces.clear()` 之后，那条守卫
/// 照样绿（`debug_outputs/task8h5/blind-release.log`）。可 feature 里那份显存没人还
/// 它（`docs/69` 那组数字：一页 2731×4096 一层就是 GB 级）。所以给它一个不会撒谎的
/// 观察量：交回前后这个数必须涨。
#[cfg(test)]
static FEATURES_RELEASED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
pub(super) fn released_features() -> u64 {
    FEATURES_RELEASED.load(std::sync::atomic::Ordering::Relaxed)
}

pub struct NgxCore {
    initialized: Mutex<bool>,
    /// 垫片加载一次就固定（NGX 也是「一个进程一份核心」的姿态）。用 `OnceLock`
    /// 而不是「加载后从别处借」：下面那些方法（分配参数、创建/评估特性、Drop）
    /// 都得在没有数据目录的地方拿到它。
    #[cfg(ngx_core)]
    shim: std::sync::OnceLock<Shim>,
}

impl NgxCore {
    pub fn new() -> Self {
        Self {
            initialized: Mutex::new(false),
            #[cfg(ngx_core)]
            shim: std::sync::OnceLock::new(),
        }
    }

    /// 这个构建里核心在不在（`build.rs` 编出了垫片，而且它找得到/解得出来）。
    ///
    /// 要数据目录，是因为垫片嵌在二进制里，得先落到盘上才能 `LoadLibrary`——也就是说
    /// **这一句会写一个文件**（几万字节），只在真要看状态时才调。
    pub fn available(data_dir: &Path) -> bool {
        #[cfg(ngx_core)]
        {
            shim_path(data_dir).is_some()
        }
        #[cfg(not(ngx_core))]
        {
            let _ = data_dir;
            false
        }
    }

    /// 取（必要时先加载）垫片。只有初始化这一步需要数据目录。
    #[cfg(ngx_core)]
    fn ensure_shim(&self, data_dir: &Path) -> Result<&Shim, String> {
        if let Some(shim) = self.shim.get() {
            return Ok(shim);
        }
        let shim = Shim::load(data_dir)?;
        Ok(self.shim.get_or_init(|| shim))
    }

    /// 已经加载好的垫片（分配参数、创建/评估特性、Drop 都用它）。
    #[cfg(ngx_core)]
    fn loaded_shim(&self) -> Result<&Shim, String> {
        self.shim.get().ok_or_else(|| NGX_CORE_MISSING.to_string())
    }

    /// 走一遍核心初始化。一次进程只跑一次。
    pub fn initialize(
        &self,
        device: &ID3D12Device,
        data_dir: &Path,
        feature_dir: &Path,
    ) -> Result<(), String> {
        let mut initialized = self
            .initialized
            .lock()
            .map_err(|_| "NGX 核心初始化锁失败".to_string())?;
        if *initialized {
            return Ok(());
        }
        #[cfg(not(ngx_core))]
        {
            let _ = (device, data_dir, feature_dir);
            return Err(NGX_CORE_MISSING.to_string());
        }
        #[cfg(ngx_core)]
        {
            let shim = self.ensure_shim(data_dir)?;
            let logging = std::env::var_os("YOMIKA_NGX_LOG").is_some();

            // NGX 按这张表（按顺序）找特性 DLL——它就是靠它找到 `nvngx_dlssnr.dll`
            // 并自己加载的（日志里那句 "Module not found at …" 找的就是它）。所以
            // 片段所在目录必须在这里，而且要在最前面。
            let mut paths: Vec<Vec<u16>> = Vec::new();
            paths.push(wide(feature_dir.as_os_str()));
            paths.push(wide(data_dir.as_os_str()));
            if let Ok(exe) = std::env::current_exe() {
                if let Some(directory) = exe.parent() {
                    paths.push(wide(directory.as_os_str()));
                }
            }
            let pointers: Vec<*const u16> = paths.iter().map(|path| path.as_ptr()).collect();
            let common = FeatureCommonInfo {
                path_list_info: PathListInfo {
                    path: pointers.as_ptr(),
                    length: pointers.len() as u32,
                },
                internal_data: std::ptr::null_mut(),
                // 设了 YOMIKA_NGX_LOG 就把级别开到 VERBOSE，并留着别的日志去向：
                // NGX 会在应用目录里写一份日志文件（片段自己的 `DLSSNR:` 行只进
                // 那里，排查时它是唯一说得清楚的东西）。平时只留回调，级别 OFF。
                logging_info: LoggingInfo {
                    callback: dlssnr_log_callback as *const c_void,
                    minimum_level: if logging { 2 } else { 0 },
                    disable_other_sinks: !logging,
                },
            };

            let project = CString::new(NGX_PROJECT_ID).map_err(|error| error.to_string())?;
            let engine = CString::new(NGX_ENGINE_VERSION).map_err(|error| error.to_string())?;
            let application_data = wide(data_dir.as_os_str());
            let result = unsafe {
                (shim.init)(
                    project.as_ptr(),
                    NGX_ENGINE_TYPE_CUSTOM,
                    engine.as_ptr(),
                    application_data.as_ptr(),
                    // 给 NGX 的是 COM 接口指针本身：`ID3D12Device` 那层包装的地址
                    // 一旦传出去，NGX 读到的就是包装里的字节（当初的崩就是这么来的）。
                    device.as_raw(),
                    &common,
                    NGX_VERSION_API,
                )
            };
            if !succeeded(result) {
                return Err(format!("NGX 核心初始化失败：{}", describe(result)));
            }
            *initialized = true;
            Ok(())
        }
    }

    /// 核心加载进来的片段模块（`nvngx_dlssnr.dll`）与它的导出。
    ///
    /// 核心在初始化时会自己去搜索路径里把片段加载起来（日志里 `nvngxFeatureVersion
    /// = 310.8.0` 就是它），加载完模块就在进程里了——按名字取回来即可，不用我们再
    /// `LoadLibraryExW` 一遍（那样还要自己补「调用者叫 nvngx.dll」那一层）。
    #[allow(dead_code)] // 回退路：交给核心建 feature（`FeatureModule` 那条，见 docs/186）
    pub(super) fn feature_module(&self) -> Result<FeatureModule, String> {
        let handle = unsafe { GetModuleHandleW(windows::core::w!("nvngx_dlssnr.dll")) }
            .map_err(|error| format!("核心没有把 nvngx_dlssnr.dll 载进来：{error}"))?;
        // 片段的那几个导出与我们自己加载时取的同一批名字。
        // 片段每次调用都要问一遍「调用者是不是 nvngx.dll」——不补这一层，它的
        // CreateFeature/EvaluateFeature 一律回 PlatformError（当初 init 那个坑，
        // 其实每个导出后面都站着同一道检查）。
        unsafe { install_caller_compatibility(handle)? };
        let find = |name: &str| -> Result<*const c_void, String> {
            exported(handle, name).ok_or_else(|| format!("片段缺少导出 {name}"))
        };
        Ok(FeatureModule {
            create: unsafe { std::mem::transmute(find("NVSDK_NGX_D3D12_CreateFeature")?) },
            evaluate: unsafe { std::mem::transmute(find("NVSDK_NGX_D3D12_EvaluateFeature")?) },
            release: unsafe { std::mem::transmute(find("NVSDK_NGX_D3D12_ReleaseFeature")?) },
            populate: exported(handle, "NVSDK_NGX_D3D12_PopulateParameters_Impl")
                .map(|address| unsafe { std::mem::transmute(address) }),
        })
    }

    /// 建一个特性句柄。**这一步会把 `nvngx_dlssnr.dll` 交给核心去加载并调用**——
    /// 我们自己不碰片段的导出（那是当初走偏的那条路：直接调片段要自己补调用者
    /// 兼容层、自己管初始化，核心这条路才是 SDK 文档里的流程）。
    #[allow(dead_code)] // 回退路：核心替我们调片段的 CreateFeature（见 docs/186）
    pub(super) fn create_feature(
        &self,
        command_list: *mut c_void,
        parameters: &Parameters,
    ) -> Result<*mut c_void, String> {
        #[cfg(not(ngx_core))]
        {
            let _ = (command_list, parameters);
            return Err(NGX_CORE_MISSING.to_string());
        }
        #[cfg(ngx_core)]
        {
            let shim = self.loaded_shim()?;
            let mut feature: *mut c_void = std::ptr::null_mut();
            let result = unsafe {
                (shim.create_feature)(command_list, FEATURE_DLSSNR, parameters.as_ptr(), &mut feature)
            };
            if !succeeded(result) {
                return Err(format!("NVSDK_NGX_D3D12_CreateFeature 失败：{}", describe(result)));
            }
            if feature.is_null() {
                return Err("CreateFeature 成功但句柄为空".to_string());
            }
            Ok(feature)
        }
    }

    /// 跑一次（命令表要处于录制状态）。
    #[allow(dead_code)] // 回退路：核心替我们调片段的 EvaluateFeature（见 docs/186）
    pub(super) fn evaluate_feature(
        &self,
        command_list: *mut c_void,
        feature: *mut c_void,
        parameters: &Parameters,
    ) -> Result<(), String> {
        #[cfg(not(ngx_core))]
        {
            let _ = (command_list, feature, parameters);
            return Err(NGX_CORE_MISSING.to_string());
        }
        #[cfg(ngx_core)]
        {
            let shim = self.loaded_shim()?;
            let result = unsafe {
                (shim.evaluate_feature)(command_list, feature, parameters.as_ptr())
            };
            if !succeeded(result) {
                return Err(format!("NVSDK_NGX_D3D12_EvaluateFeature 失败：{}", describe(result)));
            }
            Ok(())
        }
    }

    #[allow(dead_code)] // 回退路：核心替我们调片段的 ReleaseFeature（见 docs/186）
    pub(super) fn release_feature(&self, feature: *mut c_void) {
        if feature.is_null() {
            return;
        }
        // 数在「真的还了一个」这一格：空句柄在调用方那一步就返回了，不该混进这个数。
        #[cfg(test)]
        FEATURES_RELEASED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        #[cfg(ngx_core)]
        if let Ok(shim) = self.loaded_shim() {
            let _ = unsafe { (shim.release_feature)(feature) };
        }
        #[cfg(not(ngx_core))]
        let _ = feature;
    }

    /// 分配一个参数对象（析构由 [`Parameters`] 调 `DestroyParameters`）。
    pub(super) fn allocate_parameters(&self) -> Result<Parameters, String> {
        #[cfg(not(ngx_core))]
        {
            return Err(NGX_CORE_MISSING.to_string());
        }
        #[cfg(ngx_core)]
        {
            let shim = self.loaded_shim()?;
            let mut pointer: *mut c_void = std::ptr::null_mut();
            let result = unsafe { (shim.allocate)(&mut pointer) };
            if !succeeded(result) {
                return Err(format!("NGX 分配参数对象失败：{}", describe(result)));
            }
            if pointer.is_null() {
                return Err("NGX 分配参数对象成功但指针为空".to_string());
            }
            Ok(Parameters::from_core(pointer, shim.destroy))
        }
    }
}

impl Default for NgxCore {
    fn default() -> Self {
        Self::new()
    }
}


// ── 片段（nvngx_dlssnr.dll） ────────────────────────────────────────────────

type InitExtFn = unsafe extern "system" fn(u64, *const u16, *mut c_void, u32, *mut c_void) -> NgxResult;
type CreateFeatureFn = unsafe extern "system" fn(*mut c_void, i32, *mut c_void, *mut *mut c_void) -> NgxResult;
type EvaluateFeatureFn = unsafe extern "system" fn(*mut c_void, *const c_void, *mut c_void, *const c_void) -> NgxResult;
type ReleaseFeatureFn = unsafe extern "system" fn(*mut c_void) -> NgxResult;

/// 加载好的 dlssnr 片段：DLL 句柄 + 要用的四个导出（调用者兼容层已经装好）。
///
/// 片段**不是**一个普通 DLL：它的 `Init_Ext` 要求调用方叫 `nvngx.dll`（见「调用者
/// 兼容层」一节），还要求 NGX 核心已经初始化（见 `NgxCore`）——两条都不满足时它不给
/// 错误码，而是把进程带崩（本机实测 `STATUS_ACCESS_VIOLATION`，栈在 DLL 里）。
#[allow(dead_code)]
pub struct DlssnrRuntime {
    module: HMODULE,
    init_ext: InitExtFn,
    create_feature: CreateFeatureFn,
    evaluate_feature: EvaluateFeatureFn,
    release_feature: ReleaseFeatureFn,
    /// 可选：特性自己往参数表里补默认值、读走客户端设的值（SDK 的
    /// `PopulateParameters_Impl` 流程）。
    populate_parameters: Option<unsafe extern "system" fn(*mut c_void) -> NgxResult>,
    /// `Init_Ext` 是否已经成功跑过（每次进程只跑一次，DLL 自己也是这个规矩）。
    initialized: Mutex<bool>,
}

impl DlssnrRuntime {
    /// 从 DLL 文件加载。文件缺失/导出不全都是「这条路径不可用」，不是崩溃。
    pub fn load(dll: &Path) -> Result<Self, String> {
        let (module, exports) = load_module(
            dll,
            &[
                "NVSDK_NGX_D3D12_Init_Ext",
                "NVSDK_NGX_D3D12_CreateFeature",
                "NVSDK_NGX_D3D12_EvaluateFeature",
                "NVSDK_NGX_D3D12_ReleaseFeature",
                // 第五个是 `NVSDK_NGX_D3D12_Shutdown1`：我们不用它（上下文活到进程
                // 结束；NGX 卸载自己会在退出时炸），但要它在——「五个导出齐不齐」是
                // 判断这份片段完不完整的依据。
                "NVSDK_NGX_D3D12_Shutdown1",
            ],
        )?;
        let init_ext: InitExtFn = unsafe { std::mem::transmute(exports[0]) };
        let create_feature: CreateFeatureFn = unsafe { std::mem::transmute(exports[1]) };
        let evaluate_feature: EvaluateFeatureFn = unsafe { std::mem::transmute(exports[2]) };
        let release_feature: ReleaseFeatureFn = unsafe { std::mem::transmute(exports[3]) };
        let populate_parameters = exported(module, "NVSDK_NGX_D3D12_PopulateParameters_Impl")
            .map(|address| unsafe {
                std::mem::transmute::<*const c_void, unsafe extern "system" fn(*mut c_void) -> NgxResult>(address)
            });

        // 片段要先信「调用者在 nvngx.dll 里」才肯干活：补上这一步再交出去。
        if let Err(error) = unsafe { install_caller_compatibility(module) } {
            unsafe { FreeLibrary(module) }.ok();
            return Err(format!("{} 的调用者兼容层没装上：{error}", dll.display()));
        }

        Ok(Self {
            module,
            init_ext,
            create_feature,
            evaluate_feature,
            release_feature,
            populate_parameters,
            initialized: Mutex::new(false),
        })
    }

    /// 调一次特性的 `PopulateParameters_Impl`：它在这时把客户端设的值读进自己的
    /// 状态（评估阶段再读参数表就晚了——实测评估时它读不到任何值）。
    pub(super) fn populate_parameters(&self, parameters: &Parameters) -> Result<(), String> {
        let Some(populate) = self.populate_parameters else {
            return Ok(());
        };
        let result = unsafe { populate(parameters.as_ptr()) };
        if !succeeded(result) {
            return Err(format!("PopulateParameters_Impl 失败：{}", describe(result)));
        }
        Ok(())
    }

    /// `NVSDK_NGX_D3D12_Init_Ext`：应用号 + 应用目录 + 设备 + 版本。只跑一次。
    pub fn ensure_initialized(&self, device: &ID3D12Device, data_dir: &Path) -> Result<(), String> {
        let mut initialized = self
            .initialized
            .lock()
            .map_err(|_| "DLSSNR 初始化锁失败".to_string())?;
        if *initialized {
            return Ok(());
        }
        let wide: Vec<u16> = data_dir
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            (self.init_ext)(
                DLSSNR_APPLICATION_ID,
                wide.as_ptr(),
                device.as_raw(),
                NGX_VERSION_API,
                std::ptr::null_mut(),
            )
        };
        if !succeeded(result) {
            return Err(format!("NVSDK_NGX_D3D12_Init_Ext 失败：{}", describe(result)));
        }
        *initialized = true;
        Ok(())
    }

    /// 建一个 feature 句柄（宽高由参数表里的 create 参数决定）。
    pub(super) fn create(
        &self,
        command_list: *mut c_void,
        parameters: &Parameters,
    ) -> Result<*mut c_void, String> {
        let mut feature: *mut c_void = std::ptr::null_mut();
        let result = unsafe {
            (self.create_feature)(
                command_list,
                FEATURE_DLSSNR,
                parameters.as_ptr(),
                &mut feature,
            )
        };
        if !succeeded(result) {
            return Err(format!("NVSDK_NGX_D3D12_CreateFeature 失败：{}", describe(result)));
        }
        if feature.is_null() {
            return Err("CreateFeature 成功但句柄为空".to_string());
        }
        Ok(feature)
    }

    /// 跑一次（命令表要处于录制状态）。
    pub(super) fn evaluate(
        &self,
        command_list: *mut c_void,
        feature: *mut c_void,
        parameters: &Parameters,
    ) -> Result<(), String> {
        let result = unsafe {
            (self.evaluate_feature)(command_list, feature, parameters.as_ptr(), std::ptr::null())
        };
        if !succeeded(result) {
            return Err(format!("NVSDK_NGX_D3D12_EvaluateFeature 失败：{}", describe(result)));
        }
        Ok(())
    }

    pub(super) fn release(&self, feature: *mut c_void) {
        if feature.is_null() {
            return;
        }
        // 与核心那一路同一个计数器：判据量的是「有没有真的还回 NGX」，不该因为换了哪条
        // 路就失去读数（2026-10-17 直连片段之后，产品路径走的就是这一条）。
        #[cfg(test)]
        FEATURES_RELEASED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _ = unsafe { (self.release_feature)(feature) };
    }

    pub fn module(&self) -> HMODULE {
        self.module
    }
}

impl Drop for DlssnrRuntime {
    fn drop(&mut self) {
        // 不 FreeLibrary：NGX 在 DLL 里留了线程，卸载会在退出时炸。
        let _ = self.module;
    }
}

use std::os::windows::ffi::OsStrExt;

#[cfg(test)]
mod tests {
    use super::*;
    // 崩在哪儿的那几条探针要自己读模块名（排查调用者检查时用的）。
    use windows::Win32::System::LibraryLoader::GetModuleFileNameW;

    #[test]
    fn result_codes_are_classified_the_way_ngx_defines_them() {
        assert!(succeeded(NGX_SUCCESS));
        assert!(!succeeded(NGX_FAIL_MASK | 1));
        assert!(describe(NGX_SUCCESS).starts_with("成功"));
        assert!(describe(NGX_FAIL_MASK | 5).contains("参数缺失"));
        assert!(describe(NGX_FAIL_MASK | 12).contains("版本过旧"));
    }

    /// 核心在不在这个构建里（`build.rs` 有没有链上那份静态库）。
    #[test]
    fn ngx_core_link_is_reported() {
        let probe_dir = std::env::temp_dir().join("yomika-ngx-probe");
        std::fs::create_dir_all(&probe_dir).ok();
        println!("NGX 核心：{}", if NgxCore::available(&probe_dir) { "已链上" } else { "缺席" });
    }

    /// 临时诊断：崩溃时说清楚是谁在哪儿崩的（这条路上的失败都是 AV，进程直接死，
    /// 看不到 Rust 的栈）。`AddVectoredExceptionHandler` 不在我们启用的 windows
    /// 特性里，所以按名字取。
    fn install_crash_tracer() {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;

        #[repr(C)]
        struct ExceptionRecord {
            code: i32,
            flags: u32,
            record: *mut ExceptionRecord,
            address: *mut c_void,
            number_parameters: u32,
            information: [usize; 15],
        }

        #[repr(C)]
        struct ExceptionPointers {
            exception_record: *mut ExceptionRecord,
            context_record: *mut c_void,
        }

        /// x64 的 `CONTEXT`：只要 `Rsp`(0x98) 与 `Rip`(0xF8) 两个字段。
        #[repr(C)]
        struct Context {
            _before: [u8; 0x98],
            rsp: usize,
            _between: [u8; 0xF8 - 0xA0],
            rip: usize,
        }

        type AddHandlerFn = unsafe extern "system" fn(
            u32,
            Option<unsafe extern "system" fn(*mut ExceptionPointers) -> i32>,
        ) -> *mut c_void;

        unsafe extern "system" fn handler(info: *mut ExceptionPointers) -> i32 {
            let record = unsafe { (*info).exception_record };
            if record.is_null() {
                return 0;
            }
            let record = unsafe { &*record };
            if record.code != 0xC000_0005u32 as i32 {
                return 0;
            }
            let at = record.address as usize;
            let target = record.information[1];
            let mut module = HMODULE(std::ptr::null_mut());
            let mut name = [0u16; 512];
            let mut length = 0usize;
            if unsafe {
                GetModuleHandleExW(
                    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                    PCWSTR(at as *const u16),
                    &mut module,
                )
            }
            .is_ok()
            {
                length = unsafe { GetModuleFileNameW(Some(module), &mut name) } as usize;
            }
            let context = unsafe { (*info).context_record as *const Context };
            let (rsp, rip, caller) = if context.is_null() {
                (0, 0, 0)
            } else {
                let context = unsafe { &*context };
                let caller = unsafe { *(context.rsp as *const usize) };
                (context.rsp, context.rip, caller)
            };
            eprintln!(
                "[crash] AV {} {:#x}，指令在 {:#x}（Rip {:#x}），模块 {}；调用点 {:#x}，RSP {:#x}",
                if record.information[0] == 0 { "读" } else { "写" },
                target,
                at,
                rip,
                String::from_utf16_lossy(&name[..length]),
                caller,
                rsp
            );
            let mut caller_module = HMODULE(std::ptr::null_mut());
            let mut caller_name = [0u16; 512];
            let mut caller_length = 0usize;
            if unsafe {
                GetModuleHandleExW(
                    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                    PCWSTR(caller as *const u16),
                    &mut caller_module,
                )
            }
            .is_ok()
            {
                caller_length = unsafe { GetModuleFileNameW(Some(caller_module), &mut caller_name) } as usize;
            }
            eprintln!(
                "[crash] 调用点模块 {}（基址 {:#x}，偏移 {:#x}）",
                String::from_utf16_lossy(&caller_name[..caller_length]),
                caller_module.0 as usize,
                caller.wrapping_sub(caller_module.0 as usize)
            );
            0
        }

        let Ok(kernel32) = (unsafe { GetModuleHandleW(windows::core::w!("kernel32.dll")) }) else {
            return;
        };
        let Some(add) = exported(kernel32, "AddVectoredExceptionHandler") else {
            return;
        };
        let add: AddHandlerFn = unsafe { std::mem::transmute(add) };
        unsafe { add(1, Some(handler)) };
    }

    /// 临时：确认崩溃跟踪器真的会打印（本测试必然崩，用来验证诊断本身）。
    #[test]
    fn crash_tracer_smoke_check() {
        if std::env::var("YOMIKA_CRASH_CHECK").is_err() {
            println!("跳过：没有设 YOMIKA_CRASH_CHECK");
            return;
        }
        install_crash_tracer();
        unsafe { std::ptr::write_volatile(1 as *mut u8, 0) };
    }

    /// 临时探针：按 `YOMIKA_NGX_PROBE` 指定的参数调一次核心初始化，把结果打出来。
    /// 每次只跑一种排列（崩了也只崩这一个进程）。
    #[test]
    fn probe_parameter_slots() {
        if std::env::var_os("YOMIKA_NGX_SLOTS").is_none() {
            println!("跳过：没有设 YOMIKA_NGX_SLOTS");
            return;
        }
        let dir = std::env::temp_dir().join("yomika-ngx-slot-probe");
        std::fs::create_dir_all(&dir).expect("目录");
        let core = NgxCore::new();
        let mut device = crate::dlssnr::device::create_device().expect("设备");
        core.initialize(&device, &dir, &dir).expect("初始化");
        let parameters = core.allocate_parameters().expect("参数表");
        let base = parameters.vtable_pointer();
        let names: Vec<CString> = (0..7)
            .map(|index| CString::new(format!("YOMIKA.Slot{index}")).expect("名字"))
            .collect();
        println!("每个 Set 槽位写 1.75f，再用槽位 14（片段的 float 读法）和 13 读回；");
        println!("回读缓冲先铺 0xAA，好看出读了几字节。");
        unsafe {
            for (index, name) in names.iter().enumerate() {
                let slot = *base.add(index);
                let set: unsafe extern "system" fn(*mut c_void, *const c_char, f32, *mut c_void) =
                    std::mem::transmute(slot);
                set(parameters.pointer, name.as_ptr(), 1.75, std::ptr::null_mut());
            }
        }
        for (index, name) in names.iter().enumerate() {
            let mut report = format!("Set {index}:");
            for get in [14usize, 13] {
                let mut buffer = [0xAAu8; 16];
                let slot = unsafe { *base.add(get) };
                let getter: unsafe extern "system" fn(
                    *const c_void,
                    *const c_char,
                    *mut u8,
                ) -> NgxResult = unsafe { std::mem::transmute(slot) };
                let result = unsafe { getter(parameters.pointer, name.as_ptr(), buffer.as_mut_ptr()) };
                let as_f32 = f32::from_le_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]);
                let high = u32::from_le_bytes([buffer[4], buffer[5], buffer[6], buffer[7]]);
                report += &format!(
                    "  Get{get}: code={:#x} f32={as_f32:.4} 高4字节={high:#x}",
                    result as u32
                );
            }
            println!("{report}");
        }
        let _ = device;
    }

    #[test]
    fn probe_core_init() {
        let Ok(mode) = std::env::var("YOMIKA_NGX_PROBE") else {
            println!("跳过：没有设 YOMIKA_NGX_PROBE");
            return;
        };
        install_crash_tracer();
        eprintln!("[probe] 跟踪器已装");
        let shim_dir = std::env::temp_dir().join("yomika-ngx-shim-test");
        std::fs::create_dir_all(&shim_dir).ok();
        let shim = match Shim::load(&shim_dir) {
            Ok(shim) => shim,
            Err(error) => {
                println!("跳过：{error}");
                return;
            }
        };
        eprintln!("[probe] 垫片已加载");
        let dir = tempfile::tempdir().expect("temp dir");
        let mut engine = 0i32;
        let mut version = NGX_VERSION_API;
        let mut feature_info = true;
        let mut device = Some(crate::dlssnr::device::create_device().expect("设备"));
        match mode.as_str() {
            "full" => {}
            "null-device" => device = None,
            "no-featureinfo" => feature_info = false,
            other if other.starts_with("engine=") => engine = other[7..].parse().expect("engine"),
            other if other.starts_with("version=") => {
                version = u32::from_str_radix(&other[8..], 16).expect("version")
            }
            other => panic!("不懂的模式：{other}"),
        }

        let data = wide(dir.path().as_os_str());
        let project = CString::new(NGX_PROJECT_ID).expect("项目号");
        let engine_name = CString::new(NGX_ENGINE_VERSION).expect("引擎名");
        let paths = [wide(dir.path().as_os_str())];
        let pointers: Vec<*const u16> = paths.iter().map(|path| path.as_ptr()).collect();
        let common = FeatureCommonInfo {
            path_list_info: PathListInfo {
                path: pointers.as_ptr(),
                length: pointers.len() as u32,
            },
            internal_data: std::ptr::null_mut(),
            logging_info: LoggingInfo {
                callback: std::ptr::null(),
                minimum_level: 0,
                disable_other_sinks: false,
            },
        };
        let common_pointer: *const FeatureCommonInfo = if feature_info {
            &common
        } else {
            std::ptr::null()
        };
        let device_raw = device
            .as_ref()
            .map(|device| device.as_raw())
            .unwrap_or(std::ptr::null_mut());
        if let Some(device) = device.as_ref() {
            // 复刻 SDK 那一步：device->vtable[0x158] 是不是空的？
            let raw = device as *const ID3D12Device as *const usize;
            let vtable = unsafe { *raw };
            let slot = unsafe { *((vtable + 0x158) as *const usize) };
            let luid = unsafe { device.GetAdapterLuid() };
            eprintln!(
                "[probe] 设备 {:#x}，虚表 {:#x}，槽 0x158 = {:#x}，LUID {:#x}:{:#x}",
                raw as usize, vtable, slot, luid.HighPart as u32, luid.LowPart
            );
        }
        eprintln!("[probe] 设备与参数就绪，开始调核心");
        let result = unsafe {
            (shim.init)(
                project.as_ptr(),
                engine,
                engine_name.as_ptr(),
                data.as_ptr(),
                device_raw,
                common_pointer,
                version,
            )
        };
        println!(
            "Init_with_ProjectID(engine={engine}, version={version:#x}, device={}, featureinfo={}) → {result:#010X}：{}",
            if device_raw.is_null() { "无" } else { "有" },
            if feature_info { "有" } else { "无" },
            describe(result)
        );
    }

    #[test]
    fn caller_compatibility_patches_the_snippet_import_table() {
        let Some(dll) = crate::dlssnr::tests::test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        // 真机用的那三份 DLL 都得能补上：补不上就等于这条路径整个不可用。
        let runtime = DlssnrRuntime::load(&dll).expect("加载片段");
        let module = runtime.module();
        let slot = unsafe { imported_function_slot(module, "GetModuleFileNameW") }
            .expect("片段里有 KERNEL32!GetModuleFileNameW 的导入槽");
        let hook: GetModuleFileNameWFn = snippet_get_module_file_name;
        assert_eq!(
            unsafe { std::ptr::read_volatile(slot) },
            hook as usize,
            "补完之后 IAT 那一格应当是我们"
        );

        // 钩子只对「调用者模块」改口径。
        let mut owner = HMODULE(std::ptr::null_mut());
        unsafe {
            GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                PCWSTR((hook as *const u8).cast::<u16>()),
                &mut owner,
            )
        }
        .expect("解析钩子所在模块");
        let mut name = [0u16; 512];
        let length = unsafe { hook(owner, name.as_mut_ptr(), name.len() as u32) };
        assert_eq!(
            String::from_utf16_lossy(&name[..length as usize]),
            "nvngx.dll",
            "片段问调用者时应当听到 nvngx.dll"
        );

        // 别的模块照旧转发给真 API——这条同时证明原来的函数没被弄丢。
        let length = unsafe { hook(module, name.as_mut_ptr(), name.len() as u32) };
        let forwarded = String::from_utf16_lossy(&name[..length as usize]);
        assert!(
            forwarded.to_ascii_lowercase().ends_with("nvngx_dlssnr.dll"),
            "非调用者模块要转发给真 API，实得 {forwarded:?}"
        );

        // 缓冲区不够时按 Win32 的规矩截断，并且截断处收尾。
        let mut small = [0xFFFFu16; 8];
        assert_eq!(unsafe { hook(owner, small.as_mut_ptr(), 4) }, 4);
        assert_eq!(String::from_utf16_lossy(&small[..3]), "nvn");
        assert_eq!(small[3], 0);
    }

    /// 数据目录里那份垫片旧不旧，要按内容判，不能按长度判。
    ///
    /// 同一份 `ngx_shim.c` 改两行、或者换一个 `nvsdk_ngx_s.lib` 小版本，编出来的 DLL
    /// 长度经常一样；按长度判旧会把它原封不动留下来，而 DLL 一旦被加载过就换不掉了。
    /// Task 10 第①条要的是「包里主 exe／worker／垫片同一次构建」。
    #[cfg(ngx_core)]
    #[test]
    fn a_shim_of_the_same_length_but_other_bytes_is_replaced() {
        assert!(
            EMBEDDED_SHIM.len() >= MIN_SHIM_BYTES,
            "这一份构建没编出垫片，这件事量不了"
        );
        let dir = std::env::temp_dir().join(format!("yomika-shim-stale-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let target = dir.join(SHIM_NAME);
        std::fs::write(&target, vec![0u8; EMBEDDED_SHIM.len()]).expect("放一份同长度的冒牌货");

        let picked = resolve_shim(None, None, &dir, EMBEDDED_SHIM).expect("数据目录那一份");

        assert_eq!(picked, target);
        assert_eq!(
            std::fs::read(&target).expect("读回来"),
            EMBEDDED_SHIM,
            "同长度、不同内容的旧垫片必须被换掉"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// exe 旁边放一份**别人的**垫片：不许顶掉编进二进制的那一份。
    ///
    /// 这一条不是「不给换垫片的入口」——要换用 `YOMIKA_NGX_SHIM`（本用例最后一格）。
    /// 它说的是「别处顺手放了一份外来 DLL」：那样跑的是别人的代码，症状是「一切照常、
    /// 只是跑的不是这一份构建」。
    #[cfg(ngx_core)]
    #[test]
    fn a_foreign_shim_beside_the_executable_does_not_win() {
        assert!(
            EMBEDDED_SHIM.len() >= MIN_SHIM_BYTES,
            "这一份构建没编出垫片，这件事量不了"
        );
        let dir = std::env::temp_dir().join(format!("yomika-shim-foreign-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let ours = dir.join("ours.dll");
        let foreign = dir.join("foreign.dll");
        let absent = dir.join("absent.dll");
        std::fs::write(&ours, EMBEDDED_SHIM).expect("写我们这一份");
        std::fs::write(&foreign, vec![0x4Du8; EMBEDDED_SHIM.len()]).expect("写别人的那一份");

        assert!(shim_is_current(&ours, EMBEDDED_SHIM), "编进二进制的那一份要认得出来");
        assert!(!shim_is_current(&foreign, EMBEDDED_SHIM), "同长度的另一份不是我们的");
        assert!(!shim_is_current(&absent, EMBEDDED_SHIM), "读不到就不算");

        // 「旁边那份是别人的」时不能让出去：数据目录那一份才是答案。
        let data_dir = dir.join("data");
        std::fs::create_dir_all(&data_dir).expect("建数据目录");
        let picked = resolve_shim(None, Some(foreign.clone()), &data_dir, EMBEDDED_SHIM)
            .expect("数据目录那一份");
        assert_eq!(
            picked,
            data_dir.join(SHIM_NAME),
            "外来的那一份不许顶掉这一份构建"
        );
        assert_eq!(std::fs::read(&picked).expect("读回来"), EMBEDDED_SHIM);

        // 旁边那份就是**我们这一份**时直接用它：省掉每次在数据目录里重写一遍。
        let picked = resolve_shim(None, Some(ours.clone()), &data_dir, EMBEDDED_SHIM);
        assert_eq!(picked, Some(ours), "同一次构建的一份副本可以直接用");

        // 显式覆盖（排查用）指哪儿是哪儿，哪怕内容不是我们的。
        let picked = resolve_shim(Some(foreign.clone()), None, &data_dir, EMBEDDED_SHIM);
        assert_eq!(picked, Some(foreign), "YOMIKA_NGX_SHIM 是排查用的显式入口");
        let picked = resolve_shim(Some(absent), None, &data_dir, EMBEDDED_SHIM);
        assert_eq!(
            picked,
            Some(data_dir.join(SHIM_NAME)),
            "覆盖指向不存在的路径就当没说"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
