//! 「独立进程闭环」——docs/71 §11 Task 3 退出条件里唯一不能用内存双工证明的那半条。
//!
//! `tests/worker_protocol.rs` 证明的是会话状态机；这一条证明的是**真的会有一个单独的
//! worker 进程**：宿主建私有命名管道 → spawn worker 可执行文件（固定路径、隐藏窗口、
//! 最小环境）→ worker 主动连上来 → peer PID 就是本次 spawn 的那个 PID → 握手 → 跑完
//! 一个 echo 任务、产物真的落在 staging 里且 blake3 对得上 → 收到 shutdown 后退出码 0
//! （没有孤儿进程）。
//!
//! 这个测试自己扮演宿主，并且只用到 §6.1 里「宿主该做」的那几件里最便宜的一批：
//! 固定路径、`CREATE_NO_WINDOW`、`env_clear` 之后只给 `SystemRoot`/`TEMP`、PID 核对、
//! epoch（里面带 nonce）核对。**显式 DACL 不在这里**：构造「只允许当前登录 SID」的
//! SECURITY_DESCRIPTOR 要 SID/ACL 那一套 API，它跟宿主监督器同生共死（Task 4），
//! 这里先用默认安全描述符（令牌默认 DACL 不含 Everyone），docs/75 如实写明这个缺口。
//!
//! Task 7-b-ii 起这个文件还多了一层：`--engine onnx` 的真引擎在真进程里跑一张真图，
//! 输入与**模型**都从输入根按声明取（`the_real_engine_upscales_a_granted_page_with_a_granted_model`）。

#![cfg(windows)]

use std::fs;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use windows::core::HSTRING;
use windows::Win32::Foundation::{
    ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_READMODE_BYTE,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

use yomika_compute_protocol::messages::{
    ArtifactReady, ArtifactRef, Budgets, EnginePolicy, EpochOnly, Failed, GrantedFile, Hello,
    HelloAck, Message, Ping, PipelineStage, Precision, Priority, Run, RunInput, PROTOCOL_MAJOR,
};
use yomika_compute_protocol::{encode, parse, read_frame, write_frame, MAX_FRAME_BYTES};
use yomika_compute_transport::pipe::PipeStream;

/// `CREATE_NO_WINDOW`：worker 是控制台程序，但没有窗口可给用户看。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// worker 卡住时不让测试永远挂着：看门狗到点就杀进程，读管道会立刻拿到 broken pipe。
const WATCHDOG: Duration = Duration::from_secs(30);
/// 诊断流的读取上限（§6.1：两个流都要持续 drain，且必须有界）。
const DRAIN_CAP: usize = 64 * 1024;

/// 宿主建实例时必须给 `FILE_FLAG_OVERLAPPED`：同步句柄上「一边等读一边写」会死锁
/// （事故与实测见 `src/pipe.rs` 顶部、`tests/pipe_probe.rs`）。
fn create_pipe(name: &str) -> HANDLE {
    let path = HSTRING::from(format!(r"\\.\pipe\{name}"));
    let handle = unsafe {
        CreateNamedPipeW(
            &path,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            None,
        )
    };
    assert!(
        handle != INVALID_HANDLE_VALUE,
        "CreateNamedPipeW 建不出来 {name}"
    );
    handle
}

/// 重叠句柄上 `ConnectNamedPipe` 不能用阻塞形式：拿到 `ERROR_IO_PENDING` 就用
/// `GetOverlappedResult(.., true)` 等，`ERROR_PIPE_CONNECTED` 表示对端已经先连上了。
fn connect_pipe(handle: HANDLE) {
    let mut overlapped = OVERLAPPED::default();
    match unsafe { ConnectNamedPipe(handle, Some(&mut overlapped)) } {
        Ok(()) => {}
        Err(error) => {
            let code = unsafe { GetLastError() };
            if code == ERROR_PIPE_CONNECTED {
                return;
            }
            assert_eq!(code, ERROR_IO_PENDING, "ConnectNamedPipe 失败：{error:?}（{code:?}）");
            let mut transferred = 0u32;
            unsafe { GetOverlappedResult(handle, &overlapped, &mut transferred, true) }
                .unwrap_or_else(|error| panic!("等连接完成失败：{error:?}"));
        }
    }
}

fn recv(stream: &mut PipeStream) -> Message {
    let body = read_frame(stream)
        .unwrap_or_else(|error| panic!("读帧失败：{error:?}（worker 大概已经被看门狗或崩溃带走了）"))
        .expect("worker 在会话中途把管道关了");
    let message = parse(&body).unwrap_or_else(|error| {
        panic!(
            "worker 发出的帧不合法：{error:?}，正文 {}",
            String::from_utf8_lossy(&body)
        )
    });
    message
}

fn send(stream: &mut PipeStream, message: &Message) {
    let body = encode(message).expect("编码失败");
    write_frame(stream, body.as_bytes()).expect("写帧失败");
    // `PipeStream::flush` 是空操作：帧已经整段交给内核，而管道上的
    // `FlushFileBuffers` 会等到对端把数据读干——宿主在这里踩下去，就会在 worker 忙的
    // 时候把自己卡住。
}

/// 有上限地把子进程的诊断流读干：宿主不 drain 的话，worker 的 `eprintln!` 会把它自己
/// 卡在写管道上——这是 §6.1 明写的一条。
fn drain(mut stream: impl Read + Send + 'static) -> (thread::JoinHandle<Vec<u8>>, Arc<AtomicBool>) {
    let done = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&done);
    let handle = thread::spawn(move || {
        let mut collected = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if collected.len() < DRAIN_CAP {
                        collected.extend_from_slice(&buffer[..read]);
                    }
                }
            }
        }
        flag.store(true, Ordering::SeqCst);
        collected
    });
    (handle, done)
}

