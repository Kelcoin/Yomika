//! worker 可执行入口（docs/71 §5.1）。
//!
//! 它**不是** Tauri 应用：只做握手、控制 IO 与「串行跑重任务」这一件事，参数全部由
//! 宿主给（管道名、身份、staging 根、日志预算）。退出码让宿主一眼看出该怎么处理：
//! 0 正常收场、2 协议大版本不符、3 对面在找另一个 worker 实例、1 其它错误。

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use yomika_compute_core::runtime;
use yomika_compute_protocol::messages::{BuildInfo, WORKER_RUNTIME_LABEL};
use yomika_compute_transport::pipe;
use yomika_compute_worker::engine::{EchoEngine, Engine};
use yomika_compute_worker::pipeline::PipelineEngine;
use yomika_compute_worker::protocol::{run, SessionOptions, SessionOutcome};

const DEFAULT_LOG_BUDGET: usize = 64 * 1024;

/// worker 里装哪个引擎。
///
/// `echo` 是 Task 3 起的协议/进程测试用件（不加载模型）；`onnx` 是 Task 7-b-ii 接进来的
/// 真超分。**默认仍是 `echo`**：宿主现在还不传这个参数（Task 7-b-iii 才接线），而且
/// 「按阶段看有没有模型来分派」是错的——那会让一次忘了带模型的生产提交静默产出一个
/// 64×64 的假产物；显式要 `onnx` 时缺东西必须响亮地失败（`COMPUTE_INPUT_INVALID`）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum EngineKind {
    Echo,
    Onnx,
}

impl EngineKind {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "echo" => Ok(Self::Echo),
            "onnx" => Ok(Self::Onnx),
            other => Err(format!("不认识的引擎 {other}：只有 echo / onnx")),
        }
    }

    /// 报给宿主的构建事实必须与**实际**装上的引擎一致（docs/71 §5.3）：`echo` 不需要
    /// 运行库，就不许拿 `"echo"` 冒充一条运行库；`onnx` 则如实报这份构建里真的注册得上
    /// 的运行库（GPU 只在 Windows 桌面构建里，所以这里可能只有 cpu）。
    fn build_info(self) -> BuildInfo {
        let (runtimes, engines) = match self {
            Self::Echo => (Vec::new(), vec!["echo".to_string()]),
            Self::Onnx => (
                runtime::available_runtimes()
                    .into_iter()
                    .map(|id| id.as_str().to_string())
                    .collect(),
                onnx_engines(),
            ),
        };
        BuildInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            runtimes,
            engines,
            model_formats: vec!["onnx".to_string()],
            // 宿主拿这一串和自己的对：对不上就不拼（Task 10 第 2 条）。这一串住在 lib 里
            // （`yomika_compute_worker::BUILD_COMMIT`），因为同一个常量还有一份字节形态要给
            // 打包核查按文件找（见那里的注释）。
            commit: yomika_compute_worker::BUILD_COMMIT.to_string(),
        }
    }
}

/// `--engine onnx` 这一档真的能跑哪几种阶段。
///
/// 名字是宿主的词汇，但这一栏报的是「worker 认得哪些授权形状」，所以 DLSSNR 要在这里
/// 出现：NGX 只有 Windows/D3D12 一版（`#[cfg(windows)] pub mod dlssnr`），非 Windows
/// 的构建里那条分派根本不存在，报了就是撒谎。这不是能力清单里的一个开关——宿主拿它
/// 判断「这份 worker 能不能接这条活」，判错的后果是请求发出去才失败。
fn onnx_engines() -> Vec<String> {
    #[cfg(windows)]
    {
        // 这三个字面量是宿主也要认的（`crates/compute-protocol` 里的常量），别在这里另写一份。
        // `anime4k` 那一项不是「有没有显卡」：这一档没有模型文件，worker 认的是内置链的
        // 授权形状（`BuiltinChainGrant`），认得的构建就在这里报出来。
        vec![
            "onnx".to_string(),
            yomika_compute_protocol::ANIME4K_ENGINE_ID.to_string(),
            yomika_compute_protocol::DLSSNR_ENGINE_ID.to_string(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![
            "onnx".to_string(),
            yomika_compute_protocol::ANIME4K_ENGINE_ID.to_string(),
        ]
    }
}

struct Args {
    pipe: String,
    epoch: String,
    nonce: u64,
    staging: PathBuf,
    inputs: PathBuf,
    engine: String,
    log_budget: usize,
}

fn value_at(argv: &[String], index: usize, flag: &str) -> Result<String, String> {
    argv.get(index + 1)
        .cloned()
        .ok_or_else(|| format!("{flag} 后面缺一个值"))
}

/// 测试钩子：只读环境变量，没设/不合法一律当 0。
///
/// 为什么用环境变量而不是命令行参数：宿主 spawn worker 时会 `env_clear()` 之后**只**传
/// 它想传的几个变量，所以「测试钩子」在生产里没有任何路径能打开——参数则可能被别处顺手
/// 拼进去。
fn test_env_millis(name: &str) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

/// 测试钩子：环境变量是不是「开」。只认 1/true/yes（大小写不敏感）。
fn test_env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|raw| {
        matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes"
        )
    })
}

