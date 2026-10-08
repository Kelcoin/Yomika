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

use yomika_compute_protocol::messages::GrantedFile;

use super::artifacts::hash_file;
use super::inputs;

/// 「这台机器上拿不到这份模型」的统一错误码：前端要能把它和「输入坏了」分开——
/// 一个是去下载/检查安装，另一个是重新取一页。
pub const MODEL_UNAVAILABLE_CODE: &str = "COMPUTE_MODEL_UNAVAILABLE";

/// 一次成功的交接：worker 要的声明 + 清单给的最小输入边长。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedModel {
    pub grant: GrantedFile,
    /// 清单里的 `minInputEdge`。搬进 worker 是因为引擎要拿它判断「这张图对这个模型
    /// 来说太小了」——那是模型自带的事实，不该让调用方猜。
    pub min_input_edge: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    /// 没装、装了一半（没有清单）、或装法有歧义（目录里不止一个 `.onnx`）。
    NotFound { id: String },
    /// 模型在，但在交给 worker 之前就出错了（读不到、算不出哈希、摆不进输入根）。
    NotStaged { id: String, detail: String },
    /// 宿主内置的 shader 链（Anime4K 那类）：它只编译在宿主进程里，worker 那份构建
    /// 里根本没有它，所以这不是「没下载」，是「这条路根本不通」。
    HostOnly { id: String },
}

impl ModelError {
    pub fn code(&self) -> &'static str {
        match self {
            ModelError::NotFound { .. } | ModelError::NotStaged { .. } => MODEL_UNAVAILABLE_CODE,
            ModelError::HostOnly { .. } => "COMPUTE_BAD_REQUEST",
        }
    }

    pub fn message(&self) -> String {
        match self {
            ModelError::NotFound { id } => format!(
                "这台机器上没有可用的模型 {id}（没下载、没装完、或安装目录里不止一个 .onnx）"
            ),
            ModelError::NotStaged { id, detail } => {
                format!("模型 {id} 在交给计算进程之前就出错了：{detail}")
            }
            ModelError::HostOnly { id } => format!(
                "{id} 是宿主内置的超分链，计算进程里没有它：这一阶段不能交给 worker"
            ),
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

    /// 把 `model_spec_id` 指的那份模型摆进 `inputs_root`，返回给 worker 的声明。
    ///
    /// 这是一次**内容寻址**的摆放：同一个模型第二次来会命中已有的那块，不会第二份。
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
        if crate::inference::is_host_only_upscaler(id) {
            return Err(ModelError::HostOnly { id: id.to_string() });
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
        Ok(StagedModel {
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
    fn an_installed_model_is_handed_over_as_a_declaration_and_a_real_file() {
        let sandbox = Sandbox::new("install");
        let bytes = b"pretend this is 5 MB of weights".to_vec();
        let model = sandbox.install("demo", "2", &bytes, 20);
        let inputs = sandbox.inputs();

        let staged = catalog(&sandbox)
            .stage(&inputs, "demo")
            .expect("已安装的模型应该能交出去");

        // 声明里的三件事必须和磁盘上的那份**同一件东西**：长度、内容哈希、相对路径。
        assert_eq!(staged.grant.byte_length, bytes.len() as u64);
        assert_eq!(staged.grant.content_hash.len(), 64);
        // 相对路径是内容寻址的：**前两位**做前缀目录、文件名是**整条**内容哈希，扩展名
        // 跟着源文件（`.onnx`）。这里按形状断言，而不是把实现里的拼接式子抄一遍——
        // 真正证明「交给 worker 的就是模型本体」的是下面那几行读文件比字节。
        let (dir, file) = staged
            .grant
            .relative_path
            .split_once('/')
            .expect("相对路径该有前缀目录");
        assert_eq!(dir, &staged.grant.content_hash[..2], "前缀目录取哈希前两位");
        assert_eq!(
            file,
            format!("{}.onnx", staged.grant.content_hash),
            "文件名是整条哈希 + 源扩展名"
        );
        assert_eq!(staged.min_input_edge, 20, "清单里的最小边长要带出来");

        let handed = blob_path(&inputs, &staged.grant.relative_path);
        let handed_bytes = std::fs::read(&handed).expect("授权文件必须真的在输入根里");
        assert_eq!(handed_bytes, bytes, "交出去的必须是模型本体的字节");
        assert_eq!(
            std::fs::metadata(&model).expect("源模型还在").len(),
            staged.grant.byte_length
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
    fn a_host_only_shader_chain_is_refused_as_a_bad_request() {
        let sandbox = Sandbox::new("hostonly");
        let inputs = sandbox.inputs();

        let error = catalog(&sandbox)
            .stage(&inputs, "anime4k-hq")
            .expect_err("宿主内置的链进不了 worker");

        // 「没下载」和「这条路根本不通」是两件事：前者让用户去下载，后者不会因为
        // 下载而变好。所以码也不一样。
        assert_eq!(error.code(), "COMPUTE_BAD_REQUEST");
        assert_eq!(
            error,
            ModelError::HostOnly {
                id: "anime4k-hq".into()
            }
        );
        assert!(error.message().contains("宿主内置"), "理由要说清楚");
    }
}