/// 造一对宿主授权的目录：`staging`（worker 只许往这儿写）与 `inputs`（worker 只许
/// 从这儿读）。两个都必须由宿主先建好——worker 拒绝一个不存在的根。
fn roots(tag: &str) -> (PathBuf, PathBuf) {
    let staging = std::env::temp_dir().join(format!("{tag}-staging"));
    let inputs = std::env::temp_dir().join(format!("{tag}-inputs"));
    for dir in [&staging, &inputs] {
        let _ = fs::remove_dir_all(dir);
    }
    fs::create_dir_all(&staging).expect("建 staging 失败");
    fs::create_dir_all(&inputs).expect("建 inputs 失败");
    (staging, inputs)
}

fn run_message(job_id: &str, epoch: &str) -> Message {
    run_message_with_input(job_id, epoch, None)
}

/// `input` = 宿主授权的只读输入（相对输入根的路径、内容 hash、字节数）。
fn run_message_with_input(
    job_id: &str,
    epoch: &str,
    input: Option<(&str, &str, u64)>,
) -> Message {
    Message::Run(Run {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch.to_string(),
        job_id: job_id.to_string(),
        generation: 1,
        input: RunInput {
            input_id: "input-1".to_string(),
            content_hash: input.map(|(_, hash, _)| hash.to_string()).unwrap_or_else(|| "0".repeat(64)),
            byte_length: input.map(|(_, _, length)| length).unwrap_or(1024),
            relative_path: input.map(|(relative, _, _)| relative.to_string()),
        },
        pipeline: vec![PipelineStage {
            stage_id: "stage-a".to_string(),
            model_spec_id: "realcugan-2x-conservative".to_string(),
            // echo 路径不读模型：这一栏只有真引擎（`--engine onnx`）才要用，真进程测试里
            // 有专门的用例给它带一份授权模型。
            model: None,
            dlssnr: None,
            builtin: None,
            min_input_edge: None,
            output_scale: None,
            engine_policy: EnginePolicy::Auto,
            scale: Some(2),
            tile: Some(256),
            layers: None,
            settings_id: None,
        }],
        output_grant_id: "grant-1".to_string(),
        priority: Priority::Foreground,
        deadline_ms: 60_000,
        budgets: Budgets {
            max_pixels: 64_000_000,
            max_output_bytes: 1_073_741_824,
            intra_threads: 2,
        },
    })
}

/// 一个真的被 spawn 出来的 worker 进程，连同它的诊断流与看门狗。
///
/// 看门狗是给「测试自己卡住」兜底的：到点杀进程，卡在管道读上的一方会立刻看到 broken
/// pipe，于是失败信息是「worker 中途消失了」，而不是整个测试进程永远挂着。
struct Worker {
    child: Arc<Mutex<Child>>,
    finished: Arc<AtomicBool>,
    watchdog: thread::JoinHandle<()>,
    stdout: thread::JoinHandle<Vec<u8>>,
    stdout_done: Arc<AtomicBool>,
    stderr: thread::JoinHandle<Vec<u8>>,
    stderr_done: Arc<AtomicBool>,
}

impl Worker {
    fn spawn(name: &str, epoch: &str, nonce: u64, staging: &Path, inputs: &Path) -> Self {
        Self::spawn_with_engine(name, epoch, nonce, staging, inputs, "echo")
    }

