//! DLSSNR 的参数：与设置页、偏好、算力中心共用同一份形状。
//!
//! 名称与范围都对着 NGX 认的参数表来（`DLSSNR.Style` / `DLSSNR.Intensity` / … ），
//! 我们只是转手传下去。刻意**只做 NGX 认的那些**：还有一族用法是「先把图缩到低
//! 分辨率跑完再用残差重建补回来」，那要几百行计算着色器才撑得住，缺了它单把分辨率
//! 调低只会更糊，所以这里不给这个旋钮。

use serde::{Deserialize, Serialize};

/// 最多几层（同一张图串行跑几个 NGX pass；三层往上收益很小、耗时线性涨）。
pub const MAX_PASS_COUNT: u32 = 3;
pub const DEFAULT_PASS_COUNT: u32 = 1;

/// 一层 DLSSNR 的参数。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassSettings {
    /// 0 默认 / 1 自然 / 2 电影（NGX 的 `DLSSNR.Style`）。
    pub style: i32,
    pub intensity: f32,
    pub local_tone_strength: f32,
    pub local_structure_strength: f32,
    pub skin_structure_strength: f32,
    /// 自动遮罩：让网络自己圈出该处理的地方。
    pub auto_mask: bool,
    /// 界面修正：文字与线条保持原样（漫画里的拟声词、边框就是这一类）。
    pub ui_correction: bool,
}

impl Default for PassSettings {
    fn default() -> Self {
        // 保守的默认：强度类全为 1.0（保持原样），皮肤与自动遮罩默认关闭。
        Self {
            style: 0,
            intensity: 1.0,
            local_tone_strength: 1.0,
            local_structure_strength: 1.0,
            skin_structure_strength: 0.0,
            auto_mask: false,
            ui_correction: false,
        }
    }
}

impl PassSettings {
    /// 收进合法范围。设置页给的是滑杆，算力中心收到的是别人发来的数字——两边都走
    /// 这里，不给 DLL 送越界的值。
    pub fn clamped(mut self) -> Self {
        self.style = self.style.clamp(0, 2);
        self.intensity = clamp_strength(self.intensity);
        self.local_tone_strength = clamp_strength(self.local_tone_strength);
        self.local_structure_strength = clamp_strength(self.local_structure_strength);
        self.skin_structure_strength = clamp_strength(self.skin_structure_strength);
        self
    }
}

fn clamp_strength(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 2.0)
    } else {
        1.0
    }
}

/// 一次处理要跑的整套参数：1–3 层，逐层叠加。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DlssnrSettings {
    pub passes: Vec<PassSettings>,
}

impl Default for DlssnrSettings {
    fn default() -> Self {
        Self {
            passes: vec![PassSettings::default()],
        }
    }
}

impl DlssnrSettings {
    /// 收到的东西一律先过这里：层数补齐/截断、数值收范围。
    pub fn normalized(mut self) -> Self {
        if self.passes.is_empty() {
            self.passes.push(PassSettings::default());
        }
        self.passes.truncate(MAX_PASS_COUNT as usize);
        self.passes = self.passes.into_iter().map(PassSettings::clamped).collect();
        self
    }

    /// 设置页与算力中心的能力清单都显示这个：跑几层。
    pub fn pass_count(&self) -> u32 {
        self.passes.len().clamp(1, MAX_PASS_COUNT as usize) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_conservative_and_match_the_settings_page() {
        let settings = DlssnrSettings::default();
        assert_eq!(settings.pass_count(), 1);
        assert_eq!(settings.passes[0].intensity, 1.0);
        assert_eq!(settings.passes[0].skin_structure_strength, 0.0);
        assert!(!settings.passes[0].auto_mask);
        assert!(!settings.passes[0].ui_correction);
    }

    #[test]
    fn normalization_clamps_layers_and_strengths() {
        let settings = DlssnrSettings {
            passes: vec![
                PassSettings {
                    style: 9,
                    intensity: 40.0,
                    skin_structure_strength: f32::NAN,
                    ..PassSettings::default()
                },
                PassSettings::default(),
                PassSettings::default(),
                PassSettings::default(),
            ],
        }
        .normalized();
        assert_eq!(settings.passes.len(), MAX_PASS_COUNT as usize, "最多三层");
        assert_eq!(settings.passes[0].style, 2, "风格只有 0–2");
        assert_eq!(settings.passes[0].intensity, 2.0);
        assert_eq!(settings.passes[0].skin_structure_strength, 1.0, "非数落回默认");

        let empty = DlssnrSettings { passes: Vec::new() }.normalized();
        assert_eq!(empty.pass_count(), 1, "一层都没有时补一层默认");
    }

    #[test]
    fn settings_round_trip_through_json_for_the_compute_center() {
        let settings = DlssnrSettings {
            passes: vec![
                PassSettings { style: 1, intensity: 1.5, auto_mask: true, ..PassSettings::default() },
                PassSettings { style: 2, ui_correction: true, ..PassSettings::default() },
            ],
        };
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(json.contains("\"autoMask\":true"), "{json}");
        let back: DlssnrSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, settings);
    }
}
