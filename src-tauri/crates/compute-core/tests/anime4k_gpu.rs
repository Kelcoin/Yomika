//! Anime4K 的 GPU 执行体与 CPU 解释器的逐像素比对。
//!
//! 这是「GPU 这条路修对了」的判据：同一份解析结果、同一张探针图，两条路各跑一遍，
//! 逐通道比大小。判据取的是**最大差值 ≤ 3 个 8 位档**加**平均差值 ≤ 0.4 档**——
//! 生成器一旦把偏移量搞错、把 `mat4` 读成行主序、把 `PREKERNEL` 排到 `MAIN` 之前、
//! 或者漏掉 alpha 的搬运，差值会掉到几十上百档，这三条会同时转红。
//!
//! 想真复现「红」：把 `crates/compute-core/src/anime4k/gpu.rs` 里 `sample{i}` 的
//! `u + dx / W` 改成 `u + dy / W`（或 `matrix_constant` 里的
//! `weights[column * 4 + row]` 改成 `weights[row * 4 + column]`），跑
//! `cargo test -p yomika-compute-core --features anime4k-gpu --test anime4k_gpu`。

#![cfg(feature = "anime4k-gpu")]

use yomika_compute_core::anime4k::gpu::{adapter_description, Anime4kGpuEngine};
use yomika_compute_core::anime4k::{preset_by_id, Anime4kEngine};
use yomika_compute_core::upscale::UpscaleEngine;

/// 探针图：渐变（平滑区）、硬边棋盘（边缘）、高光带（`Clamp_Highlights` 要压的那一段）、
/// 右下角的暗块（防止「只测亮部」），alpha 也不是常数（搬运 alpha 那条路要留下证据）。
fn probe_tile(width: u32, height: u32) -> Vec<u8> {
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let fx = x as f32 / (width.max(2) - 1) as f32;
            let fy = y as f32 / (height.max(2) - 1) as f32;
            let checker = if ((x / 3) + (y / 5)) % 2 == 0 { 255.0 } else { 0.0 };
            let highlight = if (fy - 0.3).abs() < 0.08 { 255.0 } else { 1.0 };
            let dark = if fx > 0.8 && fy > 0.8 { 0.05 } else { 1.0 };
            let r = (fx * checker * highlight * dark).clamp(0.0, 255.0);
            let g = (fy * 255.0 * dark).clamp(0.0, 255.0);
            let b = ((1.0 - fx) * checker).clamp(0.0, 255.0);
            let a = if x < width / 4 { 128 } else { 255 };
            rgba.extend_from_slice(&[r as u8, g as u8, b as u8, a]);
        }
    }
    rgba
}

struct Difference {
    max: u32,
    mean: f64,
    over_two: usize,
}

fn compare(cpu: &[u8], gpu: &[u8]) -> Difference {
    assert_eq!(cpu.len(), gpu.len(), "两条路的输出长度不一样");
    let mut max = 0_u32;
    let mut total = 0_u64;
    let mut over_two = 0_usize;
    for (left, right) in cpu.iter().zip(gpu.iter()) {
        let difference = (*left as i32 - *right as i32).unsigned_abs();
        max = max.max(difference);
        total += difference as u64;
        if difference > 2 {
            over_two += 1;
        }
    }
    Difference {
        max,
        mean: total as f64 / cpu.len() as f64,
        over_two,
    }
}

/// 这台机器上有没有计算设备。拿不到就**明确跳过**并打印那句话：GPU 这条路本来就有一档
/// CPU 兜底，没有显卡不该让整轮验证变红；但「跳过」也不许冒充「量过」——整轮验证的
/// `core-gpu` 那一步会把 `跳过：这台机器上拿不到计算设备` 当成空转（见 verify-round.ps1）。
fn device_or_skip(preset_id: &str, width: u32, height: u32) -> bool {
    match adapter_description() {
        Ok(_) => true,
        Err(reason) => {
            println!("跳过：这台机器上拿不到计算设备（{reason}），{preset_id} {width}x{height} 没量");
            false
        }
    }
}

fn parity(preset_id: &str, width: u32, height: u32) {
    if !device_or_skip(preset_id, width, height) {
        return;
    }
    let preset = preset_by_id(preset_id).expect("preset exists");
    let rgba = probe_tile(width, height);
    let cpu = Anime4kEngine::open(preset)
        .expect("chain compiles")
        .upscale_tile(&rgba, width, height)
        .expect("cpu tile runs");
    let gpu = Anime4kGpuEngine::open(preset)
        .expect("gpu engine opens")
        .upscale_tile(&rgba, width, height)
        .expect("gpu tile runs");
    let difference = compare(&cpu, &gpu);
    println!(
        "{preset_id} {width}x{height}: adapter={:?} max={} mean={:.4} over_two={}/{}",
        adapter_description(),
        difference.max,
        difference.mean,
        difference.over_two,
        cpu.len()
    );
    assert!(
        difference.max <= 3,
        "{preset_id}: GPU 与 CPU 差到了 {} 档（允许 3）",
        difference.max
    );
    assert!(
        difference.mean <= 0.4,
        "{preset_id}: 平均差值 {:.4} 档，超过 0.4",
        difference.mean
    );
}

#[test]
fn a_device_is_reachable_or_the_probe_says_why() {
    match adapter_description() {
        Ok(adapter) => println!("adapter = {adapter}"),
        Err(reason) => println!("跳过：这台机器上拿不到计算设备（{reason}）"),
    }
}

#[test]
fn the_small_chain_matches_the_cpu_interpreter() {
    parity("anime4k", 64, 48);
}

#[test]
fn the_wide_chain_matches_the_cpu_interpreter() {
    parity("anime4k-hq", 48, 36);
}

#[test]
fn the_ultra_chain_matches_the_cpu_interpreter() {
    parity("anime4k-ultra", 32, 24);
}

/// 尺寸不是 8 的整数倍：派发要留出余量，读回的那个缓冲不能多算一行。
#[test]
fn an_odd_tile_size_matches_the_cpu_interpreter() {
    parity("anime4k", 17, 13);
}

/// 分块管道对这条引擎也必须是**隐形**的：同一张图「整张跑一次」与「按 32 分块 + 8 边距
/// 跑一遍」必须一字节不差。
///
/// 分块、带边距的裁剪与 blit 都是共享代码（`upscale::upscale_rgba`），但引擎这一侧拿到
/// 的是**带边距的输入**、交回去的那一块也带着边距——边界上最容易少裁一行、或者把
/// `tile_padding` 报错，而逐块比对（上面四条）永远看不到这个错：它只在多块拼接时露出来。
#[test]
fn the_tiled_pipeline_is_invisible_to_the_gpu_engine() {
    use yomika_compute_core::upscale::{upscale_rgba, UpscaleOptions};

    if !device_or_skip("anime4k", 70, 50) {
        return;
    }
    let preset = preset_by_id("anime4k").expect("preset exists");
    let engine = Anime4kGpuEngine::open(preset).expect("gpu engine opens");
    let source = probe_tile(70, 50);
    let whole = engine.upscale_tile(&source, 70, 50).expect("whole tile");
    let tiled = upscale_rgba(
        &engine,
        &source,
        70,
        50,
        UpscaleOptions {
            tile_size: 32,
            tile_padding: 8,
            ..UpscaleOptions::default()
        },
    )
    .expect("tiled upscale");

    assert_eq!((tiled.width, tiled.height), (140, 100));
    assert_eq!(
        tiled.rgba, whole,
        "分成 6 块之后与整张跑一次不一样：缝在分块/边距这一层"
    );
}