    /// 与 [`Worker::spawn`] 同一件事，只是把 `--engine` 交给调用方：真引擎的用例要显式
    /// 选 `onnx`（生产里宿主也会显式选，默认值保持 `echo` 是为了让协议/进程测试仍然走
    /// 不加载模型的那条路）。
    fn spawn_with_engine(
        name: &str,
        epoch: &str,
        nonce: u64,
        staging: &Path,
        inputs: &Path,
        engine: &str,
    ) -> Self {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let temp = std::env::temp_dir();
        let mut child = Command::new(env!("CARGO_BIN_EXE_yomika-compute-worker"))
            .args([
                "--pipe",
                name,
                "--epoch",
                epoch,
                "--nonce",
                &nonce.to_string(),
                "--staging",
                staging.to_str().expect("staging 路径必须是 UTF-8"),
                "--inputs",
                inputs.to_str().expect("inputs 路径必须是 UTF-8"),
                "--engine",
                engine,
                "--log-budget",
                "8192",
            ])
            // 最小环境：worker 不该依赖宿主继承下来的任何东西（§6.1）。
            .env_clear()
            .env("SystemRoot", &system_root)
            .env("TEMP", &temp)
            // 隐藏窗口：给了这个旗标，worker 就不会弹出一个黑框。
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn worker 失败");
        let (stdout, stdout_done) = drain(child.stdout.take().expect("stdout 管道"));
        let (stderr, stderr_done) = drain(child.stderr.take().expect("stderr 管道"));

        let child = Arc::new(Mutex::new(child));
        let finished = Arc::new(AtomicBool::new(false));
        let watchdog = {
            let child = Arc::clone(&child);
            let finished = Arc::clone(&finished);
            thread::spawn(move || {
                let deadline = Instant::now() + WATCHDOG;
                while Instant::now() < deadline {
                    if finished.load(Ordering::SeqCst) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                let _ = child.lock().expect("child 锁").kill();
            })
        };

        Self {
            child,
            finished,
            watchdog,
            stdout,
            stdout_done,
            stderr,
            stderr_done,
        }
    }

    fn id(&self) -> u32 {
        self.child.lock().expect("child 锁").id()
    }

    /// 在 `budget` 内等它自己退出；超时返回 `None`（看门狗稍后会把它杀掉）。
    fn wait_within(&self, budget: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + budget;
        loop {
            let status = self
                .child
                .lock()
                .expect("child 锁")
                .try_wait()
                .expect("try_wait 失败");
            if let Some(status) = status {
                self.finished.store(true, Ordering::SeqCst);
                return Some(status);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// 收掉看门狗与两条诊断流，返回它们的正文。
    fn diagnostics(self) -> (String, String) {
        self.finished.store(true, Ordering::SeqCst);
        self.watchdog.join().expect("看门狗");
        let stdout = self.stdout.join().expect("stdout drain");
        let stderr = self.stderr.join().expect("stderr drain");
        assert!(
            self.stdout_done.load(Ordering::SeqCst) && self.stderr_done.load(Ordering::SeqCst),
            "诊断流必须一直被读到 EOF"
        );
        (
            String::from_utf8_lossy(&stdout).into_owned(),
            String::from_utf8_lossy(&stderr).into_owned(),
        )
    }
}

#[test]
fn a_real_worker_process_finishes_a_job_over_a_named_pipe() {
    let pid = std::process::id();
    let epoch = format!("epoch-{pid}");
    // epoch 里带 nonce：worker 在 hello 里把它原样回贴，宿主据此确认「连上来的就是
    // 我这一次 spawn 的那个实例」，而不是上一次留下的谁。
    let nonce = 4_242u64;
    let name = format!("yomika-compute-test-{pid}");
    let (staging, inputs) = roots(&format!("yomika-worker-process-{pid}"));

    // 管道必须先建好再 spawn，否则 worker 一上来就连接失败。
    let handle = create_pipe(&name);
    let worker = Worker::spawn(&name, &epoch, nonce, &staging, &inputs);
    let child_pid = worker.id();

    // worker 主动连上来（它可能在我们调用 ConnectNamedPipe 之前就已经连上了）。
    connect_pipe(handle);

    // 「连上来的就是我 spawn 的那个进程」——不核这一条，PID 之外的任何身份判断都只是猜。
    let mut peer_pid = 0u32;
    unsafe { GetNamedPipeClientProcessId(handle, &mut peer_pid) }.expect("取 peer PID 失败");
    assert_eq!(peer_pid, child_pid, "管道对面不是我们 spawn 的 worker");

    // 宿主这一半也走重叠 IO：连接句柄已经归 `PipeStream` 所有（drop 时关掉）。
    let mut host = PipeStream::wrap(handle).expect("包装宿主端管道失败");

    // 1. worker 先说话：hello 里有它的 epoch 与构建信息。
    match recv(&mut host) {
        Message::Hello(hello) => {
            assert_eq!(hello.protocol_version, PROTOCOL_MAJOR);
            assert_eq!(hello.worker_epoch, epoch);
            assert!(hello.build.version.starts_with("0.1."), "{hello:?}");
            assert_eq!(hello.build.engines, vec!["echo".to_string()]);
        }
        other => panic!("第一条帧该是 hello，拿到 {}", other.kind()),
    }
    send(
        &mut host,
        &Message::HelloAck(HelloAck {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.clone(),
            features: vec!["echo".to_string()],
            max_frame_bytes: MAX_FRAME_BYTES as u32,
        }),
    );

    // 2. 带旧 epoch 的信封必须被丢掉（但要让它在 stderr 上留一行日志，好证明
    //    「诊断走 stderr、协议帧走管道」这条边界真的成立）。
    send(
        &mut host,
        &Message::Ping(Ping {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: "epoch-stale".to_string(),
            nonce: 1,
        }),
    );
    send(
        &mut host,
        &Message::Ping(Ping {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.clone(),
            nonce: 99,
        }),
    );
    match recv(&mut host) {
        Message::Pong(pong) => assert_eq!(pong.nonce, 99, "旧 epoch 的 ping 不该有回音"),
        other => panic!("该是 pong，拿到 {}", other.kind()),
    }

    // 3. 一个任务从头跑到尾。任务一交出去就再塞一个 ping 进去：控制面必须在计算
    //    面忙着的时候也能立刻回话（§11 Task 3 第 ③ 条）。
    let job_id = "job-1";
    send(&mut host, &run_message(job_id, &epoch));
    send(
        &mut host,
        &Message::Ping(Ping {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.clone(),
            nonce: 1234,
        }),
    );

    let mut artifact: Option<ArtifactReady> = None;
    loop {
        match recv(&mut host) {
            Message::Pong(pong) => assert_eq!(pong.nonce, 1234),
            Message::Accepted(reference) => assert_eq!(reference.job_id, job_id),
            Message::StageStarted(started) => {
                assert_eq!(started.stage_id, "stage-a");
                assert_eq!(started.stage_index, 0);
            }
            Message::Progress(progress) => assert!(progress.percent <= 100.0),
            Message::ArtifactReady(ready) => {
                assert_eq!(ready.job_id, job_id);
                assert_eq!(ready.generation, 1);
                assert_eq!(ready.stage_id, "stage-a");
                assert_eq!(ready.output_grant_id, "grant-1");
                assert_eq!(ready.width, 64, "echo 引擎没有真实几何，协议范围内的占位值");
                // 产物真的在磁盘上，而且宿主能自己核对它——不看 worker 说什么。
                let path = staging.join(&ready.relative_name);
                let bytes = fs::read(&path)
                    .unwrap_or_else(|error| panic!("读不到产物 {}：{error}", path.display()));
                assert_eq!(bytes.len() as u64, ready.byte_length);
                assert_eq!(blake3::hash(&bytes).to_hex().to_string(), ready.content_hash);
                send(
                    &mut host,
                    &Message::ArtifactAck(ArtifactRef {
                        protocol_version: PROTOCOL_MAJOR,
                        worker_epoch: epoch.clone(),
                        job_id: job_id.to_string(),
                        artifact_id: ready.artifact_id.clone(),
                        reason: None,
                    }),
                );
                artifact = Some(ready);
            }
            Message::Completed(reference) => {
                assert_eq!(reference.job_id, job_id);
                break;
            }
            other => panic!("任务里不该出现 {}", other.kind()),
        }
    }
    assert!(artifact.is_some(), "任务completed了却没有 artifact_ready");
    assert!(staging.join("stage-a.bin").is_file());

    // 4. shutdown：worker 该干净地退出，退出码 0，管道对面没有孤儿。
    send(
        &mut host,
        &Message::Shutdown(EpochOnly {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.clone(),
        }),
    );
    drop(host);

    let status = worker
        .wait_within(Duration::from_secs(10))
        .expect("shutdown 之后 worker 该自己退出");
    assert_eq!(
        status.code(),
        Some(0),
        "worker 该以 0 退出（shutdown 是正常收场），实际 {status:?}"
    );

    let (stdout_text, stderr_text) = worker.diagnostics();
    // §6.1：诊断只能走 stderr，协议正文不许出现在任何诊断流里。
    assert!(
        !stdout_text.contains("protocolVersion") && !stderr_text.contains("protocolVersion"),
        "协议帧混进了诊断流：stdout={stdout_text:?} stderr={stderr_text:?}"
    );
    assert!(
        stderr_text.contains("[worker]"),
        "旧 epoch 的帧该在 stderr 上留一行日志，实际 {stderr_text:?}"
    );

    let _ = fs::remove_dir_all(&staging);
}

/// §11 Task 3 第 ④/⑤ 条：「parent EOF 自动退出」「kill 时无孤儿」。
///
/// 宿主崩掉、被强杀、或者干脆忘掉这里有个 worker，真正会留下的烂摊子是**孤儿 worker**：
/// 它还占着模型、显存与后台线程，没人管得着。所以 worker 不能只靠 shutdown 帧收场——
/// 管道一断（本测试直接 `drop(host)`，一句话都不说）它就必须自己看到 EOF 并退出。
#[test]
fn a_worker_exits_by_itself_when_the_host_hangs_up() {
    let pid = std::process::id();
    let epoch = format!("epoch-hangup-{pid}");
    let name = format!("yomika-compute-hangup-{pid}");
    let (staging, inputs) = roots(&format!("yomika-worker-hangup-{pid}"));

    let handle = create_pipe(&name);
    let worker = Worker::spawn(&name, &epoch, 0, &staging, &inputs);
    connect_pipe(handle);
    let mut host = PipeStream::wrap(handle).expect("包装宿主端管道失败");

    // 先走到握手完成：证明这不是「还没连上就退出」。
    match recv(&mut host) {
        Message::Hello(hello) => assert_eq!(hello.worker_epoch, epoch),
        other => panic!("第一条帧该是 hello，拿到 {}", other.kind()),
    }
    send(
        &mut host,
        &Message::HelloAck(HelloAck {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.clone(),
            features: vec!["echo".to_string()],
            max_frame_bytes: MAX_FRAME_BYTES as u32,
        }),
    );

    // 撒手：不 shutdown、不 cancel，直接关掉宿主这一端的句柄。
    drop(host);

    let status = worker
        .wait_within(Duration::from_secs(10))
        .expect("宿主撒手后 worker 必须自己退出，不能变成孤儿");
    assert_eq!(
        status.code(),
        Some(0),
        "父进程没了是正常收场（peer closed），实际 {status:?}"
    );

    // 诊断流也要在它退出时读到 EOF：这是「两个流都被持续 drain」那条边界的另一半。
    let (stdout_text, stderr_text) = worker.diagnostics();
    assert!(
        !stdout_text.contains("protocolVersion") && !stderr_text.contains("protocolVersion"),
        "协议帧混进了诊断流：stdout={stdout_text:?} stderr={stderr_text:?}"
    );

    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&inputs);
}

/// 跑到一次任务收场（`completed`/`failed`/`cancelled`），沿途记下帧的种类。
///
/// 返回 `(看到的帧, 失败帧)`；`artifact_ready` 会按 `ack` 决定要不要回执——输入校验
/// 失败的用例根本不该走到那里。
fn drive_job(
    host: &mut PipeStream,
    job_id: &str,
    epoch: &str,
    ack: bool,
) -> (Vec<String>, Option<Failed>) {
    let (kinds, failed, _) = drive_job_capturing(host, job_id, epoch, ack);
    (kinds, failed)
}

/// 与 [`drive_job`] 同一条循环，只是把 `artifact_ready` 的正文也带回来（真引擎的用例
/// 要核对尺寸、mime、引擎报告与内容 hash）。
fn drive_job_capturing(
    host: &mut PipeStream,
    job_id: &str,
    epoch: &str,
    ack: bool,
) -> (Vec<String>, Option<Failed>, Option<ArtifactReady>) {
    let mut kinds = Vec::new();
    let mut artifact = None;
    loop {
        match recv(host) {
            Message::Accepted(reference) => {
                assert_eq!(reference.job_id, job_id);
                kinds.push("accepted".to_string());
            }
            Message::StageStarted(started) => {
                assert_eq!(started.job_id, job_id);
                kinds.push("stage_started".to_string());
            }
            Message::Progress(_) => {}
            Message::ArtifactReady(ready) => {
                kinds.push("artifact_ready".to_string());
                artifact = Some(ready.clone());
                if ack {
                    send(
                        host,
                        &Message::ArtifactAck(ArtifactRef {
                            protocol_version: PROTOCOL_MAJOR,
                            worker_epoch: epoch.to_string(),
                            job_id: job_id.to_string(),
                            artifact_id: ready.artifact_id.clone(),
                            reason: None,
                        }),
                    );
                }
            }
            Message::Completed(reference) => {
                assert_eq!(reference.job_id, job_id);
                kinds.push("completed".to_string());
                return (kinds, None, artifact);
            }
            Message::Failed(failed) => {
                assert_eq!(failed.job_id, job_id);
                kinds.push("failed".to_string());
                return (kinds, Some(failed), artifact);
            }
            Message::Cancelled(reference) => {
                assert_eq!(reference.job_id, job_id);
                kinds.push("cancelled".to_string());
                return (kinds, None, artifact);
            }
            other => panic!("任务 {job_id} 里不该出现 {}", other.kind()),
        }
    }
}

/// §11 Task 7-a：宿主授权的输入，worker 必须在**开始算之前**就复核完。
///
/// 三条一次跑完（省进程）：对得上就跑完、声明 hash 对不上就整次不开始、相对路径想
/// 爬出输入根也整次不开始。后两条如果只是「算到一半失败」，宿主就会把一次输入问题
/// 看成算法问题。
#[test]
fn a_granted_input_is_verified_before_the_run_starts() {
    let pid = std::process::id();
    let epoch = format!("epoch-input-{pid}");
    let name = format!("yomika-compute-input-{pid}");
    let (staging, inputs) = roots(&format!("yomika-worker-input-{pid}"));
    // 一份真的输入：宿主会把它放在 `<hash 前两位>/<hash>.bin` 下（与宿主侧
    // `compute::inputs::stage` 同一套命名）。
    let bytes = b"yomika-input-payload";
    let hash = blake3::hash(bytes).to_hex().to_string();
    let relative = format!("{}/{hash}.bin", &hash[..2]);
    let input_path = inputs.join(&relative);
    fs::create_dir_all(input_path.parent().expect("前缀目录")).expect("建输入前缀目录失败");
    fs::write(&input_path, bytes).expect("写输入失败");

    let handle = create_pipe(&name);
    let worker = Worker::spawn(&name, &epoch, 0, &staging, &inputs);
    connect_pipe(handle);
    let mut host = PipeStream::wrap(handle).expect("包装宿主端管道失败");

    match recv(&mut host) {
        Message::Hello(hello) => assert_eq!(hello.worker_epoch, epoch),
        other => panic!("第一条帧该是 hello，拿到 {}", other.kind()),
    }
    send(
        &mut host,
        &Message::HelloAck(HelloAck {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.clone(),
            features: vec!["echo".to_string()],
            max_frame_bytes: MAX_FRAME_BYTES as u32,
        }),
    );

    // 1. 声明与内容一致：跑完，而且产物里写着这次交到引擎手上的输入是谁。
    send(
        &mut host,
        &run_message_with_input("job-ok", &epoch, Some((&relative, &hash, bytes.len() as u64))),
    );
    let (kinds, failed) = drive_job(&mut host, "job-ok", &epoch, true);
    assert!(failed.is_none(), "对得上的输入不该失败：{failed:?}");
    assert_eq!(kinds.join(","), "accepted,stage_started,artifact_ready,completed");
    let produced = fs::read(staging.join("stage-a.bin")).expect("读产物失败");
    assert!(
        String::from_utf8_lossy(&produced).contains(&format!("granted={relative}")),
        "产物里该记着这次输入是谁：{}",
        String::from_utf8_lossy(&produced)
    );

    // 2. 声明 hash 与内容不符：整次不开始算（没有 stage_started）。
    //
    // 下面三条也把 `ack` 置真：真要是有产物发过来也得回 ack，否则「守卫被拆掉」的变异版会
    // 卡在等 ack 上，红成一条 30 秒超时——那比断言难看得多，也说不清是哪条守卫没了。
    send(
        &mut host,
        &run_message_with_input(
            "job-hash",
            &epoch,
            Some((&relative, &"f".repeat(64), bytes.len() as u64)),
        ),
    );
    let (kinds, failed) = drive_job(&mut host, "job-hash", &epoch, true);
    let failed = failed.expect("hash 对不上必须回失败帧");
    assert_eq!(failed.code, "COMPUTE_INPUT_INVALID", "{failed:?}");
    assert_eq!(kinds.join(","), "accepted,failed", "输入不可用时不该开始算");

    // 3. 长度对不上也一样。
    send(
        &mut host,
        &run_message_with_input("job-len", &epoch, Some((&relative, &hash, 999_999))),
    );
    let (kinds, failed) = drive_job(&mut host, "job-len", &epoch, true);
    let failed = failed.expect("长度对不上必须回失败帧");
    assert_eq!(failed.code, "COMPUTE_INPUT_INVALID", "{failed:?}");
    assert_eq!(kinds.join(","), "accepted,failed", "输入不可用时不该开始算");

    // 4. 相对路径想爬出输入根：同样整次不开始。
    send(
        &mut host,
        &run_message_with_input(
            "job-escape",
            &epoch,
            Some(("../escape.bin", &hash, bytes.len() as u64)),
        ),
    );
    let (kinds, failed) = drive_job(&mut host, "job-escape", &epoch, true);
    let failed = failed.expect("越界路径必须回失败帧");
    assert_eq!(failed.code, "COMPUTE_INPUT_INVALID", "{failed:?}");
    assert_eq!(kinds.join(","), "accepted,failed", "越界路径不该开始算");

    // 5. 没有授权输入：echo 不需要像素，所以照常跑完（真引擎会自己回输入不可用）。
    send(&mut host, &run_message("job-none", &epoch));
    let (kinds, failed) = drive_job(&mut host, "job-none", &epoch, true);
    assert!(failed.is_none(), "没有输入的 echo 任务不该失败：{failed:?}");
    assert_eq!(kinds.join(","), "accepted,stage_started,artifact_ready,completed");

    send(
        &mut host,
        &Message::Shutdown(EpochOnly {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.clone(),
        }),
    );
    drop(host);
    let status = worker
        .wait_within(Duration::from_secs(10))
        .expect("shutdown 之后 worker 该自己退出");
    assert_eq!(status.code(), Some(0), "实际 {status:?}");

    let (stdout_text, stderr_text) = worker.diagnostics();
    assert!(
        !stdout_text.contains("protocolVersion") && !stderr_text.contains("protocolVersion"),
        "协议帧混进了诊断流：stdout={stdout_text:?} stderr={stderr_text:?}"
    );
    assert!(
        stderr_text.contains("输入不可用"),
        "输入被拒该在 stderr 上留一行：{stderr_text:?}"
    );

    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&inputs);
}

/// 按宿主侧 `compute::inputs::stage` 的同一套命名（`<hash 前两位>/<hash>.bin`）把一份
/// 字节放进输入根，返回 run 里要声明的三元组。
fn stage_into(inputs: &Path, bytes: &[u8]) -> (String, String, u64) {
    let hash = blake3::hash(bytes).to_hex().to_string();
    let relative = format!("{}/{hash}.bin", &hash[..2]);
    let path = inputs.join(&relative);
    fs::create_dir_all(path.parent().expect("前缀目录")).expect("建输入前缀目录失败");
    fs::write(&path, bytes).expect("写授权文件失败");
    (relative, hash, bytes.len() as u64)
}

/// 一张有结构的 24×16 RGBA 图：纯色或平滑渐变会让「真的过了模型」这条断言变得没意义。
fn structured_png(width: u32, height: u32) -> Vec<u8> {
    let mut page = image::RgbaImage::new(width, height);
    for (x, y, pixel) in page.enumerate_pixels_mut() {
        *pixel = image::Rgba([
            ((x * 37 + y * 11) % 256) as u8,
            ((x * x + y * 7) % 256) as u8,
            ((x * 5 + y * y * 3) % 256) as u8,
            255,
        ]);
    }
    let mut encoded = Vec::new();
    image::DynamicImage::ImageRgba8(page)
        .write_to(&mut std::io::Cursor::new(&mut encoded), image::ImageFormat::Png)
        .expect("编码源图失败");
    encoded
}

/// 真引擎的 run：输入与**模型**都从输入根里按声明取（模型走的是与页面完全相同的那条
/// 授权通道，没有第二条读路径）。
#[allow(clippy::too_many_arguments)]
fn run_message_with_model(
    job_id: &str,
    epoch: &str,
    input: &(String, String, u64),
    model: &(String, String, u64),
    min_input_edge: u32,
) -> Message {
    Message::Run(Run {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch.to_string(),
        job_id: job_id.to_string(),
        generation: 1,
        input: RunInput {
            input_id: "input-1".to_string(),
            content_hash: input.1.clone(),
            byte_length: input.2,
            relative_path: Some(input.0.clone()),
        },
        pipeline: vec![PipelineStage {
            stage_id: "stage-a".to_string(),
            model_spec_id: "realcugan-2x-conservative".to_string(),
            model: Some(GrantedFile {
                relative_path: model.0.clone(),
                content_hash: model.1.clone(),
                byte_length: model.2,
            }),
            dlssnr: None,
            builtin: None,
            min_input_edge: Some(min_input_edge),
            output_scale: None,
            // 显式点 CPU：这份 worker 构建里没有硬件运行库（`worker/Cargo.toml` 只开
            // `cpu` feature），`Auto` 与 `Cpu` 在这里是同一条路。GPU 那两条分支要真
            // 硬件，属于 docs/80 里如实写明的欠账。
            engine_policy: EnginePolicy::Cpu,
            scale: Some(2),
            tile: None,
            layers: None,
            settings_id: None,
        }],
        output_grant_id: "grant-1".to_string(),
        priority: Priority::Foreground,
        deadline_ms: 120_000,
        budgets: Budgets {
            max_pixels: 64_000_000,
            max_output_bytes: 64 * 1024 * 1024,
            intra_threads: 2,
        },
    })
}

/// 建管道 → spawn（可指定 `--engine`）→ 等它连上来 → 收 Hello → 回 HelloAck。
/// 那条 Hello 原样交回给调用方：构建事实该由每条用例自己断言，这里不替它下结论。
fn start_worker(
    name: &str,
    epoch: &str,
    staging: &Path,
    inputs: &Path,
    engine: &str,
) -> (Worker, PipeStream, Hello) {
    let handle = create_pipe(name);
    let worker = Worker::spawn_with_engine(name, epoch, 0, staging, inputs, engine);
    connect_pipe(handle);
    let mut host = PipeStream::wrap(handle).expect("包装宿主端管道失败");
    let hello = match recv(&mut host) {
        Message::Hello(hello) => hello,
        other => panic!("第一条帧该是 hello，拿到 {}", other.kind()),
    };
    assert_eq!(hello.worker_epoch, epoch, "worker 报的是另一个 epoch");
    send(
        &mut host,
        &Message::HelloAck(HelloAck {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.to_string(),
            features: vec![engine.to_string()],
            max_frame_bytes: MAX_FRAME_BYTES as u32,
        }),
    );
    (worker, host, hello)
}

/// 真模型是本地素材（与宿主 `src-tauri/src/inference/onnx.rs` 里那几条真模型测试同一套
/// 约定），不进仓库。没有就跳过，但必须**说出来**，不许静默当成通过。
fn local_realcugan() -> Option<Vec<u8>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/models/realcugan-2x-conservative.onnx");
    if !path.is_file() {
        eprintln!("跳过：本机没有 {}（模型素材不进仓库）", path.display());
        return None;
    }
    Some(fs::read(&path).expect("读模型失败"))
}

/// §11 Task 7-b-ii：真引擎在**真进程**里跑一张真图。
///
/// 这条要证明的不是「代码能编译」，而是：模型与页面走**同一条**授权输入通道就能把一次
/// 超分跑完，交出来的是一张真的 PNG——尺寸对、像素是模型算出来的、内容 hash 与文件
/// 一致。源图 24×16 且高度小于模型要求的 20（Real-CUGAN 图内反射 18 px），所以这条顺带
/// 把「窄瓦片先按边缘长大、答完再裁回来」也走了一遍。
#[test]
fn the_real_engine_upscales_a_granted_page_with_a_granted_model() {
    let Some(model_bytes) = local_realcugan() else {
        return;
    };

    let pid = std::process::id();
    let epoch = format!("epoch-onnx-{pid}");
    let name = format!("yomika-compute-onnx-{pid}");
    let (staging, inputs) = roots(&format!("yomika-worker-onnx-{pid}"));
    let page = structured_png(24, 16);
    let page_grant = stage_into(&inputs, &page);
    let model_grant = stage_into(&inputs, &model_bytes);

    let (worker, mut host, hello) = start_worker(&name, &epoch, &staging, &inputs, "onnx");
    // 构建事实必须与**实际**装上的引擎一致：要了 onnx 就不许再报自己是 echo。
    // Windows 上这一份还真的带着 DLSSNR 那一档（NGX 只有 Windows/D3D12 一版），
    // 以及第 30 轮起那一档内置链（Anime4K：解析器与 CPU/GPU 两个执行体都在 compute-core，
    // 这份 worker 编着它，所以握手里必须报出来——它正是「anime4k-hq 能不能交给 worker」的
    // 那一句自述）。
    assert_eq!(
        hello.build.engines,
        vec!["onnx".to_string(), "anime4k".to_string(), "dlssnr".to_string()],
        "{hello:?}"
    );
    assert!(
        hello.build.runtimes.iter().any(|id| id == "cpu"),
        "这份构建至少该有一条 cpu 运行库：{:?}",
        hello.build.runtimes
    );

    send(
        &mut host,
        &run_message_with_model("job-onnx", &epoch, &page_grant, &model_grant, 20),
    );
    let (kinds, failed, ready) = drive_job_capturing(&mut host, "job-onnx", &epoch, true);
    let failed = failed.map(|failed| format!("{failed:?}"));
    assert!(failed.is_none(), "真引擎不该失败：{failed:?}");
    assert_eq!(
        kinds.join(","),
        "accepted,stage_started,artifact_ready,completed"
    );

    let ready = ready.expect("真引擎该交出一个产物");
    assert_eq!(ready.relative_name, "stage-a.png");
    assert_eq!(ready.mime, "image/png");
    assert_eq!((ready.width, ready.height), (48, 32), "x2 之后该是四倍面积");
    assert_eq!(ready.engine.id, "onnx");
    assert_eq!(ready.engine.precision, Precision::Fp32);
    // device_id 说的是**实际**跑在哪：报告里不许出现「选了显卡、跑在 CPU」的谎话。
    assert_eq!(ready.engine.device_id, "cpu");
    assert!(
        ready.engine.version.starts_with("ort-api"),
        "运行库版本该是核心那个串：{}",
        ready.engine.version
    );

    // 产物真的落在 staging 里，且与它报的 hash/长度一致。
    let produced = fs::read(staging.join("stage-a.png")).expect("读产物失败");
    assert_eq!(ready.byte_length, produced.len() as u64);
    assert_eq!(ready.content_hash, blake3::hash(&produced).to_hex().to_string());

    // 解回来：尺寸对，而且像素不是把源图最近邻放大一遍就能得到的。
    let upscaled = image::load_from_memory(&produced)
        .expect("产物该是一张能解开的 PNG")
        .to_rgba8();
    assert_eq!((upscaled.width(), upscaled.height()), (48, 32));
    let source = image::load_from_memory(&page).expect("源图").to_rgba8();
    let mut nearest = Vec::with_capacity(48 * 32 * 4);
    for y in 0..32u32 {
        for x in 0..48u32 {
            nearest.extend_from_slice(&source.get_pixel(x / 2, y / 2).0);
        }
    }
    assert_ne!(
        upscaled.as_raw(),
        &nearest,
        "产物必须真的过了模型，而不是最近邻放大的源图"
    );
    // 一行可核对的数字：模型多大、产物多大、从什么尺寸放大到什么尺寸、谁跑的。
    eprintln!(
        "真引擎：模型 {} 字节 → 产物 {} 字节，24×16 → {}×{}，engine={} {} version={} device={}",
        model_bytes.len(),
        produced.len(),
        upscaled.width(),
        upscaled.height(),
        ready.engine.id,
        format!("{:?}", ready.engine.precision),
        ready.engine.version,
        ready.engine.device_id,
    );

    send(
        &mut host,
        &Message::Shutdown(EpochOnly {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.clone(),
        }),
    );
    drop(host);
    let status = worker
        .wait_within(Duration::from_secs(10))
        .expect("shutdown 之后 worker 该自己退出");
    assert_eq!(status.code(), Some(0), "实际 {status:?}");
    let (_stdout_text, stderr_text) = worker.diagnostics();
    // 真跑过模型：诊断流里该有 ONNX 探针那一行的痕迹（`Auto` 会打，这里显式点 CPU 所以
    // 只要求「没有协议帧混进诊断流」，模型的真日志留给宿主侧接线的用例）。
    assert!(
        !stderr_text.contains("protocolVersion"),
        "协议帧混进了诊断流：{stderr_text:?}"
    );

    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&inputs);
}
/// `--inputs` 与 `--staging` 一样是宿主的授权：缺了、或者指着一个还没建的目录，
/// worker 必须当场退出，而不是在别处「顺手建一个」——授权根是宿主随机挑的，
/// 一个由被授权方自己造出来的根就不叫授权了。
#[test]
fn a_worker_refuses_to_start_without_an_input_root() {
    fn run(args: &[String]) -> (i32, String) {
        let output = Command::new(env!("CARGO_BIN_EXE_yomika-compute-worker"))
            .args(args)
            .stdin(Stdio::null())
            .output()
            .expect("跑 worker 失败");
        (
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).to_string(),
        )
    }

    let pid = std::process::id();
    let (staging, inputs) = roots(&format!("yomika-worker-args-{pid}"));
    let base = vec![
        "--pipe".to_string(),
        format!(r"\\.\pipe\yomika-args-{pid}"),
        "--epoch".to_string(),
        format!("epoch-args-{pid}"),
        "--nonce".to_string(),
        "1".to_string(),
        "--staging".to_string(),
        staging.display().to_string(),
    ];

    // ① 干脆没给 `--inputs`。
    let (code, stderr) = run(&base);
    assert_ne!(code, 0, "缺 --inputs 不该开始干活：{stderr}");
    assert!(stderr.contains("缺 --inputs"), "要说清缺的是哪个参数：{stderr}");

    // ② 给了，但那个目录还不存在。
    let mut missing = base.clone();
    missing.push("--inputs".to_string());
    missing.push(inputs.join("nope").display().to_string());
    let (code, stderr) = run(&missing);
    assert_ne!(code, 0, "目录不存在不该开始干活：{stderr}");
    assert!(
        stderr.contains("inputs 目录不存在"),
        "要说清是哪个根：{stderr}"
    );

    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&inputs);
}

