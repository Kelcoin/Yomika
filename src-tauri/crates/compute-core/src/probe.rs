//! 实测结论的记账：同一个问题只该被真跑一次。
//!
//! 为什么要有这一层：[`crate::onnx::validate_runtime`] 每问一次都要开两次会话、跑两次
//! 推理（候选运行库 + CPU 参照），而超分模型是几十 MB——docs/71 对这条的要求是
//! 「GPU probe 只在冷 model/新环境执行」，也就是同一份模型问第二遍不该再花这份钱。
//!
//! 冷热怎么判？**不能**看路径，也不能只看字节数与修改时间：解包、复制、同步过来的
//! 另一份文件可以在这两项上一模一样，界面于是显示的还是换之前那份结论（`dlssnr` 那
//! 边真实踩过这个坑，`src-tauri/src/dlssnr/mod.rs` 的 `probe_key` 就是为它改成内容
//! 指纹的）。所以键里放的是**内容指纹**（字节数 + blake3，见
//! [`crate::inputs::file_fingerprint`]）。
//!
//! 这里只记账，不开会话：真正去探的是 [`crate::onnx`]。因此本模块不依赖 ORT，
//! 缓存与容量策略可以脱开 `ort` feature 单测。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::engine::ValidationVerdict;
use crate::runtime::RuntimeId;

/// 一个进程里同时用得上的「模型 × 运行库 × 探针参数」组合很少（worker 只留一份会话，
/// 宿主也只有几份包），8 条足够；满了丢最旧的一条——丢错了只是多探一次，不会把一条
/// 错误结论当成对的。
const PROBE_CACHE_ENTRIES: usize = 8;

/// 一次实测的**问题**：字段全在键里，任何一项不同都是另一个问题。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeKey {
    /// 内容指纹（blake3 十六进制），不是路径。
    pub content_hash: String,
    pub byte_length: u64,
    /// 探的是哪一类问题。超分与其它输入张量形状不同的执行体不能共用一条记账：
    /// 同一份模型文件被两类探针问过时，命中的必须是各自那一条。
    pub kind: ProbeKind,
    pub runtime: RuntimeId,
    pub scale: u32,
    pub min_input_edge: u32,
}

/// 探针问的是哪一类问题（见 [`ProbeKey::kind`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeKind {
    /// 超分：梯度瓦片按 `scale` 放大，问的是「这块图算得对不对」。
    Upscale,
}

/// 一次实测的结论，连带「这条结论花了多少次会话」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeRecord {
    pub verdict: ValidationVerdict,
    pub probes_opened: u64,
}

static CACHE: Mutex<Vec<(ProbeKey, ProbeRecord)>> = Mutex::new(Vec::new());
static PROBES_OPENED: AtomicU64 = AtomicU64::new(0);

/// 这个进程里为探针真的开了几次会话。一次完整实测通常是 2 次（候选 + CPU 参照）。
/// 它是诊断与测试用的读数，不参与任何决定。
pub fn probes_opened() -> u64 {
    PROBES_OPENED.load(Ordering::Relaxed)
}

/// 由 [`crate::onnx`] 在真的开会话之前调用：计数必须代表「试过」，而不是「成功了」。
pub fn note_probe_opened() {
    PROBES_OPENED.fetch_add(1, Ordering::Relaxed);
}

/// 问过就问得到：拿到的是**克隆**，调用方改不到表里的那一份。
pub fn recall(key: &ProbeKey) -> Option<ProbeRecord> {
    let cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    cache
        .iter()
        .find(|(known, _)| known == key)
        .map(|(_, record)| record.clone())
}

/// 记下一条结论。
///
/// 失败也记：失败那次最贵（会话开了两次，GPU 那条还可能白等一次装载），而缓存是
/// **进程级**的——下次启动进程就重新问一遍。所以偶发的驱动级失败会在本进程余下的时间
/// 里一直判成失败；这是「不回退到谎话」这一侧可以接受的代价：宁可慢一次，不可把 CPU
/// 算出来的东西说成显卡算的。
pub fn remember(key: ProbeKey, verdict: ValidationVerdict, probes_opened: u64) {
    let record = ProbeRecord {
        verdict,
        probes_opened,
    };
    let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(slot) = cache.iter_mut().find(|(known, _)| known == &key) {
        *slot = (key, record);
        return;
    }
    if cache.len() >= PROBE_CACHE_ENTRIES {
        cache.remove(0);
    }
    cache.push((key, record));
}

