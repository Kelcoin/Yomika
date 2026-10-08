//! 元数据那一半必须能**不带 `dlssnr` feature**编译并跑起来。
//!
//! 宿主进程不该再链 NGX（docs/71 Task 8 的出口：宿主无 ORT/NGX 资源），但它仍然要回答
//! 「设置长什么样」「装的是哪一份 DLL」「这一页的产物身份是什么」「上次探针的结论还算不算
//! 数」。这些答案不需要 NGX、不需要显卡、不需要设备，**只是数据**；把它们和引擎门在
//! 同一份 feature 后面，宿主就只能整份依赖一起留着（8-g④-b 的起因）。
//!
//! 这个文件故意不带任何 feature 编：三连里的 `core-meta` 跑的就是
//! `cargo test -p yomika-compute-core --lib --test dlssnr_metadata`。哪天有人把元数据的
//! 某一块又挪回引擎那一半，这一条会先变成编译错——那正是它存在的理由。

#![cfg(windows)]

use std::path::{Path, PathBuf};

use yomika_compute_core::dlssnr::{
    dll_identity, dll_path, forget_probe, install_dll, last_probe_for, mean_absolute_difference,
    output_revision, probe_cached_with, probe_is_valid, runtime_gate_with, status_with,
    synthetic_image, variant_of, DlssnrSettings, EngineFacts, GpuInfo, PassSettings, ProbeReport,
    Variant, DEFAULT_PASS_COUNT, MAX_PASS_COUNT,
};

fn sandbox() -> tempfile::TempDir {
    tempfile::tempdir().expect("建临时目录")
}

/// 一张够大、`MZ` 头与 PE 偏移都自洽的假片段：只过元数据那一半的检查（不加载它）。
fn fake_dll_file(dir: &Path, bytes: usize) -> PathBuf {
    let path = dir.join("nvngx_dlssnr.dll");
    let mut content = vec![0u8; bytes];
    content[0..2].copy_from_slice(b"MZ");
    let offset: u32 = 0x80;
    content[0x3c..0x40].copy_from_slice(&offset.to_le_bytes());
    std::fs::write(&path, &content).expect("写假片段");
    path
}

#[test]
fn settings_are_the_one_shape_every_side_agrees_on() {
    // 设置页、算力中心收到的请求、worker 的 DLSSNR 阶段读的是同一串字节：形状漂了不会
    // 报错，只会算出一张不一样的图。
    let json = br#"{"passes":[{"style":1,"intensity":1.5,"autoMask":true,
        "localToneStrength":1,"localStructureStrength":1,"skinStructureStrength":0,
        "uiCorrection":false}]}"#;
    let parsed = DlssnrSettings::from_json(json).expect("这一串是合法的");
    assert_eq!(parsed.pass_count(), 1, "一层");
    assert_eq!(parsed.passes[0].style, 1);
    assert!((parsed.passes[0].intensity - 1.5).abs() < 1e-6);
    assert!(parsed.passes[0].auto_mask, "camelCase 认得出");

    assert!(DlssnrSettings::from_json(b"not json").is_err());
    assert_eq!(
        DlssnrSettings::default().pass_count(),
        DEFAULT_PASS_COUNT,
        "默认层数与设置页一致"
    );

    // 越界的东西一律收回来：不给 DLL 送越界的值。
    let clamped = DlssnrSettings {
        passes: vec![
            PassSettings { style: 9, intensity: 40.0, ..PassSettings::default() };
            MAX_PASS_COUNT as usize + 2
        ],
    }
    .normalized();
    assert_eq!(clamped.pass_count(), MAX_PASS_COUNT, "最多五层");
    assert_eq!(clamped.passes[0].style, 2);
    assert!((clamped.passes[0].intensity - 2.0).abs() < 1e-6);

    // 往返一趟必须回到同一个结构（产物身份就是拿它算的）。
    let settings = DlssnrSettings {
        passes: vec![
            PassSettings { style: 2, ui_correction: true, ..PassSettings::default() },
            PassSettings::default(),
        ],
    };
    let back = DlssnrSettings::from_json(settings.to_json().as_bytes()).expect("自己写的自己读");
    assert_eq!(back, settings);
}