/// §11 Task 7-b-ii：预算必须在**分配像素之前**拦。
///
/// 一次授权最多 1 GiB，而 1 GiB 的 PNG 可以解出几十 GB 内存——先解再算预算，等于把机器的
/// 内存交给一张声明合法的文件。这条用例给的是 24×16（384 像素）的源图，却只批 64 个输出
/// 像素（x2 反推只容得下 16 个源像素），于是它必须在 `image::load_from_memory` 之前失败。
/// 顺便：这条**不需要**真模型——模型那一栏给的是 `not-a-model`，因为预算在模型被打开之前
/// 就该拒绝；哪天顺序被调换，这条用例会以另一种方式失败，正是它要钉住的东西。
#[test]
fn a_source_page_that_cannot_fit_the_budget_is_refused_before_it_is_decoded() {
    let pid = std::process::id();
    let epoch = format!("epoch-budget-{pid}");
    let name = format!("yomika-compute-budget-{pid}");
    let (staging, inputs) = roots(&format!("yomika-worker-budget-{pid}"));
    let page = structured_png(24, 16);
    let page_grant = stage_into(&inputs, &page);
    let model_grant = stage_into(&inputs, b"not-a-model");

    let (worker, mut host, _hello) = start_worker(&name, &epoch, &staging, &inputs, "onnx");
    let mut message = run_message_with_model("job-budget", &epoch, &page_grant, &model_grant, 20);
    match &mut message {
        Message::Run(run) => run.budgets.max_pixels = 64,
        other => panic!("该是一条 run，拿到 {}", other.kind()),
    }
    send(&mut host, &message);

    let (kinds, failed, ready) = drive_job_capturing(&mut host, "job-budget", &epoch, true);
    let failed = failed.expect("源图放不进预算就该当场拒绝");
    assert_eq!(failed.code, "COMPUTE_RESOURCE_LIMIT", "{failed:?}");
    assert!(
        failed.message.contains("384×16") || failed.message.contains("24×16"),
        "拒绝的理由要说清源图多大：{}",
        failed.message
    );
    assert!(ready.is_none(), "拒绝了的图不该有产物：{ready:?}");
    assert_eq!(kinds.join(","), "accepted,stage_started,failed");
    eprintln!("预算拒绝：code={} message={}", failed.code, failed.message);

    send(
        &mut host,
        &Message::Shutdown(EpochOnly {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.clone(),
        }),
    );
    drop(host);
    let status = worker
        .wait_within(Duration::from_secs(10))
        .expect("shutdown 之后 worker 该自己退出");
    assert_eq!(status.code(), Some(0), "实际 {status:?}");

    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&inputs);
}