fn parse_args(argv: Vec<String>) -> Result<Args, String> {
    let mut pipe = None;
    let mut epoch = None;
    let mut nonce = None;
    let mut staging = None;
    let mut inputs = None;
    let mut engine = "echo".to_string();
    let mut log_budget = DEFAULT_LOG_BUDGET;

    let mut index = 0;
    while index < argv.len() {
        let flag = argv[index].clone();
        match flag.as_str() {
            "--pipe" => {
                pipe = Some(value_at(&argv, index, "--pipe")?);
                index += 2;
            }
            "--epoch" => {
                epoch = Some(value_at(&argv, index, "--epoch")?);
                index += 2;
            }
            "--nonce" => {
                let raw = value_at(&argv, index, "--nonce")?;
                nonce = Some(
                    raw.parse::<u64>()
                        .map_err(|error| format!("--nonce 不是整数：{error}"))?,
                );
                index += 2;
            }
            "--staging" => {
                staging = Some(PathBuf::from(value_at(&argv, index, "--staging")?));
                index += 2;
            }
            "--inputs" => {
                inputs = Some(PathBuf::from(value_at(&argv, index, "--inputs")?));
                index += 2;
            }
            "--engine" => {
                engine = value_at(&argv, index, "--engine")?;
                index += 2;
            }
            "--log-budget" => {
                let raw = value_at(&argv, index, "--log-budget")?;
                log_budget = raw
                    .parse::<usize>()
                    .map_err(|error| format!("--log-budget 不是整数：{error}"))?;
                index += 2;
            }
            other => return Err(format!("不认识的参数 {other}")),
        }
    }

    Ok(Args {
        pipe: pipe.ok_or("缺 --pipe")?,
        epoch: epoch.ok_or("缺 --epoch")?,
        nonce: nonce.unwrap_or(0),
        staging: staging.ok_or("缺 --staging")?,
        inputs: inputs.ok_or("缺 --inputs")?,
        engine,
        log_budget,
    })
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(argv) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("[worker] 参数不对：{message}");
            return ExitCode::FAILURE;
        }
    };

    // 引擎名先判：一个拼错的 `--engine` 应该在连管道之前就死掉，而不是让宿主等到握手超时。
    let engine_kind = match EngineKind::parse(&args.engine) {
        Ok(kind) => kind,
        Err(message) => {
            eprintln!("[worker] 参数不对：{message}");
            return ExitCode::FAILURE;
        }
    };

    // 运行库身份先判，与引擎名同理：宿主**不再链 ONNX Runtime**，它写派生缓存的
    // 「谁算的」那一栏时只能引用协议里的 `WORKER_RUNTIME_LABEL`。这个串与这份构建
    // 真正链着的运行库对不上，宿主就会按错号记账、把不同版本的产物当成同一版——
    // 那是「一切照常、只是答案悄悄不同」的错法，必须在连管道之前就响亮地拒跑。
    if let Some(message) = runtime::runtime_label_mismatch(WORKER_RUNTIME_LABEL) {
        eprintln!("[worker] 运行库身份不对：{message}");
        return ExitCode::FAILURE;
    }

    // staging 根由宿主授权，worker 不接受一个不存在的目录里「顺手建一个」——
    // 那等于把「产物只能落在宿主给的目录」这条放松成「worker 想写哪就写哪」。
    // 输入根同理：它是 worker 唯一被允许**读**用户数据的地方，也必须由宿主先建好。
    for (flag, path) in [("staging", &args.staging), ("inputs", &args.inputs)] {
        if !path.is_dir() {
            eprintln!("[worker] {flag} 目录不存在：{}", path.display());
            return ExitCode::FAILURE;
        }
    }

    let stream = match pipe::PipeStream::connect(&args.pipe) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("[worker] 连不上管道 {}：{error}", args.pipe);
            return ExitCode::FAILURE;
        }
    };

    // 读端与写端共享同一个重叠句柄：会话线程在等读的时候，执行器还要能写出进度与
    // `artifact_ready`（同步句柄做不到这件事，会直接死锁）。
    let reader = stream.clone();
    // 先刷一次 stdout，把「程序起来了」这件事留给宿主看得见；协议帧只走管道。
    let _ = std::io::stdout().flush();

    let stage_delay = Duration::from_millis(test_env_millis("YOMIKA_WORKER_TEST_DELAY_MS"));
    let connect_hang = Duration::from_millis(test_env_millis("YOMIKA_WORKER_TEST_HANG_MS"));
    let ignore_cancel = test_env_flag("YOMIKA_WORKER_TEST_IGNORE_CANCEL");
    let claim_passthrough = test_env_flag("YOMIKA_WORKER_TEST_PASSTHROUGH");
    if stage_delay > Duration::ZERO || connect_hang > Duration::ZERO || ignore_cancel || claim_passthrough
    {
        // 别让一个手滑留在环境里的变量变成「worker 莫名其妙变慢」。
        eprintln!(
            "[worker] 测试钩子生效：stage_delay={stage_delay:?} connect_hang={connect_hang:?} ignore_cancel={ignore_cancel} claim_passthrough={claim_passthrough}"
        );
    }
    // 这几个钩子是给 echo 造的：真引擎的耗时由模型与图决定，不是睡出来的；取消牌它也
    // 必须听（分块之间会看），所以不许被钩子关掉——关掉就等于假装测过。
    if engine_kind == EngineKind::Onnx
        && (stage_delay > Duration::ZERO || ignore_cancel || claim_passthrough)
    {
        eprintln!(
            "[worker] 测试钩子（stage_delay / ignore_cancel / claim_passthrough）对 onnx 引擎无效"
        );
    }
    if connect_hang > Duration::ZERO {
        // 宿主侧的握手超时测试需要这个：一个「还没连上就先卡住」的 worker。
        std::thread::sleep(connect_hang);
    }

    // 装箱只发生在启动这一刻：`protocol::run` 对引擎类型泛型，运行期二选一必然是一次
    // 动态分派（`worker/src/engine.rs` 里有那条毯子实现）。
    let engine: Box<dyn Engine> = match engine_kind {
        EngineKind::Echo => {
            let mut echo = EchoEngine::with_stage_delay(stage_delay);
            if ignore_cancel {
                echo = echo.ignoring_cancel();
            }
            if claim_passthrough {
                echo = echo.claiming_passthrough();
            }
            Box::new(echo)
        }
        // 真引擎与页面共用同一个输入根：模型和输入都是宿主先摆好、worker 再自己复核的文件。
        EngineKind::Onnx => Box::new(PipelineEngine::new(args.inputs.clone())),
    };

    let options = SessionOptions {
        worker_epoch: args.epoch,
        nonce: args.nonce,
        staging_root: args.staging,
        input_root: args.inputs,
        build: engine_kind.build_info(),
        log_budget: args.log_budget,
        // 真回收：宿主那一侧已经没有引擎了，工作区只在这个进程里有。
        release_workspaces: yomika_compute_worker::release_workspaces,
    };

    match run(reader, stream, engine, options) {
        Ok(SessionOutcome::PeerClosed) | Ok(SessionOutcome::Shutdown) => ExitCode::SUCCESS,
        Ok(SessionOutcome::VersionMismatch) => ExitCode::from(2),
        Ok(SessionOutcome::EpochMismatch) => ExitCode::from(3),
        Err(error) => {
            eprintln!("[worker] 会话出错：{error:?}");
            ExitCode::FAILURE
        }
    }
}