#[test]
fn a_page_identity_follows_the_dll_that_would_run_it() {
    let dir = sandbox();
    let settings = DlssnrSettings::default();

    let none = output_revision(dir.path(), None, &settings);
    assert!(none.starts_with("dlssnr:v3:"), "{none}");
    assert_eq!(none, output_revision(dir.path(), None, &settings), "同输入同输出");
    assert_eq!(
        none,
        output_revision(dir.path(), Some("reader-page"), &settings),
        "默认那一路就是阅读器这一页"
    );
    assert_ne!(none, output_revision(dir.path(), Some("center-page"), &settings));
    let other = DlssnrSettings {
        passes: vec![PassSettings { intensity: 1.75, ..PassSettings::default() }],
    };
    assert_ne!(none, output_revision(dir.path(), None, &other), "参数变了身份就变");
    assert_eq!(dll_identity(dir.path()), "missing", "没装片段");

    // 装上一份认不出变体的假片段：身份里要出现它的哈希与字节数，而不是还写着 missing。
    let source_dir = sandbox();
    let source = fake_dll_file(source_dir.path(), 1_000_001);
    let installed = install_dll(&source, dir.path()).expect("PE 自洽、够大，就该装进去");
    assert_eq!(installed.bytes, 1_000_001);
    assert!(installed.variant.is_none(), "README 之外的那几种认不出不算错");
    assert!(dll_path(dir.path()).is_file());
    let identity = dll_identity(dir.path());
    assert!(identity.starts_with("sha256:"), "{identity}");
    assert!(identity.ends_with(":1000001"), "{identity}");
    assert_ne!(output_revision(dir.path(), None, &settings), none, "换过片段身份就变");
}