/// §11 Task 7-b-ii：`Gpu` 是**承诺**，不是偏好（docs/71 §5.1、§12.1）。
///
/// 这份 worker 构建只开了 core 的 `cpu` feature，所以「拿不到 GPU」有两条真实落法：本机
/// 没有硬件运行库 ⇒ `GPU_BACKEND_UNAVAILABLE`；将来 worker 带上 DirectML 之后，未改写的
/// Real-CUGAN 图会因为探针不过而回 `GPU_OUTPUT_INVALID`（图内负垫在 DML 上算错，见 docs/72）。
/// 两条都算「承诺没兑现」，但**必须是响亮地失败**：不许悄悄退回 CPU，交出一张 CPU 算的
/// 产物冒充「GPU 超分」。除了政策一栏，这条用例与上面成功的那条完全同构——所以两者的差别
/// 只可能来自「要的是 GPU」。
#[test]
fn a_gpu_promise_that_cannot_be_kept_fails_loudly() {
    let Some(model_bytes) = local_realcugan() else {
        return;
    };

    let pid = std::process::id();
    let epoch = format!("epoch-gpu-{pid}");
    let name = format!("yomika-compute-gpu-{pid}");
    let (staging, inputs) = roots(&format!("yomika-worker-gpu-{pid}"));
    let page = structured_png(24, 16);
    let page_grant = stage_into(&inputs, &page);
    let model_grant = stage_into(&inputs, &model_bytes);

    let (worker, mut host, hello) = start_worker(&name, &epoch, &staging, &inputs, "onnx");
    assert_eq!(
        hello.build.engines,
        vec!["onnx".to_string(), "anime4k".to_string(), "dlssnr".to_string()],
        "{hello:?}"
    );

    let mut message = run_message_with_model("job-gpu", &epoch, &page_grant, &model_grant, 20);
    match &mut message {
        Message::Run(run) => run.pipeline[0].engine_policy = EnginePolicy::Gpu,
        other => panic!("该是一条 run，拿到 {}", other.kind()),
    }
    send(&mut host, &message);

    let (kinds, failed, ready) = drive_job_capturing(&mut host, "job-gpu", &epoch, true);
    let failed = failed.expect("承诺没兑现就该失败，而不是交出一张 CPU 算的产物");
    assert!(
        failed.code == "GPU_BACKEND_UNAVAILABLE" || failed.code == "GPU_OUTPUT_INVALID",
        "失败码该说清是「这台机器上没有 GPU」还是「GPU 算出来的不能用」：{}",
        failed.code
    );
    assert!(ready.is_none(), "承诺没兑现时不许有产物：{ready:?}");
    // 阶段确实跑了起来（stage_started 在 execute 之前发），然后在引擎里失败——不是提交就
    // 被挡回去，也不是跑完再事后挑剔。
    assert_eq!(kinds.join(","), "accepted,stage_started,failed");
    eprintln!(
        "GPU 承诺失败：code={} message={} kinds={}",
        failed.code,
        failed.message,
        kinds.join(",")
    );

    send(
        &mut host,
        &Message::Shutdown(EpochOnly {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.clone(),
        }),
    );
    drop(host);
    let status = worker
        .wait_within(Duration::from_secs(10))
        .expect("shutdown 之后 worker 该自己退出");
    assert_eq!(status.code(), Some(0), "实际 {status:?}");

    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&inputs);
}
