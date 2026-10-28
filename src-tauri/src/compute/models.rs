//! 宿主侧的模型交接：把「已安装的模型」变成 worker 能读的一份只读授权
//! （`docs/71` §7.1、§7.2）。
//!
//! worker 不认识模型目录，也不被允许去读它：它只认「已授权的输入根 + 一份声明」。所以
//! 宿主在派发前做三件事——按 id 找到那份已安装的模型、按内容算一次 blake3、把文件摆进
//! 输入根——然后把声明交给 worker，由 worker 再自己核一遍（`core::inputs::verify_file`）。
//!
//! 为什么和页面走同一条输入根、而不给模型开第二个 `--models` 根：worker 因此只保留
//! **一条**被允许读用户数据的路。两条路就要两套「这个根里什么是合法的」判断，而其中
//! 任何一套写漏了都是同一个洞。

use std::path::{Path, PathBuf};

use yomika_compute_protocol::messages::{BuiltinChainGrant, GrantedFile};

use super::artifacts::hash_file;
use super::inputs;

/// 「这台机器上拿不到这份模型」的统一错误码：前端要能把它和「输入坏了」分开——
/// 一个是去下载/检查安装，另一个是重新取一页。
pub const MODEL_UNAVAILABLE_CODE: &str = "COMPUTE_MODEL_UNAVAILABLE";

/// 一次成功的交接。两种形状，对应两种**根本不同**的东西：模型目录里的一份 ONNX（内容
/// 寻址的一只只读文件），与编在两个二进制里的超分链（没有文件，只有名字与版本）。
///
/// 为什么写成一个枚举而不是「`grant` 加一个 `Option`」：它们要交给 worker 的是协议里
/// 两个互斥的栏位（`model` / `builtin`），而「两栏都填」在协议层就是要被拒的请求。枚举
/// 让「恰好一种」在类型上就成立，派发那一侧不必再判一遍。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StagedModel {
    /// 模型目录里的一份 ONNX：worker 拿着这只只读授权自己再核一遍长度与哈希。
    File {
        grant: GrantedFile,
        accelerator: Option<GrantedFile>,
        /// 清单里的 `minInputEdge`。搬进 worker 是因为引擎要拿它判断「这张图对这个模型
        /// 来说太小了」——那是模型自带的事实，不该让调用方猜。
        min_input_edge: u32,
    },
    /// 宿主内置的超分链（Anime4K）：worker 那一份构建里编着**同一份**着色器，所以这里
    /// 交过去的只有身份——名字与版本，由 worker 在自己那一份里再解析一次。
    Builtin(BuiltinChainGrant),
}