#[test]
fn importing_a_dll_checks_its_bytes_before_it_becomes_the_one() {
    let dir = sandbox();

    let missing = install_dll(&dir.path().join("nope.dll"), dir.path());
    assert!(missing.is_err(), "读不到的文件要当场说清楚");

    let small = dir.path().join("small.dll");
    std::fs::write(&small, b"MZ").expect("写小文件");
    let error = install_dll(&small, dir.path()).expect_err("2 字节不可能是 DLSSNR 的 DLL");
    assert!(error.contains("2 字节"), "{error}");

    let text = fake_dll_file(dir.path(), 1_000_001);
    std::fs::write(&text, vec![0u8; 1_000_001]).expect("没有 MZ 头");
    let error = install_dll(&text, dir.path()).expect_err("不是 PE 就要拒绝");
    assert!(error.contains("MZ"), "{error}");

    // 头自洽但 PE 偏移越界：文件不完整。
    let broken = dir.path().join("broken.dll");
    let mut content = vec![0u8; 1_000_001];
    content[0..2].copy_from_slice(b"MZ");
    content[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
    std::fs::write(&broken, &content).expect("写越界的文件");
    let error = install_dll(&broken, dir.path()).expect_err("偏移越界要拒绝");
    assert!(error.contains("越界"), "{error}");

    assert!(!dll_path(dir.path()).is_file(), "三次拒绝都没落下东西");
}

/// 探针的记账是**进程级**的一张表：这一条与下面那条动的是同一张表，串起来跑。
static PROBE_MEMORY: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn the_probe_memory_is_keyed_by_the_dll_it_ran_on() {
    let _guard = PROBE_MEMORY.lock().expect("探针表锁");
    let dir = sandbox();
    assert!(!last_probe_for(dir.path()).is_some(), "没跑过就没有结论");
    assert!(!probe_is_valid(dir.path()), "没跑过就不算数");

    // 换片段要作废旧结论：没有引擎也能说出「这份结论不算数」。
    forget_probe();
    assert!(last_probe_for(dir.path()).is_none());
    assert!(!probe_is_valid(dir.path()));
}

#[test]
fn a_probe_that_already_answered_is_not_run_again() {
    let _guard = PROBE_MEMORY.lock().expect("探针表锁");
    let dir = sandbox();
    forget_probe();

    // 这一轮的「跑」由调用方递进来（宿主那一侧递的是计算进程）：数它被调了几次，
    // 就知道缓存这一层到底有没有拦住。
    let runs = std::cell::Cell::new(0_u32);
    let conclusion = |supported: bool| ProbeReport {
        supported,
        width: 96,
        height: 96,
        elapsed_ms: 5,
        difference: if supported { 1.0 } else { 0.0 },
        error: None,
    };
    let mut ask = |force: bool, supported: bool| {
        probe_cached_with(dir.path(), force, || {
            runs.set(runs.get() + 1);
            conclusion(supported)
        })
    };

    let first = ask(false, true);
    assert!(first.supported);
    assert_eq!(runs.get(), 1, "第一次就是跑");
    assert!(last_probe_for(dir.path()).is_some(), "跑过就记住了");
    assert!(probe_is_valid(dir.path()), "跑过的结论算数");

    // 设置页每次打开都会问一遍：同一份片段上不该再跑第二次。
    let second = ask(false, false);
    assert_eq!(runs.get(), 1, "旧结论还算数时不该再跑");
    assert!(second.supported, "拿到的是上一次的结论");

    // `force` 就是「别管旧的，再跑一次」。
    let forced = ask(true, false);
    assert_eq!(runs.get(), 2, "force 要真跑");
    assert!(!forced.supported, "force 拿到的是这一次的结论");

    // 片段换了：旧结论作废，必须重跑（用户刚导入一份新 DLL 就是这条路）。
    std::fs::create_dir_all(dll_path(dir.path()).parent().expect("片段目录")).expect("建片段目录");
    std::fs::write(dll_path(dir.path()), vec![7_u8; 2048]).expect("换一份片段");
    assert!(!probe_is_valid(dir.path()), "片段换了旧结论就不算数");
    let after_swap = ask(false, true);
    assert_eq!(runs.get(), 3, "片段换了要重跑");
    assert!(after_swap.supported);

    forget_probe();
}

#[test]
fn the_synthetic_image_and_its_pixel_difference_are_pure() {
    let image = synthetic_image(96, 96);
    assert_eq!(image.width, 96);
    assert_eq!(image.height, 96);
    assert_eq!(image.rgba.len(), 96 * 96 * 4, "宽 × 高 × 4 字节");
    assert_eq!(mean_absolute_difference(&image.rgba, &image.rgba), 0.0, "自己没有差别");

    // 探针的判据就是「算出来的那张和参照差多少」：挪一点必须看得见。
    let mut shifted = image.rgba.clone();
    shifted.rotate_left(4);
    assert!(mean_absolute_difference(&image.rgba, &shifted) > 0.05, "挪过就该超阈值");

    let smaller = synthetic_image(32, 32);
    assert_eq!(
        mean_absolute_difference(&image.rgba, &smaller.rgba),
        f64::INFINITY,
        "尺寸不一样时没有「差多少」这回事"
    );
}

/// 一台机器上一块卡，只填这一条用例关心的那些字段。
fn gpu_with_series(series: Option<u32>) -> GpuInfo {
    GpuInfo {
        name: format!("NVIDIA GeForce RTX（series {series:?}）"),
        vendor_id: 0x10DE,
        device_id: 0x2C02,
        is_nvidia: true,
        series,
        driver: Some("32.0.16.1714".to_string()),
        memory_bytes: 32_607 * 1024 * 1024,
    }
}

#[test]
fn the_runtime_gate_refuses_a_machine_it_cannot_run_on() {
    // 门控的判据是**这台机器此刻的事实**：片段在不在、有没有卡、这一代支不支持。
    // 手动检测的结论只活在进程内存里，不参与门控——拿它当门的话，每次重开应用都得先去
    // 设置页点一遍「检测」，否则 DLSSNR 静悄悄地不再生效。这条**不带 feature** 跑，
    // 所以「这台机器有什么卡」是调用方递进来的（宿主问 worker 握手 + DXGI 枚举）。
    let dir = sandbox();
    let supported = gpu_with_series(Some(50));

    // 没片段：一句人话，而且不是 Ok。
    let error =
        runtime_gate_with(dir.path(), Some(supported.clone())).expect_err("没有片段时不该放行");
    assert!(error.contains("nvngx_dlssnr.dll"), "{error}");

    // 片段装进去了，但这台机器没有可用的 N 卡。
    let source_dir = sandbox();
    let source = fake_dll_file(source_dir.path(), 1_000_001);
    install_dll(&source, dir.path()).expect("装进去");
    let error = runtime_gate_with(dir.path(), None).expect_err("没卡时不该放行");
    assert!(error.contains("NVIDIA 显卡"), "{error}");

    // 有卡，但这一代不在 DLSSNR 的支持范围（README 的对应关系只覆盖 20/30/40/50）。
    let unsupported = gpu_with_series(Some(10));
    let error = runtime_gate_with(dir.path(), Some(unsupported))
        .expect_err("代次不支持时不该放行");
    assert!(error.contains("支持范围"), "{error}");

    // 片段、卡、代次都对：放行。核心那一条（NGX 垫片在不在）不在这里问——宿主没有
    // 资格问自己，答案在 worker 那一侧（它的 `BuildInfo.engines` 里写着 dlssnr）。
    assert!(runtime_gate_with(dir.path(), Some(supported)).is_ok());
}

#[test]
fn a_status_can_be_assembled_from_facts_the_engine_told_us() {
    // 宿主摘掉 `dlssnr` feature 之后就是这样工作的：自己只答「文件在不在、是哪一份、
    // 这一页的产物身份」，引擎那两条（垫片在不在、哪块卡）由别人填。这一条**不带任何
    // feature** 就要能跑出完整的一张 `DlssnrStatus`。
    let dir = sandbox();

    // 什么都没填 = 摘掉 feature 的宿主如实的样子：说不出「能用」。
    let bare = status_with(dir.path(), EngineFacts::default());
    assert!(!bare.dll_present);
    assert!(!bare.core_available);
    assert!(!bare.installable);
    assert!(!bare.available);
    assert_eq!(bare.error.as_deref(), Some("没有找到 NVIDIA 显卡"), "第一句就说是缺卡");
    assert!(bare.probe.is_none(), "探针结论不在这一层");

    // 一张 50 系的卡 + 核心都在：这一组该显示（让用户去挑一种下载），但还没装片段，
    // 所以开关仍然锁着——「能不能开」与「要不要显示」是两件事。
    let gpu = GpuInfo {
        name: "NVIDIA GeForce RTX 5090 D".to_string(),
        vendor_id: 0x10DE,
        device_id: 0x2C02,
        is_nvidia: true,
        series: Some(50),
        driver: Some("32.0.16.1714".to_string()),
        memory_bytes: 32_607 * 1024 * 1024,
    };
    let ready = status_with(
        dir.path(),
        EngineFacts {
            core_available: true,
            gpu: Some(gpu),
        },
    );
    assert!(ready.installable, "卡与核心都在就该显示这一组");
    assert!(!ready.available, "还没装片段");
    assert_eq!(ready.gpu_name, "NVIDIA GeForce RTX 5090 D");
    assert_eq!(ready.recommended_variant.as_deref(), Some("official"), "50 系用官方原版");
    assert_eq!(ready.variant, None, "还没装片段时说不出是哪一种");
    let hint = ready.error.clone().unwrap_or_default();
    assert!(hint.contains("下载"), "该指路去下载：{hint}");
    assert!(hint.contains(&dll_path(dir.path()).display().to_string()), "{hint}");

    // 装上片段之后同一张报告就变成「现在就能跑」，而且认不出变体也不挡路。
    let source_dir = sandbox();
    let source = fake_dll_file(source_dir.path(), 1_000_001);
    install_dll(&source, dir.path()).expect("装进去");
    let boring = DlssnrSettings::default();
    let _ = output_revision(dir.path(), None, &boring);
    let live = status_with(
        dir.path(),
        EngineFacts {
            core_available: true,
            gpu: None,
        },
    );
    assert!(live.dll_present);
    assert_eq!(live.dll_bytes, Some(1_000_001));
    assert!(!live.installable, "没卡就还是开不了（卡是引擎报上来的那条事实）");
}

#[test]
fn the_variant_table_is_the_readme() {
    // 三种变体的哈希来自 docs 里的 README：认变体靠它，错一个字符就等于把「装的哪一种」
    // 判错——而那个判断决定了设置页显示哪一代卡。
    assert_eq!(Variant::Official.id(), "official");
    assert_eq!(Variant::Community40.id(), "community");
    assert_eq!(Variant::SfV2.id(), "sf-v2");
    assert_ne!(Variant::Official.label(), Variant::SfV2.label());

    assert_eq!(variant_of(0, "0011"), None, "什么都不像时不给猜的答案");
}
