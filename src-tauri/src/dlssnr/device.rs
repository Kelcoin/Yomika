//! D3D12 侧的一次性上下文：设备、队列、命令表、栅栏，以及 NGX 的初始化。
//!
//! 一页图只跑一次，所以这里不追帧率：设备与命令对象进程内建一次（NGX 的
//! `Init_Ext` 只认一块设备），纹理每次按尺寸建、用完就放。
//! 全局一把锁：GPU 侧一次只跑一个请求（阅读器本来也有单并发闸，算力中心同理）。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0;
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::IDXGIAdapter1;

use super::ngx::{NgxCore, Parameters};

/// 进程内的一块设备 + 一个 NGX 会话（核心 + 片段）。
pub struct GpuContext {
    /// NGX 核心（DLSS SDK 的静态库，经垫片 DLL）：初始化、参数对象、特性模块都由它管。
    pub core: NgxCore,

    pub device: ID3D12Device,
    pub queue: ID3D12CommandQueue,
    pub allocator: ID3D12CommandAllocator,
    pub list: ID3D12GraphicsCommandList,
    pub fence: ID3D12Fence,
    pub fence_value: u64,
    /// NGX 的应用数据目录（它在那里写日志）。
    pub data_dir: PathBuf,
    /// 当前尺寸下每个 pass 的 feature；换尺寸就整批重建（feature 与宽高绑定）。
    ///
    /// 句柄与它的**参数表绑在一起**：创建与评估共用同一个参数对象——创建那一步
    /// NGX 会往表里放内部句柄，评估时还要用。
    pub features: Vec<FeatureSlot>,
    /// 上面那批句柄是按哪个尺寸建的。
    pub feature_size: Option<(u32, u32)>,
}

/// 一个 pass：特性句柄 + 它的参数表。
pub struct FeatureSlot {
    pub handle: *mut std::ffi::c_void,
    pub parameters: Parameters,
}

// D3D12 的对象是 agile 的（windows crate 已经给它们 Send/Sync），指针都由这把锁串起来。
unsafe impl Send for GpuContext {}

static CONTEXT: OnceLock<Mutex<Option<(ContextKey, GpuContext)>>> = OnceLock::new();

/// 这份上下文是按哪一份 DLL / 哪个数据目录建出来的。
///
/// NGX 的 `Init_Ext` 只认一块设备，进程内只初始化一次；而 DLL 是可以被换掉的
/// （用户导入另一种变体、或者从目录里换一份）。换过之后不能继续用旧上下文——那会
/// 让界面显示「已换成 community 版」而显存里跑的还是刚才那一份。大小与修改时间
/// 足以认出来（165MB 的哈希每次算一遍太贵，而换文件必然两者都变）。
#[derive(Clone, PartialEq, Eq)]
struct ContextKey {
    data_dir: PathBuf,
    dll: PathBuf,
    dll_bytes: u64,
    dll_modified: Option<std::time::SystemTime>,
}

impl ContextKey {
    fn of(data_dir: &std::path::Path, dll: &std::path::Path) -> Self {
        let metadata = std::fs::metadata(dll).ok();
        Self {
            data_dir: data_dir.to_path_buf(),
            dll: dll.to_path_buf(),
            dll_bytes: metadata.as_ref().map(|value| value.len()).unwrap_or(0),
            dll_modified: metadata.and_then(|value| value.modified().ok()),
        }
    }
}

/// 拿到全局上下文（第一次调用时建）。失败会被记住：第二次调用直接报同一个错，
/// 不会反复去初始化 NGX（它出错之后进程内就不该再试）。
pub fn with_context<T>(
    data_dir: &std::path::Path,
    use_context: impl FnOnce(&mut GpuContext) -> Result<T, String>,
) -> Result<T, String> {
    let dll = super::dll_path(data_dir);
    with_context_at(data_dir, &dll, use_context)
}