impl StagedModel {
    /// 给测试与日志用的一句话：这一份交接到底是什么。
    pub fn describe(&self) -> String {
        match self {
            StagedModel::File { grant, .. } => format!("file:{}", grant.relative_path),
            StagedModel::Builtin(chain) => {
                format!("builtin:{}:{}", chain.chain_id, chain.version)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    /// 没装、装了一半（没有清单）、或装法有歧义（目录里不止一个 `.onnx`）。
    NotFound { id: String },
    /// 模型在，但在交给 worker 之前就出错了（读不到、算不出哈希、摆不进输入根）。
    NotStaged { id: String, detail: String },
}

impl ModelError {
    pub fn code(&self) -> &'static str {
        MODEL_UNAVAILABLE_CODE
    }

    pub fn message(&self) -> String {
        match self {
            ModelError::NotFound { id } => format!(
                "这台机器上没有可用的模型 {id}（没下载、没装完、或安装目录里不止一个 .onnx）"
            ),
            ModelError::NotStaged { id, detail } => {
                format!("模型 {id} 在交给计算进程之前就出错了：{detail}")
            }
        }
    }
}

/// 数据根下的模型目录（`models/<id>/<version>/`，`docs/71` §7.2）。
///
/// 只读：宿主的下载/解压流程负责往里放东西，这里只负责认出来并交出去。
///
/// `Clone + Debug`：`SupervisorConfig` 两样都要（配置会被克隆给测试、被日志打印），
/// 它只是数据根的一个路径，复制它没有代价。
#[derive(Clone, Debug)]
pub struct ModelCatalog {
    data_root: PathBuf,
}

impl ModelCatalog {
    pub fn new(data_root: impl Into<PathBuf>) -> Self {
        Self {
            data_root: data_root.into(),
        }
    }

    /// 把 `model_spec_id` 指的那一份**东西**变成 worker 能收的声明。
    ///
    /// 两条来路：模型目录里的一份 ONNX（内容寻址地摆进输入根），或者宿主内置的超分链
    /// （没有文件——它编在两个二进制里，交过去的只是名字与版本）。哪一条由 id 是哪种
    /// 东西决定，不是由调用方说。
    ///
    /// 「内置的那一档」以前在这里被当成**走不通**（`HostOnly`）：那时 worker 的构建里
    /// 没有那条链。现在两边的 `compute-core` 都编着它（`core::anime4k`），所以它变成
    /// 一条正常的来路——见 `StagedModel::Builtin`。
    pub fn stage(
        &self,
        inputs_root: &Path,
        model_spec_id: &str,
    ) -> Result<StagedModel, ModelError> {
        let id = model_spec_id.trim();
        if id.is_empty() {
            return Err(ModelError::NotFound {
                id: model_spec_id.to_string(),
            });
        }
        if let Some(preset) = crate::inference::builtin_upscaler(id) {
            return Ok(StagedModel::Builtin(BuiltinChainGrant {
                chain_id: preset.id.to_string(),
                version: preset.version.to_string(),
                scale: preset.scale,
            }));
        }
        let Some((path, manifest)) = crate::inference::resolve_installed_model(&self.data_root, id)
        else {
            return Err(ModelError::NotFound { id: id.to_string() });
        };
        let (byte_length, content_hash) = hash_file(&path).map_err(|error| {
            ModelError::NotStaged {
                id: id.to_string(),
                detail: format!("算 {} 的内容哈希失败：{error}", path.display()),
            }
        })?;
        let relative_path = inputs::stage(inputs_root, &path, &content_hash).map_err(|error| {
            ModelError::NotStaged {
                id: id.to_string(),
                detail: format!("{}：{}", error.code(), error.message()),
            }
        })?;
        let accelerator = stage_accelerator(inputs_root, &path, manifest.scale);
        Ok(StagedModel::File {
            accelerator,
            grant: GrantedFile {
                relative_path,
                content_hash,
                byte_length,
            },
            // 清单里的 0 没有意义（引擎要拿它比边长），兜到 1：和 `ModelManifest`
            // 反序列化时的缺省值同一个意思。
            min_input_edge: manifest.min_input_edge.max(1),
        })
    }
}

/// Companion fingerprints and RGB contract are checked before worker handoff.
fn stage_accelerator(inputs_root: &Path, onnx: &Path, scale: u32) -> Option<GrantedFile> {
    use sha2::{Digest, Sha256};
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Export { onnx_sha256: String, tflite_sha256: String, scale: u32, layout: String }
    let directory = onnx.parent()?;
    let export: Export = serde_json::from_slice(&std::fs::read(directory.join("yomika-accelerator.json")).ok()?).ok()?;
    if export.scale != scale || export.layout != "NHWC-RGB-FP32-256" { return None; }
    let source = std::fs::read(onnx).ok()?;
    if format!("{:x}", Sha256::digest(&source)) != export.onnx_sha256 { return None; }
    let companion = directory.join("model.tflite");
    let bytes = std::fs::read(&companion).ok()?;
    if format!("{:x}", Sha256::digest(&bytes)) != export.tflite_sha256 { return None; }
    let (byte_length, content_hash) = hash_file(&companion).ok()?;
    let relative_path = inputs::stage(inputs_root, &companion, &content_hash).ok()?;
    Some(GrantedFile { relative_path, content_hash, byte_length })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个只用一次的数据根：模型安装布局是 `models/<id>/<version>/`。
    struct Sandbox {
        root: PathBuf,
    }

    impl Sandbox {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let root = std::env::temp_dir().join(format!(
                "yomika-models-{tag}-{}-{nanos:x}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).expect("建沙箱");
            Self { root }
        }

        fn inputs(&self) -> PathBuf {
            let inputs = self.root.join("compute").join("inputs");
            std::fs::create_dir_all(&inputs).expect("建输入根");
            inputs
        }

        /// 装一份模型：清单 + 恰好一个 `.onnx`。
        fn install(&self, id: &str, version: &str, bytes: &[u8], min_input_edge: u32) -> PathBuf {
            let root = self.root.join("models").join(id).join(version);
            std::fs::create_dir_all(&root).expect("建模型目录");
            let manifest = format!(
                r#"{{"id":"{id}","version":"{version}","format":"onnx","scale":2,"maxPixels":64000000,"sha256":"{}","supportedBackends":["cpu"],"minInputEdge":{min_input_edge}}}"#,
                "a".repeat(64)
            );
            std::fs::write(root.join("yomika-model.json"), manifest).expect("写清单");
            let model = root.join("model.onnx");
            std::fs::write(&model, bytes).expect("写模型");
            model
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn catalog(sandbox: &Sandbox) -> ModelCatalog {
        ModelCatalog::new(&sandbox.root)
    }

    fn blob_path(inputs: &Path, relative: &str) -> PathBuf {
        inputs.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
    }

    #[test]
    fn accelerator_requires_both_fingerprints_and_keeps_the_onnx_fallback() {
        use sha2::{Digest, Sha256};
        let sandbox = Sandbox::new("accelerator");
        let model = sandbox.install("demo", "1", b"original model", 1);
        let root = model.parent().unwrap();
        std::fs::write(root.join("model.tflite"), b"converted model").unwrap();
        let export = serde_json::json!({
            "onnxSha256": format!("{:x}", Sha256::digest(b"original model")),
            "tfliteSha256": format!("{:x}", Sha256::digest(b"converted model")),
            "scale": 2, "layout": "NHWC-RGB-FP32-256"
        });
        std::fs::write(root.join("yomika-accelerator.json"), export.to_string()).unwrap();
        let inputs = sandbox.inputs();
        let StagedModel::File { accelerator: Some(grant), .. } = catalog(&sandbox).stage(&inputs,"demo").unwrap() else { panic!("valid companion missing") };
        assert_eq!(std::fs::read(blob_path(&inputs,&grant.relative_path)).unwrap(), b"converted model");
        // A stale or damaged conversion must not prevent the original from running.
        std::fs::write(root.join("model.tflite"), b"damaged").unwrap();
        assert!(matches!(catalog(&sandbox).stage(&inputs,"demo").unwrap(), StagedModel::File { accelerator: None, .. }));
        std::fs::write(root.join("model.tflite"), b"converted model").unwrap();
        std::fs::write(&model, b"different original").unwrap();
        assert!(stage_accelerator(&inputs,&model,2).is_none());
        assert!(stage_accelerator(&inputs,&model,4).is_none());
    }

    #[test]
    fn an_installed_model_is_handed_over_as_a_declaration_and_a_real_file() {
        let sandbox = Sandbox::new("install");
        let bytes = b"pretend this is 5 MB of weights".to_vec();
        let model = sandbox.install("demo", "2", &bytes, 20);
        let inputs = sandbox.inputs();

        let staged = catalog(&sandbox)
            .stage(&inputs, "demo")
            .expect("已安装的模型应该能交出去");
        let StagedModel::File {
            grant,
            min_input_edge,
            ..
        } = staged
        else {
            panic!("模型目录里的一份 ONNX 该走文件那条来路");
        };

        // 声明里的三件事必须和磁盘上的那份**同一件东西**：长度、内容哈希、相对路径。
        assert_eq!(grant.byte_length, bytes.len() as u64);
        assert_eq!(grant.content_hash.len(), 64);
        // 相对路径是内容寻址的：**前两位**做前缀目录、文件名是**整条**内容哈希，扩展名
        // 跟着源文件（`.onnx`）。这里按形状断言，而不是把实现里的拼接式子抄一遍——
        // 真正证明「交给 worker 的就是模型本体」的是下面那几行读文件比字节。
        let (dir, file) = grant
            .relative_path
            .split_once('/')
            .expect("相对路径该有前缀目录");
        assert_eq!(dir, &grant.content_hash[..2], "前缀目录取哈希前两位");
        assert_eq!(
            file,
            format!("{}.onnx", grant.content_hash),
            "文件名是整条哈希 + 源扩展名"
        );
        assert_eq!(min_input_edge, 20, "清单里的最小边长要带出来");

        let handed = blob_path(&inputs, &grant.relative_path);
        let handed_bytes = std::fs::read(&handed).expect("授权文件必须真的在输入根里");
        assert_eq!(handed_bytes, bytes, "交出去的必须是模型本体的字节");
        assert_eq!(
            std::fs::metadata(&model).expect("源模型还在").len(),
            grant.byte_length
        );
    }

    #[test]
    fn the_same_model_is_handed_over_once() {
        let sandbox = Sandbox::new("dedup");
        sandbox.install("demo", "1", b"weights", 1);
        let inputs = sandbox.inputs();
        let catalog = catalog(&sandbox);

        let first = catalog.stage(&inputs, "demo").expect("第一次");
        let second = catalog.stage(&inputs, "demo").expect("第二次");

        assert_eq!(first, second, "同一个模型两次交接必须得到同一份声明");
        // 输入根下是「两位前缀目录 + 一个文件」：内容寻址，第二次不许再摆一份。
        let blobs: Vec<_> = std::fs::read_dir(&inputs)
            .expect("读输入根")
            .flatten()
            .flat_map(|entry| {
                std::fs::read_dir(entry.path())
                    .expect("读前缀目录")
                    .flatten()
            })
            .collect();
        assert_eq!(blobs.len(), 1, "内容寻址：第二次不许再摆一份");
    }

    #[test]
    fn a_model_that_is_not_installed_is_reported_as_unavailable() {
        let sandbox = Sandbox::new("missing");
        let inputs = sandbox.inputs();

        let error = catalog(&sandbox)
            .stage(&inputs, "not-here")
            .expect_err("没装的模型必须报错");

        assert_eq!(error.code(), MODEL_UNAVAILABLE_CODE);
        assert!(error.message().contains("not-here"), "错误里要有那个 id");
        assert_eq!(error, ModelError::NotFound { id: "not-here".into() });
    }

    #[test]
    fn an_empty_model_id_is_not_a_model() {
        let sandbox = Sandbox::new("empty");
        let inputs = sandbox.inputs();

        let error = catalog(&sandbox).stage(&inputs, "  ").expect_err("空 id");

        assert_eq!(error.code(), MODEL_UNAVAILABLE_CODE);
    }

    #[test]
    fn an_ambiguous_install_is_not_usable() {
        let sandbox = Sandbox::new("ambiguous");
        let root = sandbox.install("demo", "1", b"first", 1);
        std::fs::write(root.parent().expect("模型目录").join("extra.onnx"), b"second")
            .expect("再放一个 onnx");
        let inputs = sandbox.inputs();

        // 两个 `.onnx` 谁是谁说不清：宁可说「没有可用的模型」，也不要猜一个。
        let error = catalog(&sandbox)
            .stage(&inputs, "demo")
            .expect_err("有歧义的安装必须被拒");

        assert_eq!(error.code(), MODEL_UNAVAILABLE_CODE);
    }

    #[test]
    fn a_builtin_chain_is_handed_over_as_an_identity_and_nothing_on_disk() {
        let sandbox = Sandbox::new("builtin");
        let inputs = sandbox.inputs();

        let staged = catalog(&sandbox)
            .stage(&inputs, "anime4k-hq")
            .expect("内置的超分链现在也是一条正常的来路");

        // 版本是**缓存身份**的一部分（rendition key 里带着它），所以这里按字面值钉住：
        // 哪天上游的着色器换了、版本号跟着跳，这条断言会先红，提醒去核 rendition key。
        assert_eq!(
            staged,
            StagedModel::Builtin(BuiltinChainGrant {
                chain_id: "anime4k-hq".into(),
                version: "2".into(),
                scale: 2,
            })
        );
        // 内置链**没有文件**：输入根里不该被摆进任何东西。这是这一条与「模型」那条最
        // 本质的差别，也是变异检查会咬的地方（把 builtin 分支改成走文件就会红）。
        let entries: Vec<_> = std::fs::read_dir(&inputs)
            .expect("读输入根")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            entries.is_empty(),
            "内置链不该往输入根里摆东西，摆的是 {entries:?}"
        );
    }

    #[test]
    fn a_builtin_id_the_presets_do_not_know_is_still_a_missing_model() {
        let sandbox = Sandbox::new("builtin-unknown");
        let inputs = sandbox.inputs();

        // 名字里带 anime4k 不是通行证：只有预设表里真有的那几个 id 才走内置那条来路，
        // 其余的仍旧按「这台机器上没有这个模型」报。
        let error = catalog(&sandbox)
            .stage(&inputs, "anime4k-does-not-exist")
            .expect_err("预设表里没有的 id");

        assert_eq!(error.code(), MODEL_UNAVAILABLE_CODE);
    }
}
