//! 没有模型时用的整倍最近邻放大。
//!
//! 它有两个身份：没有安装模型/模型加载失败时的兜底，以及所有分块测试的参照实现
//! ——分块必须做到「和整幅一次放大逐字节相同」，否则接缝就是可见的。

use crate::error::ComputeError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CpuRgbaOutput {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// 整倍最近邻放大。`source` 是 `width * height * 4` 字节；输出受 `max_pixels` 约束
/// （手机上 4K 页 ×2 就是 3300 万像素，先拒掉比跑到一半才 OOM 好）。
pub fn cpu_scale_rgba(
    source: &[u8],
    width: u32,
    height: u32,
    scale: u32,
    max_pixels: usize,
) -> Result<CpuRgbaOutput, ComputeError> {
    if width == 0
        || height == 0
        || scale == 0
        || source.len() != width as usize * height as usize * 4
    {
        return Err(ComputeError::InvalidInput(
            "RGBA buffer dimensions do not match".to_string(),
        ));
    }
    let output_width = width
        .checked_mul(scale)
        .ok_or(ComputeError::PixelBudgetExceeded {
            pixels: usize::MAX,
            max_pixels,
        })?;
    let output_height = height
        .checked_mul(scale)
        .ok_or(ComputeError::PixelBudgetExceeded {
            pixels: usize::MAX,
            max_pixels,
        })?;
    let pixels = output_width as usize * output_height as usize;
    if pixels > max_pixels {
        return Err(ComputeError::PixelBudgetExceeded { pixels, max_pixels });
    }
    let mut rgba = vec![0_u8; pixels * 4];
    for y in 0..output_height {
        for x in 0..output_width {
            let source_index = ((y / scale) as usize * width as usize + (x / scale) as usize) * 4;
            let target_index = (y as usize * output_width as usize + x as usize) * 4;
            rgba[target_index..target_index + 4]
                .copy_from_slice(&source[source_index..source_index + 4]);
        }
    }
    Ok(CpuRgbaOutput {
        rgba,
        width: output_width,
        height: output_height,
    })
}
