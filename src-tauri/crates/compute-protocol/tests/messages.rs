//! 消息层的红测试（docs/71 §12.1「协议纯测试」行）：版本、顶层重复键、取值范围、
//! 路径安全、旧 epoch 过滤。这些不变量是宿主与 worker 之间唯一的信任边界，
//! 所以每一条都先用一个真实的失败例钉住。

use yomika_compute_protocol::messages::{
    encode, parse, validate_message, ArtifactReady, Budgets, EngineFallback, EnginePolicy,
    EngineReport, Message, PipelineStage, Precision, Priority, ProtocolError, Run, RunInput,
    StageProgress, PROTOCOL_MAJOR,
};

/// 一条字段齐全的 `run` 消息。下面每条负测试都从它出发改一处，这样失败一定来自
/// 被改的那一处，而不是别的字段同时不合法。
const RUN: &str = r#"{
  "protocolVersion": 1,
  "type": "run",
  "workerEpoch": "epoch-1",
  "jobId": "job-1",
  "generation": 7,
  "input": { "inputId": "in-1", "contentHash": "abc123", "byteLength": 4096 },
  "pipeline": [
    { "stageId": "s0", "modelSpecId": "realcugan-2x-conservative", "enginePolicy": "gpu", "scale": 2, "tile": 512 }
  ],
  "outputGrantId": "grant-1",
  "priority": "foreground",
  "deadlineMs": 30000,
  "budgets": { "maxPixels": 4000000, "maxOutputBytes": 67108864, "intraThreads": 2 }
}"#;

#[test]
fn a_run_message_round_trips() {
    let message = parse(RUN.as_bytes()).expect("a well formed run");
    let Message::Run(run) = &message else {
        panic!("expected a run, got {}", message.kind());
    };
    assert_eq!(run.protocol_version, PROTOCOL_MAJOR);
    assert_eq!(run.worker_epoch, "epoch-1");
    assert_eq!(run.job_id, "job-1");
    assert_eq!(run.generation, 7);
    assert_eq!(run.input.byte_length, 4096);
    // 没有授权输入时这个字段整个不出现（老客户端也照旧能发）。
    assert_eq!(run.input.relative_path, None);
    assert_eq!(run.pipeline.len(), 1);
    assert_eq!(run.pipeline[0].engine_policy, EnginePolicy::Gpu);
    assert_eq!(run.pipeline[0].scale, Some(2));
    assert_eq!(run.priority, Priority::Foreground);
    assert_eq!(run.budgets.intra_threads, 2);
    assert_eq!(message.kind(), "run");
    assert_eq!(message.epoch(), "epoch-1");
    assert!(!message.is_terminal(), "run 不是终态");

    // 编码回来必须还是同一条消息：宿主与 worker 用同一份类型，round-trip 是契约。
    let text = encode(&message).expect("encode");
    assert_eq!(parse(text.as_bytes()).expect("re-parse"), message);

    // 构造一条真正的 Run 也走一遍 encode/parse，避免只覆盖了 JSON 文本那条路径。
    let constructed = Message::Run(Run {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: "epoch-1".into(),
        job_id: "job-1".into(),
        generation: 7,
        input: RunInput {
            input_id: "in-1".into(),
            content_hash: "abc123".into(),
            byte_length: 4096,
            relative_path: None,
        },
        pipeline: vec![PipelineStage {
            accelerator: None,
            stage_id: "s0".into(),
            model_spec_id: "realcugan-2x-conservative".into(),
            engine_policy: EnginePolicy::Gpu,
            scale: Some(2),
            tile: Some(512),
            layers: None,
            settings_id: None,
            model: None,
            dlssnr: None,
            builtin: None,
            min_input_edge: None,
            output_scale: None,
        }],
        output_grant_id: "grant-1".into(),
        priority: Priority::Foreground,
        deadline_ms: 30000,
        budgets: Budgets {
            max_pixels: 4_000_000,
            max_output_bytes: 67_108_864,
            intra_threads: 2,
        },
    });
    assert_eq!(
        parse(encode(&constructed).unwrap().as_bytes()).unwrap(),
        constructed
    );

    // 没有授权就该一个字段都不发：golden JSON 与老宿主的字节都要保持不变。
    let encoded = encode(&constructed).expect("encode");
    assert!(
        !encoded.contains("relativePath"),
        "没有授权输入时不该出现 relativePath：{encoded}"
    );
}