/// 同上，但 DLL 由调用方点名（测试指着 docs 里的那一份；应用指着用户导入的那一份）。
pub fn with_context_at<T>(
    data_dir: &std::path::Path,
    dll: &std::path::Path,
    use_context: impl FnOnce(&mut GpuContext) -> Result<T, String>,
) -> Result<T, String> {
    let key = ContextKey::of(data_dir, dll);
    let cell = CONTEXT.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().map_err(|_| "DLSSNR 上下文锁失败".to_string())?;
    if let Some((existing, context)) = guard.as_mut() {
        if *existing != key {
            // 旧上下文还活着，NGX 也已经在进程里初始化过了：这时候换一份 DLL 是
            // 换不掉的。宁可明确报错，也不要让用户以为自己在跑新导入的那一份。
            return Err(format!(
                "DLSSNR 已经为另一份片段初始化过（{} 字节，数据目录 {}）：换过 DLL 之后要重启应用才会用新的那一份",
                existing.dll_bytes,
                existing.data_dir.display()
            ));
        }
        return use_context(context);
    }
    let context = GpuContext::create(data_dir, dll)?;
    let context = &mut guard.insert((key, context)).1;
    use_context(context)
}

impl GpuContext {
    fn create(data_dir: &std::path::Path, dll: &std::path::Path) -> Result<Self, String> {
        // 顺序不能换：核心 → 设备 → 片段。片段的 `Init_Ext` 一条也不能少（少了核心
        // 它不是报错，是崩）。
        let core = NgxCore::new();

        let device = create_device()?;
        // 片段交给核心：它按搜索路径找到 `nvngx_dlssnr.dll`、自己加载并在每次调用前
        // 把客户端设的参数喂给特性（`PopulateParameters_Impl`）——直接调片段的评估
        // 读不到任何参数（实测）。
        let feature_dir = dll.parent().unwrap_or(data_dir).to_path_buf();
        core.initialize(&device, data_dir, &feature_dir)?;
        let queue: ID3D12CommandQueue = unsafe {
            device.CreateCommandQueue(&D3D12_COMMAND_QUEUE_DESC {
                Type: D3D12_COMMAND_LIST_TYPE_COMPUTE,
                ..Default::default()
            })
        }
        .map_err(|error| format!("创建 D3D12 命令队列失败：{error}"))?;
        let allocator: ID3D12CommandAllocator =
            unsafe { device.CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_COMPUTE) }
                .map_err(|error| format!("创建命令分配器失败：{error}"))?;
        let list: ID3D12GraphicsCommandList =
            unsafe { device.CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_COMPUTE, &allocator, None) }
                .map_err(|error| format!("创建命令表失败：{error}"))?;
        // 命令表建出来就处在「录制中」：直接开始记，不用先关一次（先关再记会被
        // D3D12 拒绝，Close 也只认一次）。提交时 `execute_and_wait` 会关它，之后再
        // Reset 打开。
        let fence: ID3D12Fence =
            unsafe { device.CreateFence(0, D3D12_FENCE_FLAG_NONE) }.map_err(|error| format!("创建栅栏失败：{error}"))?;

        // NGX 只认一块设备：初始化跟着设备走，一次。
        std::fs::create_dir_all(data_dir).map_err(|error| format!("创建 DLSSNR 数据目录失败：{error}"))?;

        Ok(Self {
            core,
            device,
            queue,
            allocator,
            list,
            fence,
            fence_value: 0,
            data_dir: data_dir.to_path_buf(),
            features: Vec::new(),
            feature_size: None,
        })
    }

    /// 分配一个参数对象（NGX 核心分配，析构也还给它）。
    pub fn allocate_parameters(&self) -> Result<Parameters, String> {
        self.core.allocate_parameters()
    }

    /// 把当前记录好的命令提交掉，并等 GPU 跑完。
    pub fn execute_and_wait(&mut self) -> Result<(), String> {
        if let Err(error) = unsafe { self.list.Close() } {
            for message in info_queue_messages(&self.device) {
                eprintln!("[dlssnr] 调试层：{message}");
            }
            return Err(format!("关闭命令表失败：{error}"));
        }
        let lists = [Some(self.list.cast::<ID3D12CommandList>().map_err(|error| error.to_string())?)];
        unsafe { self.queue.ExecuteCommandLists(&lists) };

        self.fence_value += 1;
        unsafe { self.queue.Signal(&self.fence, self.fence_value) }
            .map_err(|error| format!("信号栅栏失败：{error}"))?;
        // 轮询而不是等事件：这里一次只有一张图，1ms 的粒度足够，也少一个内核对象。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while unsafe { self.fence.GetCompletedValue() } < self.fence_value {
            if std::time::Instant::now() > deadline {
                return Err("等待 GPU 超过 30 秒".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        unsafe { self.allocator.Reset() }.map_err(|error| format!("重置分配器失败：{error}"))?;
        unsafe { self.list.Reset(&self.allocator, None) }.map_err(|error| format!("重置命令表失败：{error}"))?;
        Ok(())
    }

    /// 建一张默认堆纹理。
    pub fn create_texture(
        &self,
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
        flags: D3D12_RESOURCE_FLAGS,
    ) -> Result<ID3D12Resource, String> {
        let heap = D3D12_HEAP_PROPERTIES {
            Type: D3D12_HEAP_TYPE_DEFAULT,
            ..Default::default()
        };
        let desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
            Alignment: 0,
            Width: width as u64,
            Height: height,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
            Flags: flags,
        };
        committed_resource(&self.device, &heap, &desc, D3D12_RESOURCE_STATE_COMMON)
            .map_err(|error| format!("创建纹理失败（{width}x{height}）：{error}"))
    }

    /// 把 `rgba`（RGBA8，行紧凑）传到一张默认堆纹理里。
    pub fn upload_rgba(
        &mut self,
        texture: &ID3D12Resource,
        width: u32,
        height: u32,
        bytes: &[u8],
    ) -> Result<(), String> {
        let row_pitch = width * 4;
        let aligned_pitch = (row_pitch + 255) & !255;
        let buffer_size = aligned_pitch as u64 * height as u64;
        let buffer = self.create_buffer(D3D12_HEAP_TYPE_UPLOAD, buffer_size)?;

        unsafe {
            let mut mapped: *mut std::ffi::c_void = std::ptr::null_mut();
            buffer
                .Map(0, None, Some(&mut mapped))
                .map_err(|error| format!("映射上传缓冲失败：{error}"))?;
            for row in 0..height as usize {
                let source = &bytes[row * row_pitch as usize..(row + 1) * row_pitch as usize];
                std::ptr::copy_nonoverlapping(
                    source.as_ptr(),
                    (mapped as *mut u8).add(row * aligned_pitch as usize),
                    row_pitch as usize,
                );
            }
            buffer.Unmap(0, None);
        }

        self.transition(texture, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_COPY_DEST);
        let footprint = D3D12_PLACED_SUBRESOURCE_FOOTPRINT {
            Offset: 0,
            Footprint: D3D12_SUBRESOURCE_FOOTPRINT {
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                Width: width,
                Height: height,
                Depth: 1,
                RowPitch: aligned_pitch,
            },
        };
        self.copy_buffer_to_texture(texture, &buffer, footprint);
        // 缓冲要活到 GPU 跑完：先提交再释放。
        let _ = self.execute_and_wait()?;
        self.transition(texture, D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        Ok(())
    }

    /// 建一张全零的引导图（运动/深度都按零给：静态图片没有运动，深度也按契约给零）。
    pub fn create_zero_guide(
        &mut self,
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
        bytes_per_pixel: u32,
    ) -> Result<ID3D12Resource, String> {
        let texture = self.create_texture(width, height, format, D3D12_RESOURCE_FLAGS(0))?;
        let zeros = vec![0u8; width as usize * height as usize * bytes_per_pixel as usize];
        self.upload_rgba_like(&texture, format, width, height, &zeros, bytes_per_pixel)?;
        Ok(texture)
    }

    /// `upload_rgba` 的通用版：任意像素宽度与格式（引导图用得上）。
    ///
    /// `format` 是**纹理的格式**，也是缓冲 footprint 的格式：调试层对缓冲那一侧
    /// 的 footprint 会按「Height/Depth 推出的纹理维度」检查格式，写 UNKNOWN 会被
    /// 挡下来（这里踩过一次）。
    fn upload_rgba_like(
        &mut self,
        texture: &ID3D12Resource,
        format: DXGI_FORMAT,
        width: u32,
        height: u32,
        bytes: &[u8],
        bytes_per_pixel: u32,
    ) -> Result<(), String> {
        let row_pitch = width * bytes_per_pixel;
        let aligned_pitch = (row_pitch + 255) & !255;
        let buffer = self.create_buffer(D3D12_HEAP_TYPE_UPLOAD, aligned_pitch as u64 * height as u64)?;
        unsafe {
            let mut mapped: *mut std::ffi::c_void = std::ptr::null_mut();
            buffer
                .Map(0, None, Some(&mut mapped))
                .map_err(|error| format!("映射上传缓冲失败：{error}"))?;
            for row in 0..height as usize {
                let source = &bytes[row * row_pitch as usize..(row + 1) * row_pitch as usize];
                std::ptr::copy_nonoverlapping(
                    source.as_ptr(),
                    (mapped as *mut u8).add(row * aligned_pitch as usize),
                    row_pitch as usize,
                );
            }
            buffer.Unmap(0, None);
        }
        self.transition(texture, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_COPY_DEST);
        let footprint = D3D12_PLACED_SUBRESOURCE_FOOTPRINT {
            Offset: 0,
            Footprint: D3D12_SUBRESOURCE_FOOTPRINT {
                Format: format,
                Width: width,
                Height: height,
                Depth: 1,
                RowPitch: aligned_pitch,
            },
        };
        self.copy_buffer_to_texture(texture, &buffer, footprint);
        let _ = self.execute_and_wait()?;
        self.transition(texture, D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        Ok(())
    }

    /// 把一张纹理读回紧凑的 RGBA8。
    pub fn read_back_rgba(
        &mut self,
        texture: &ID3D12Resource,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, String> {
        let row_pitch = width * 4;
        let aligned_pitch = (row_pitch + 255) & !255;
        let buffer = self.create_buffer(D3D12_HEAP_TYPE_READBACK, aligned_pitch as u64 * height as u64)?;
        self.transition(texture, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_STATE_COPY_SOURCE);
        let footprint = D3D12_PLACED_SUBRESOURCE_FOOTPRINT {
            Offset: 0,
            Footprint: D3D12_SUBRESOURCE_FOOTPRINT {
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                Width: width,
                Height: height,
                Depth: 1,
                RowPitch: aligned_pitch,
            },
        };
        let destination = D3D12_TEXTURE_COPY_LOCATION {
            pResource: std::mem::ManuallyDrop::new(Some(buffer.clone())),
            Type: D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT,
            Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { PlacedFootprint: footprint },
        };
        let source = D3D12_TEXTURE_COPY_LOCATION {
            pResource: std::mem::ManuallyDrop::new(Some(texture.clone())),
            Type: D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX,
            Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { SubresourceIndex: 0 },
        };
        unsafe { self.list.CopyTextureRegion(&destination, 0, 0, 0, &source, None) };
        self.execute_and_wait()?;

        let mut rgba = vec![0u8; row_pitch as usize * height as usize];
        unsafe {
            let mut mapped: *mut std::ffi::c_void = std::ptr::null_mut();
            let range = D3D12_RANGE { Begin: 0, End: rgba.len() };
            buffer
                .Map(0, Some(&range), Some(&mut mapped))
                .map_err(|error| format!("映射回读缓冲失败：{error}"))?;
            for row in 0..height as usize {
                let target = &mut rgba[row * row_pitch as usize..(row + 1) * row_pitch as usize];
                std::ptr::copy_nonoverlapping(
                    (mapped as *const u8).add(row * aligned_pitch as usize),
                    target.as_mut_ptr(),
                    row_pitch as usize,
                );
            }
            buffer.Unmap(0, None);
        }
        Ok(rgba)
    }

    /// 缓冲 → 纹理的一次拷贝。两侧的 `Type` 不能搞反：**纹理那侧是
    /// `SUBRESOURCE_INDEX`，缓冲那侧才是 `PLACED_FOOTPRINT`**——反了调试层会直接
    /// 说「PLACED_FOOTPRINT 只能配 DIMENSION_BUFFER 的资源」（这里踩过一次）。
    fn copy_buffer_to_texture(
        &self,
        texture: &ID3D12Resource,
        buffer: &ID3D12Resource,
        footprint: D3D12_PLACED_SUBRESOURCE_FOOTPRINT,
    ) {
        let texture_location = D3D12_TEXTURE_COPY_LOCATION {
            pResource: std::mem::ManuallyDrop::new(Some(texture.clone())),
            Type: D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX,
            Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { SubresourceIndex: 0 },
        };
        let buffer_location = D3D12_TEXTURE_COPY_LOCATION {
            pResource: std::mem::ManuallyDrop::new(Some(buffer.clone())),
            Type: D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT,
            Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { PlacedFootprint: footprint },
        };
        unsafe {
            self.list
                .CopyTextureRegion(&texture_location, 0, 0, 0, &buffer_location, None)
        };
    }

    fn create_buffer(&self, heap_type: D3D12_HEAP_TYPE, size: u64) -> Result<ID3D12Resource, String> {
        let heap = D3D12_HEAP_PROPERTIES {
            Type: heap_type,
            ..Default::default()
        };
        // 每种堆只认自己的初始状态：上传堆是 GENERIC_READ，回读堆是 COPY_DEST——
        // 给错了 CreateCommittedResource 直接 E_INVALIDARG。
        let initial = if heap_type == D3D12_HEAP_TYPE_READBACK {
            D3D12_RESOURCE_STATE_COPY_DEST
        } else {
            D3D12_RESOURCE_STATE_GENERIC_READ
        };
        let desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_BUFFER,
            Alignment: 0,
            Width: size,
            Height: 1,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: DXGI_FORMAT_UNKNOWN,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Layout: D3D12_TEXTURE_LAYOUT_ROW_MAJOR,
            Flags: D3D12_RESOURCE_FLAGS(0),
        };
        committed_resource(&self.device, &heap, &desc, initial)
            .map_err(|error| format!("创建缓冲失败（{size} 字节）：{error}"))
    }

    /// 一次状态转换（不提交，跟着同一张命令表走）。
    pub fn transition(
        &self,
        resource: &ID3D12Resource,
        from: D3D12_RESOURCE_STATES,
        to: D3D12_RESOURCE_STATES,
    ) {
        let barrier = D3D12_RESOURCE_BARRIER {
            Type: D3D12_RESOURCE_BARRIER_TYPE_TRANSITION,
            Flags: D3D12_RESOURCE_BARRIER_FLAG_NONE,
            Anonymous: D3D12_RESOURCE_BARRIER_0 {
                Transition: std::mem::ManuallyDrop::new(D3D12_RESOURCE_TRANSITION_BARRIER {
                    pResource: std::mem::ManuallyDrop::new(Some(resource.clone())),
                    Subresource: D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,
                    StateBefore: from,
                    StateAfter: to,
                }),
            },
        };
        unsafe { self.list.ResourceBarrier(&[barrier]) };
    }
}

impl Drop for GpuContext {
    fn drop(&mut self) {
        for slot in self.features.drain(..) {
            self.core.release_feature(slot.handle);
        }
    }
}

/// `CreateCommittedResource` 在 windows 0.62 里的形状是「写进一个 out 参数」，
/// 包一层让它读起来还是「返回一张资源」。
fn committed_resource(
    device: &ID3D12Device,
    heap: &D3D12_HEAP_PROPERTIES,
    desc: &D3D12_RESOURCE_DESC,
    initial: D3D12_RESOURCE_STATES,
) -> Result<ID3D12Resource, String> {
    let mut resource: Option<ID3D12Resource> = None;
    unsafe {
        device
            .CreateCommittedResource(heap, D3D12_HEAP_FLAG_NONE, desc, initial, None, &mut resource)
            .map_err(|error| error.message().to_string())?;
    }
    resource.ok_or_else(|| "D3D12 没有返回资源".to_string())
}

/// 在指定适配器上建一块 D3D12 设备；`None` 是默认适配器。
/// 打开 D3D12 调试层（机器上装了「图形工具」才有）：失败时它会在信息队列里写下
/// 原因，比一个 `0x80070057` 有用得多。
fn enable_debug_layer() {
    use windows::Win32::Graphics::Direct3D12::{D3D12GetDebugInterface, ID3D12Debug};
    let mut debug: Option<ID3D12Debug> = None;
    if unsafe { D3D12GetDebugInterface(&mut debug) }.is_ok() {
        if let Some(debug) = debug {
            unsafe { debug.EnableDebugLayer() };
        }
    }
}

fn create_device_on(adapter: Option<&IDXGIAdapter1>) -> Result<ID3D12Device, String> {
    enable_debug_layer();
    let mut device: Option<ID3D12Device> = None;
    let result = unsafe {
        match adapter {
            Some(adapter) => D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, &mut device),
            None => D3D12CreateDevice(None, D3D_FEATURE_LEVEL_11_0, &mut device),
        }
    };
    result.map_err(|error| error.message().to_string())?;
    device.ok_or_else(|| "D3D12 没有返回设备".to_string())
}

/// 建一块支持 compute 队列的设备（优先独显）。
pub(super) fn create_device() -> Result<ID3D12Device, String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|error| format!("创建 DXGI 工厂失败：{error}"))?;
    let mut index = 0u32;
    let mut last_error = String::from("没有可用的 D3D12 适配器");
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(_) => break,
        };
        index += 1;
        match create_device_on(Some(&adapter)) {
            Ok(device) => return Ok(device),
            Err(error) => last_error = error,
        }
    }
    // 没有独立适配器时退回默认设备（WARP 也能建，NGX 会在初始化时明确拒绝）。
    create_device_on(None)
        .map_err(|error| format!("创建 D3D12 设备失败：{error}（枚举适配器时最后一个是：{last_error}）"))
}


/// 调试层攒下的消息（没装调试层就是空）。
fn info_queue_messages(device: &ID3D12Device) -> Vec<String> {
    use windows::Win32::Graphics::Direct3D12::ID3D12InfoQueue;
    use windows::core::Interface;

    let Ok(queue) = device.cast::<ID3D12InfoQueue>() else {
        return Vec::new();
    };
    let count = unsafe { queue.GetNumStoredMessages() };
    let mut messages = Vec::new();
    for index in 0..count.min(16) {
        let mut size = 0usize;
        if unsafe { queue.GetMessage(index, None, &mut size) }.is_err() || size == 0 {
            continue;
        }
        let mut buffer = vec![0u8; size];
        let message = buffer.as_mut_ptr() as *mut windows::Win32::Graphics::Direct3D12::D3D12_MESSAGE;
        if unsafe { queue.GetMessage(index, Some(message), &mut size) }.is_err() {
            continue;
        }
        let message = unsafe { &*message };
        let text = unsafe {
            std::slice::from_raw_parts(message.pDescription as *const u8, message.DescriptionByteLength)
        };
        messages.push(String::from_utf8_lossy(&text[..text.len().saturating_sub(1)]).to_string());
    }
    messages
}