/// 忘掉全部结论。生产路径不需要它（要重探就直接调不带记账的那条），它存在是为了测试
/// 能从一个干净的表开始。
pub fn forget_all() {
    CACHE
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
}

/// 进程内只留一个测试锁：缓存与计数器都是全局的，几条用例并行会看见对方写进去的东西
/// （这不是缺陷，是全局状态的本性）。
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(hash: &str, runtime: RuntimeId, scale: u32) -> ProbeKey {
        ProbeKey {
            content_hash: hash.to_string(),
            byte_length: 1024,
            kind: ProbeKind::Upscale,
            runtime,
            scale,
            min_input_edge: 1,
        }
    }

    fn failed(reason: &str) -> ValidationVerdict {
        ValidationVerdict::Failed {
            reason: reason.to_string(),
        }
    }

    #[test]
    fn the_same_question_is_answered_from_the_record() {
        let _guard = test_lock();
        forget_all();
        let question = key("aa", RuntimeId::DirectMl, 3);
        assert!(recall(&question).is_none(), "一开始什么都没有");
        remember(question.clone(), failed("mean 0.270531894 > 0.001"), 2);
        let record = recall(&question).expect("记下了就该问得到");
        assert_eq!(record.verdict, failed("mean 0.270531894 > 0.001"));
        assert_eq!(record.probes_opened, 2, "一条结论背后真开过两次会话");
    }

    #[test]
    fn every_part_of_the_question_is_part_of_the_key() {
        let _guard = test_lock();
        forget_all();
        let question = key("aa", RuntimeId::DirectMl, 3);
        remember(question.clone(), ValidationVerdict::Passed, 2);
        let mut longer = key("aa", RuntimeId::DirectMl, 3);
        longer.byte_length = 2048;
        let mut wider_edge = key("aa", RuntimeId::DirectMl, 3);
        wider_edge.min_input_edge = 33;
        for other in [
            key("bb", RuntimeId::DirectMl, 3),
            key("aa", RuntimeId::Cpu, 3),
            key("aa", RuntimeId::DirectMl, 2),
            longer,
            wider_edge,
        ] {
            assert!(recall(&other).is_none(), "{other:?} 是另一个问题，不该命中");
        }
        assert!(recall(&question).is_some(), "原问题还在");
    }

    #[test]
    fn the_table_has_a_ceiling_and_drops_the_oldest() {
        let _guard = test_lock();
        forget_all();
        let newest = PROBE_CACHE_ENTRIES as u32;
        for index in 0..=newest {
            remember(
                key(&format!("{index:02}"), RuntimeId::DirectMl, 3),
                ValidationVerdict::Passed,
                2,
            );
        }
        assert!(
            recall(&key("00", RuntimeId::DirectMl, 3)).is_none(),
            "最旧的一条该被挤掉，表不能无限长"
        );
        assert!(recall(&key("01", RuntimeId::DirectMl, 3)).is_some());
        assert!(
            recall(&key(&format!("{newest:02}"), RuntimeId::DirectMl, 3)).is_some(),
            "刚记下的一定在"
        );
    }

    #[test]
    fn asking_the_same_question_again_replaces_the_verdict() {
        let _guard = test_lock();
        forget_all();
        let question = key("aa", RuntimeId::DirectMl, 3);
        remember(question.clone(), failed("第一次没过"), 2);
        remember(question.clone(), ValidationVerdict::Passed, 2);
        assert_eq!(
            recall(&question).expect("还在表里").verdict,
            ValidationVerdict::Passed,
            "后一次实测的结论说了算"
        );
        assert_eq!(
            recall(&key("aa", RuntimeId::DirectMl, 3))
                .expect("还在表里")
                .probes_opened,
            2
        );
    }

    #[test]
    fn the_counter_only_moves_when_something_really_opened_a_session() {
        let _guard = test_lock();
        let before = probes_opened();
        note_probe_opened();
        assert_eq!(probes_opened(), before + 1);
    }
}