#[test]
fn a_run_with_a_granted_input_round_trips() {
    let with_grant = RUN.replacen(
        r#""byteLength": 4096 }"#,
        r#""byteLength": 4096, "relativePath": "ab/abcd.png" }"#,
        1,
    );
    let message = parse(with_grant.as_bytes()).expect("带授权输入的 run");
    let Message::Run(run) = &message else {
        panic!("expected a run, got {}", message.kind());
    };
    assert_eq!(run.input.relative_path.as_deref(), Some("ab/abcd.png"));
    validate_message(&message).expect("合法授权路径应当过校验");
    assert_eq!(
        parse(encode(&message).unwrap().as_bytes()).unwrap(),
        message
    );
}

#[test]
fn an_input_path_that_is_not_relative_is_rejected() {
    // 协议这一层只挡形状明确不对的；落到文件系统才能判的那些（`.`/`..`/段尾
    // 空格点/重解析点）由 worker 的 `resolve_granted` 负责，两边各司其职。
    for (relative, why) in [
        (r#""/etc/passwd""#, "绝对路径"),
        (r#""\\\\server\\share\\a.png""#, "UNC"),
        (r#""C:page.png""#, "盘符"),
        (r#""page.png:stream""#, "备用数据流"),
        (r#""""#, "空"),
        (r#""a\u0000b""#, "空字节"),
    ] {
        let body = RUN.replacen(
            r#""byteLength": 4096 }"#,
            &format!(r#""byteLength": 4096, "relativePath": {relative} }}"#),
            1,
        );
        let parsed = parse(body.as_bytes());
        let message = match parsed {
            Ok(message) => message,
            Err(_) => continue, // JSON 层面就过不去也算拒绝
        };
        let error = validate_message(&message).expect_err(why);
        assert!(
            matches!(error, ProtocolError::OutOfRange { .. }),
            "{why} 应当被判成越界，实际 {error:?}"
        );
    }
}

#[test]
fn a_run_with_a_granted_model_round_trips() {
    // 模型和页面走同一条授权通道：宿主把 `modelSpecId` 解析成一份放进输入根的文件，
    // run 里只留相对路径 + 声明。worker 自己再解析、再复核一遍（§7.1/§7.2）。
    let body = RUN.replacen(
        r#""tile": 512 }"#,
        r#""tile": 512, "model": { "relativePath": "ab/abcd.onnx", "contentHash": "deadbeef", "byteLength": 1048576 }, "minInputEdge": 20 }"#,
        1,
    );
    let message = parse(body.as_bytes()).expect("带模型授权的 run");
    validate_message(&message).expect("合法模型授权应当过校验");
    let Message::Run(run) = &message else {
        panic!("expected a run, got {}", message.kind());
    };
    let model = run.pipeline[0].model.as_ref().expect("模型授权");
    assert_eq!(model.relative_path, "ab/abcd.onnx");
    assert_eq!(model.content_hash, "deadbeef");
    assert_eq!(model.byte_length, 1_048_576);
    assert_eq!(run.pipeline[0].min_input_edge, Some(20));
    assert_eq!(
        parse(encode(&message).unwrap().as_bytes()).unwrap(),
        message
    );

    // 没有模型的阶段一个字段都不发：老宿主收不到自己不认识的东西，字节也不变。
    let plain = parse(RUN.as_bytes()).expect("run");
    assert_eq!(plain_pipeline_stage(&plain).model, None);
    let encoded = encode(&plain).expect("encode");
    assert!(
        !encoded.contains(r#""model""#) && !encoded.contains("minInputEdge"),
        "没有模型授权时不该出现 model/minInputEdge 字段：{encoded}"
    );
}

fn plain_pipeline_stage(message: &Message) -> &PipelineStage {
    let Message::Run(run) = message else {
        panic!("expected a run, got {}", message.kind());
    };
    run.pipeline.first().expect("一个阶段")
}

#[test]
fn accelerator_cannot_cross_the_boundary_without_a_model_or_with_an_unsafe_path() {
    let grant = r#"{ "relativePath": "ab/abcd.tflite", "contentHash": "deadbeef", "byteLength": 100 }"#;
    let body = RUN.replacen(r#""tile": 512 }"#, &format!(r#""tile": 512, "accelerator": {grant} }}"#),1);
    assert!(parse(body.as_bytes()).is_err());
    let body = RUN.replacen(r#""tile": 512 }"#, &format!(r#""tile": 512, "model": {grant}, "accelerator": {grant} }}"#),1);
    assert!(parse(body.as_bytes()).is_ok());
    assert!(parse(body.replace("ab/abcd.tflite","C:/escape.tflite").as_bytes()).is_err());
}

#[test]
fn a_model_grant_with_impossible_numbers_is_rejected() {
    // 长度上限与输入同一条护栏：模型是几十 MB 的东西，但 1 GiB 之外一定是错的。
    // `parse` 内部就会跑 `validate_message`，所以这里直接断言解析失败——那正是
    // 真实链路上第一个拒绝点（宿主与 worker 都不必自己再查一遍）。
    for (model_json, expected_field, why) in [
        (
            r#"{ "relativePath": "ab/abcd.onnx", "contentHash": "deadbeef", "byteLength": 0 }"#,
            "model.byteLength",
            "长度 0（协议里 0 字节的文件不存在）",
        ),
        (
            r#"{ "relativePath": "ab/abcd.onnx", "contentHash": "deadbeef", "byteLength": 99999999999 }"#,
            "model.byteLength",
            "长度超上限",
        ),
        (
            r#"{ "relativePath": "ab/abcd.onnx", "contentHash": "", "byteLength": 4096 }"#,
            "model.contentHash",
            "空 hash",
        ),
    ] {
        let body = RUN.replacen(
            r#""tile": 512 }"#,
            &format!(r#""tile": 512, "model": {model_json} }}"#),
            1,
        );
        let error = parse(body.as_bytes()).expect_err(why);
        let ProtocolError::OutOfRange { field, .. } = &error else {
            panic!("{why} 应当被判成越界，实际 {error:?}");
        };
        assert_eq!(field, expected_field, "{why}");
    }
}

#[test]
fn a_model_path_that_is_not_relative_is_rejected() {
    for (relative, why) in [
        (r#""/models/a.onnx""#, "绝对路径"),
        (r#""\\\\server\\share\\a.onnx""#, "UNC"),
        (r#""C:a.onnx""#, "盘符"),
        (r#""a.onnx:stream""#, "备用数据流"),
        (r#""""#, "空"),
    ] {
        let body = RUN.replacen(
            r#""tile": 512 }"#,
            &format!(
                r#""tile": 512, "model": {{ "relativePath": {relative}, "contentHash": "deadbeef", "byteLength": 4096 }} }}"#
            ),
            1,
        );
        let parsed = parse(body.as_bytes());
        let message = match parsed {
            Ok(message) => message,
            Err(_) => continue, // JSON 层面就过不去也算拒绝
        };
        let error = validate_message(&message).expect_err(why);
        let ProtocolError::OutOfRange { field, .. } = &error else {
            panic!("{why} 应当被判成越界，实际 {error:?}");
        };
        assert_eq!(field, "model.relativePath", "{why}");
    }
}

#[test]
fn a_min_input_edge_outside_the_range_is_rejected() {
    for edge in ["0", "4097"] {
        let body = RUN.replacen(
            r#""tile": 512 }"#,
            &format!(r#""tile": 512, "minInputEdge": {edge} }}"#),
            1,
        );
        let error = parse(body.as_bytes()).expect_err(&format!("minInputEdge {edge}"));
        let ProtocolError::OutOfRange { field, .. } = &error else {
            panic!("minInputEdge {edge} 应当被判成越界，实际 {error:?}");
        };
        assert_eq!(field, "minInputEdge");
    }
}

#[test]
fn an_unknown_major_version_is_rejected() {
    let body = RUN.replacen(r#""protocolVersion": 1"#, r#""protocolVersion": 99"#, 1);
    let error = parse(body.as_bytes()).expect_err("version 99");
    assert_eq!(error, ProtocolError::UnknownVersion { found: 99 });
}

#[test]
fn a_missing_version_is_rejected() {
    let body = RUN.replacen(r#""protocolVersion": 1,"#, "", 1);
    let error = parse(body.as_bytes()).expect_err("no version");
    assert_eq!(error, ProtocolError::MissingVersion);
}

#[test]
fn a_top_level_repeated_field_is_rejected() {
    // serde_json 的 map 会静默留下最后一个，所以这一条必须由我们自己在反序列化
    // 之前拦住：否则「谁先谁后」就能决定一份配置的语义。
    let body = RUN.replacen(
        r#""deadlineMs": 30000,"#,
        r#""deadlineMs": 30000, "jobId": "job-2","#,
        1,
    );
    let error = parse(body.as_bytes()).expect_err("duplicate jobId");
    assert_eq!(error, ProtocolError::DuplicateField("jobId".into()));
}

#[test]
fn an_unknown_top_level_field_is_rejected() {
    let body = RUN.replacen(
        r#""deadlineMs": 30000,"#,
        r#""deadlineMs": 30000, "wat": 1,"#,
        1,
    );
    let error = parse(body.as_bytes()).expect_err("unknown field");
    let ProtocolError::Malformed(detail) = &error else {
        panic!("expected Malformed, got {error:?}");
    };
    assert!(detail.contains("wat"), "{detail}");
}

#[test]
fn a_missing_required_field_is_rejected() {
    let body = RUN.replacen(r#""generation": 7,"#, "", 1);
    let error = parse(body.as_bytes()).expect_err("no generation");
    let ProtocolError::Malformed(detail) = &error else {
        panic!("expected Malformed, got {error:?}");
    };
    assert!(detail.contains("generation"), "{detail}");
}

#[test]
fn an_out_of_range_scale_is_rejected() {
    let body = RUN.replacen(r#""scale": 2"#, r#""scale": 9"#, 1);
    let error = parse(body.as_bytes()).expect_err("scale 9");
    let ProtocolError::OutOfRange { field, .. } = &error else {
        panic!("expected OutOfRange, got {error:?}");
    };
    assert_eq!(field, "scale");
}

#[test]
fn an_out_of_range_tile_is_rejected() {
    // tile 是 0（自动）或 >= 32；8 既不是自动也小到会让内核越界。
    let body = RUN.replacen(r#""tile": 512"#, r#""tile": 8"#, 1);
    let error = parse(body.as_bytes()).expect_err("tile 8");
    let ProtocolError::OutOfRange { field, .. } = &error else {
        panic!("expected OutOfRange, got {error:?}");
    };
    assert_eq!(field, "tile");
}

#[test]
fn an_out_of_range_deadline_budget_and_thread_count_are_rejected() {
    for (needle, replacement) in [
        (r#""deadlineMs": 30000"#, r#""deadlineMs": 0"#),
        (r#""intraThreads": 2"#, r#""intraThreads": 0"#),
        (r#""intraThreads": 2"#, r#""intraThreads": 4096"#),
        (r#""maxPixels": 4000000"#, r#""maxPixels": 0"#),
        (r#""maxOutputBytes": 67108864"#, r#""maxOutputBytes": 0"#),
    ] {
        let body = RUN.replacen(needle, replacement, 1);
        match parse(body.as_bytes()) {
            Err(ProtocolError::OutOfRange { .. }) => {}
            Err(other) => panic!("{replacement} should be OutOfRange, got {other:?}"),
            Ok(message) => panic!("{replacement} was accepted as {}", message.kind()),
        }
    }
}

#[test]
fn a_non_finite_or_out_of_range_progress_percent_is_rejected() {
    // NaN 没法写进 JSON 文本，但 worker 内部是直接构造类型的，所以校验函数
    // 必须自己守这一关（docs/71 §6.2「有限浮点」）。
    for percent in [f32::NAN, f32::INFINITY, -1.0, 100.5] {
        let message = Message::Progress(StageProgress {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: "epoch-1".into(),
            job_id: "job-1".into(),
            generation: 7,
            stage_id: "s0".into(),
            percent,
        });
        let error = validate_message(&message).expect_err("bad percent");
        let ProtocolError::OutOfRange { field, .. } = &error else {
            panic!("expected OutOfRange for {percent}, got {error:?}");
        };
        assert_eq!(field, "percent");
    }
    // 合法的一边也要钉住，否则「拒绝一切」也能过上面的断言。
    let good = Message::Progress(StageProgress {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: "epoch-1".into(),
        job_id: "job-1".into(),
        generation: 7,
        stage_id: "s0".into(),
        percent: 42.5,
    });
    assert!(validate_message(&good).is_ok());
}

fn artifact_ready(relative_name: &str) -> Message {
    Message::ArtifactReady(ArtifactReady {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: "epoch-1".into(),
        job_id: "job-1".into(),
        generation: 7,
        stage_id: "s0".into(),
        artifact_id: "artifact-1".into(),
        output_grant_id: "grant-1".into(),
        relative_name: relative_name.into(),
        content_hash: "a".repeat(64),
        mime: "image/png".into(),
        byte_length: 1024,
        width: 512,
        height: 768,
        engine: EngineReport {
            id: "onnxruntime".into(),
            version: "1.29.0".into(),
            precision: Precision::Fp32,
            device_id: "CPUExecutionProvider".into(),
            // 老 worker 的形态：政策与回退都没有（两个字段都是可选的）。
            policy: None,
            fallback: None,
        },
        pipeline_revision: "rev-1".into(),
    })
}

/// 从一份合法的 `artifact_ready` 出发、只换引擎报告那一栏：这样失败一定来自被换的
/// 那一栏，而不是别的字段同时不合法。
fn with_engine(engine: EngineReport) -> Message {
    let Message::ArtifactReady(mut ready) = artifact_ready("s0.png") else {
        panic!("artifact_ready 必须是 ArtifactReady");
    };
    ready.engine = engine;
    Message::ArtifactReady(ready)
}

/// 回退交代要么不说，要么说全「想要谁 / 用了谁 / 为什么」，而且必须自洽。
///
/// 这条为什么值得一个协议测试：界面就靠这一栏把「我点名要显卡」与「自动回退到 CPU」
/// 分开呈现（docs/71:126 的「强制 GPU 不得静默变成 CPU；auto 可显式回退并展示原因」）。
/// 半句交代比没有更坏——只有 `used` 没有原因，界面就只能猜。
#[test]
fn a_fallback_report_must_say_which_runtime_replaced_which_and_why() {
    let engine = |fallback: Option<EngineFallback>| EngineReport {
        id: "onnx".into(),
        version: "ort-api13".into(),
        precision: Precision::Fp32,
        device_id: "cpu".into(),
        policy: Some(EnginePolicy::Auto),
        fallback,
    };

    // 说全了：合法，而且线上就是这个形状（`policy` 与 `fallback` 都要出现）。
    let reported = with_engine(engine(Some(EngineFallback {
        requested: "directml".into(),
        used: "cpu".into(),
        reason: "directml 在这台机器上不可用（没装上，或没有可用设备）".into(),
    })));
    assert!(validate_message(&reported).is_ok());
    let text = encode(&reported).expect("encode");
    assert!(text.contains(r#""policy":"auto""#), "{text}");
    // 不按字段顺序断言：`encode` 走的是排过序的映射，这里的意图是「三栏都在线上」。
    assert!(text.contains(r#""fallback":{"#), "{text}");
    assert!(text.contains(r#""requested":"directml""#), "{text}");
    assert!(text.contains(r#""used":"cpu""#), "{text}");
    assert!(text.contains(r#""reason":"directml 在这台机器上不可用"#), "{text}");
    assert_eq!(parse(text.as_bytes()).expect("re-parse"), reported);

    // 老 worker 那一侧：两栏都没有，照样合法，而且**不许**凭空多出字段。
    let quiet = with_engine(engine(None));
    assert!(validate_message(&quiet).is_ok());
    let text = encode(&quiet).expect("encode");
    assert!(!text.contains(r#""fallback""#), "{text}");

    // 「回退到同一条运行库」不是回退。
    let same = with_engine(engine(Some(EngineFallback {
        requested: "cpu".into(),
        used: "cpu".into(),
        reason: "说是回退了，其实没换".into(),
    })));
    let error = validate_message(&same).expect_err("requested == used 不叫回退");
    let ProtocolError::OutOfRange { field, .. } = &error else {
        panic!("expected OutOfRange, got {error:?}");
    };
    assert_eq!(field, "engine.fallback.used");

    // 原因会被原样带到界面上，所以长度也要有上限。
    let verbose = with_engine(engine(Some(EngineFallback {
        requested: "directml".into(),
        used: "cpu".into(),
        reason: "很".repeat(200),
    })));
    let error = validate_message(&verbose).expect_err("原因不能超长");
    let ProtocolError::OutOfRange { field, .. } = &error else {
        panic!("expected OutOfRange, got {error:?}");
    };
    assert_eq!(field, "engine.fallback.reason");
}

#[test]
fn an_artifact_name_that_climbs_out_of_the_grant_directory_is_rejected() {
    // 输出只传 metadata，文件名由 worker 给、由宿主拼到 grant 目录里：如果这里
    // 放行 `..` 或分隔符，worker 就能写到 grant 之外（docs/71 §7.2）。
    for name in ["../escape.png", "sub/dir.png", r"sub\dir.png", "", "..", "a/../../b.png"] {
        let error = validate_message(&artifact_ready(name)).expect_err("unsafe name");
        let ProtocolError::OutOfRange { field, .. } = &error else {
            panic!("expected OutOfRange for {name:?}, got {error:?}");
        };
        assert_eq!(field, "relativeName");
    }
    // 正常的一边：单个文件名要能过。
    assert!(validate_message(&artifact_ready("s0.png")).is_ok());
    assert!(validate_message(&artifact_ready("页-001.png")).is_ok());
}

#[test]
fn a_stale_worker_epoch_message_is_filtered_out() {
    let message = parse(RUN.as_bytes()).expect("run");
    assert!(message.matches_epoch("epoch-1"), "自己的 epoch 必须通过");
    assert!(
        !message.matches_epoch("epoch-2"),
        "上一个 worker 进程迟到的消息不能再改当前任务的状态"
    );
}

#[test]
fn a_run_with_a_dlssnr_grant_round_trips() {
    // DLSSNR 的两样东西也走同一条授权通道：一份**按内容寻址**的片段 DLL，与一份参数
    // JSON。片段为什么不是帧里的一段自由文本——NGX 只按固定文件名找它，所以 worker 拿
    // 到的必须是**字节**，名字由 worker 按自己的规矩落成 `dlssnr/nvngx_dlssnr.dll`；
    // 而「交过来的真是那一份」这件事和模型一样要能复核（相对路径 + hash + 长度）。
    let body = RUN.replacen(
        r#""tile": 512 }"#,
        r#""tile": 512, "dlssnr": { "feature": { "relativePath": "ab/abcd.dll", "contentHash": "deadbeef", "byteLength": 165000000 }, "settings": { "relativePath": "cd/cdef.json", "contentHash": "cafebabe", "byteLength": 128 } } }"#,
        1,
    );
    let message = parse(body.as_bytes()).expect("带 DLSSNR 授权的 run");
    validate_message(&message).expect("带 DLSSNR 授权应当过校验");
    let Message::Run(run) = &message else {
        panic!("expected a run, got {}", message.kind());
    };
    let grant = run.pipeline[0].dlssnr.as_ref().expect("dlssnr 授权");
    assert_eq!(grant.feature.byte_length, 165_000_000);
    assert_eq!(grant.settings.relative_path, "cd/cdef.json");
    assert_eq!(
        parse(encode(&message).unwrap().as_bytes()).unwrap(),
        message
    );
}

#[test]
fn a_stage_that_carries_two_kinds_of_grant_is_rejected() {
    // 一个阶段的输入是**页面本身**：同一页没法既按 DLSSNR 的一层参数重绘、又拿去当
    // 超分的输入。说不清的请求在协议层就该被挡下——worker 那边若靠猜，猜错的那
    // 一种会变成一张看起来对、其实没处理过的图。
    let dlssnr = r#""dlssnr": { "feature": { "relativePath": "ab/abcd.dll", "contentHash": "deadbeef", "byteLength": 165000000 }, "settings": { "relativePath": "cd/cdef.json", "contentHash": "cafebabe", "byteLength": 128 } }"#;
    for extra in [
        r#", "model": { "relativePath": "ab/abcd.onnx", "contentHash": "deadbeef", "byteLength": 1048576 }"#,
    ] {
        let body = RUN.replacen(
            r#""tile": 512 }"#,
            &format!(r#""tile": 512, {dlssnr}{extra} }}"#),
            1,
        );
        // 拒绝可以发生在解析那一步、也可以在 `validate_message` 那一步——两条路都算
        // 「没被收下」（协议里 `parse` 自己就会校验，负测试不该钉死它驻在哪一层）。
        let error = match parse(body.as_bytes()) {
            Err(error) => error,
            Ok(message) => validate_message(&message).expect_err("两种授权同时出现要判非法"),
        };
        let ProtocolError::OutOfRange { field, .. } = &error else {
            panic!("expected OutOfRange, got {error:?}");
        };
        // 与上面那条同一个约定：这一栏报规则的名字，字面量跟着最新那一栏（`builtin`）走。
        assert_eq!(field, "builtin");
    }
}

/// 内置链那一栏与另外两栏都互斥。
///
/// 它与「模型 + DLSSNR」那种互斥不是同一件事：内置链交的是一句**身份**而不是文件，所以
/// 同乘的后果不是「多摆一份文件」，而是**这条阶段到底要不要文件**说不清——一条来路要
/// 读模型、一条只在两边编着的着色器里跑。说不清的请求在协议层就该被挡下。
#[test]
fn a_builtin_chain_cannot_ride_along_with_any_file_grant() {
    let builtin = r#", "builtin": { "chainId": "anime4k-hq", "version": "2-1", "scale": 2 }"#;
    for extra in [
        r#", "model": { "relativePath": "ab/abcd.onnx", "contentHash": "deadbeef", "byteLength": 4096 }"#,
        r#", "dlssnr": { "feature": { "relativePath": "ab/abcd.dll", "contentHash": "deadbeef", "byteLength": 165000000 }, "settings": { "relativePath": "cd/cdef.json", "contentHash": "cafebabe", "byteLength": 128 } }"#,
    ] {
        let body = RUN.replacen(
            r#""tile": 512 }"#,
            &format!(r#""tile": 512{builtin}{extra} }}"#),
            1,
        );
        let error = match parse(body.as_bytes()) {
            Err(error) => error,
            Ok(message) => validate_message(&message).expect_err("两种授权同时出现要判非法"),
        };
        let ProtocolError::OutOfRange { field, .. } = &error else {
            panic!("expected OutOfRange, got {error:?}");
        };
        assert_eq!(field, "builtin");
    }
}

#[test]
fn a_workspaces_released_message_round_trips() {
    // `release_idle` 是**请求**，这一条是它唯一的结果。宿主把 idle 当成一次真的资源
    // 动作（docs/71 §8.4：交回之后 private commit 要回落），所以 worker 必须报「这次
    // 交回了几份」，而不是只说一声「收到了」。没有这一格，宿主就分不清「交回了 0 份」
    // 与「根本没交回」——两者在界面上是同一句话，在内存曲线上是两件事。
    const BODY: &str = r#"{
  "protocolVersion": 1,
  "type": "workspaces_released",
  "workerEpoch": "epoch-1",
  "count": 3
}"#;
    let message = parse(BODY.as_bytes()).expect("workspaces_released");
    assert_eq!(message.kind(), "workspaces_released");
    assert_eq!(message.epoch(), "epoch-1");
    validate_message(&message).expect("应当过校验");
    let Message::WorkspacesReleased(released) = &message else {
        panic!("expected workspaces_released, got {}", message.kind());
    };
    assert_eq!(released.count, 3, "交回了几份是这条消息的全部内容");
    assert_eq!(released.protocol_version, PROTOCOL_MAJOR);
    assert_eq!(parse(encode(&message).unwrap().as_bytes()).unwrap(), message);
}

#[test]
fn a_workspaces_released_count_that_could_not_be_real_is_rejected() {
    // 上界不是防坏人（对面是本机那一个 worker），是防「记账坏了」：这一格会直接进界面，
    // 一个四位以上的数字没人能一眼看出是错的。
    let body = r#"{
  "protocolVersion": 1,
  "type": "workspaces_released",
  "workerEpoch": "epoch-1",
  "count": 999999
}"#;
    let error = parse(body.as_bytes()).expect_err("count 离谱");
    let ProtocolError::OutOfRange { field, .. } = &error else {
        panic!("expected OutOfRange, got {error:?}");
    };
    assert_eq!(field, "count");
}

/// 协议大版本不符要能被**单独认出来**（Task 10 第 2 条：「版本错配安全拒绝」）。
///
/// 宿主对这两种现场的处置不一样：帧坏了（`Malformed`）是「这一代 worker 出事了」，
/// 走崩溃那本账；大版本不符（`UnknownVersion`）是「这份 worker 不是给这个宿主编的」，
/// 拒跑一次就够——重启三次再撞三次只是把同一件事重说三遍，用户还得先等 14 秒退避。
/// 分不出这两种，就只能按最坏的那条走。
#[test]
fn a_foreign_protocol_major_is_recognised_as_a_version_mismatch() {
    let foreign = ProtocolError::UnknownVersion { found: 2 };
    assert!(
        foreign.is_version_mismatch(),
        "大版本不符要认得出来，宿主才敢按「拒跑」处理"
    );
    let broken = ProtocolError::Malformed("body 不是 JSON".to_string());
    assert!(
        !broken.is_version_mismatch(),
        "帧坏了不是版本不符：混成一种，真正的损坏就逃过了退避"
    );
    let missing = ProtocolError::MissingVersion;
    assert!(
        !missing.is_version_mismatch(),
        "缺 version 是畸形消息，不是「对面说的是另一个大版本」"
    );
}
