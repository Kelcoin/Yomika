//! 一页装不下，就在**派发前**说清楚（docs/71 §11 Task 9 ①、§12.4 ③）。
//!
//! 为什么要有这一层：worker 自己也会拿 `budgets.max_pixels` 门一次（`dlssnr.rs` 里
//! 「页面 W×H 超出这次预算的 N 像素」、`upscale.rs` 同形状），但那时它
//! 已经把图读完、把模型装好——DLSSNR 那一路还多装了一份 165 MB 的片段、建了 NGX 上下文。
//! 拒绝是拒绝了，代价是几十秒的 GPU 时间。而「这一页到底多大」在派发前是**量得出来的**：
//! 读一页图的头就够，不必把像素解出来（一页 25 MP 是 100 MB RGBA，派发前那一步挂在
//! supervisor 线程上，不该为了两个数把它整个读进来）。
//!
//! 为什么读头而不是解图：`ImageReader::open` + `with_guessed_format` + `into_dimensions`
//! 只读开头十几个字节（魔数 + 各格式自己的尺寸字段），一个像素都不解。
//!
//! 为什么认格式要看**字节**而不是文件名：源图落在内容寻址的位置上，那里的名字是一串
//! 哈希，本来就没有扩展名（`inputs`/`cache` 那一侧的名字都是这么长出来的）。
//!
//! **量不到就不拒**：源图解不开、或者根本不是图（老格式、坏字节、索引里那行指向了别的
//! 东西）时这里返回 `None`，判决交给 worker 那一道门。理由与 `resource_policy::admission`
//! 对「读数不好使」是同一条：**一个量不出来的读数不许变成拒绝的理由**——否则一份读不出
//! 头的合法页会被这里永久挡在门外，而用户看到的只是「这一页算不了」。
//!
//! 判据本身只有一条，与 worker 用的是**同一个**上限：`resource_policy::PAGE_PIXEL_LIMIT`。
//! 两边各写一套边界的话，同一条界线迟早会分叉成两条，而分叉之后「worker 拒了、宿主放行」
//! 这类现象查起来要从两个进程同时看。
//!
//! The host rejects only decoded sources over the hard limit. Output projections
//! are advisory: workers shrink the inference input before upscaling when the
//! requested delivery frame would exceed the same budget.

use std::path::Path;

/// 一页的像素尺寸。只有两个数，没有像素。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PagePixels {
    pub width: u32,
    pub height: u32,
}

impl PagePixels {
    /// 总像素。两个 `u32` 相乘最大是 `u32::MAX²≈1.8e19`，`u64` 装得下（不会溢出）。
    pub fn count(self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }

    /// 这一页在不在上限之内：与 worker 的 `budgets.max_pixels` 用的是同一个判据。
    pub fn within_limit(self) -> bool {
        crate::compute::resource_policy::pixels_within_page_limit(self.width, self.height)
    }

    /// 这一页按某个倍率交出来会有多少像素（调用方传入交付倍率）。
    pub fn projected_output(self, scale: u32) -> u64 {
        crate::compute::resource_policy::projected_output_pixels(self.count(), scale)
    }

    /// 这一页乘上倍率之后还装不装得进预算：与 [`Self::within_limit`] 是同一笔预算的两端。
    pub fn output_within_limit(self, scale: u32) -> bool {
        crate::compute::resource_policy::output_pixels_within_budget(self.count(), scale)
    }
}

/// 读一页图的**头**，只为拿尺寸。
///
/// 认不出来（不是图、文件不在、格式没人认）就是 `None`——调用方据此**放行**，把判决交给
/// worker 那一道门。这里不猜尺寸：猜出来的数会变成一条拒绝的理由。
pub fn measure(path: &Path) -> Option<PagePixels> {
    // `with_guessed_format` 是关键那一步：`open` 只按扩展名认格式，而内容寻址的落点没有
    // 扩展名。它只读开头的魔数，不会把图解出来。
    let reader = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?;
    let (width, height) = reader.into_dimensions().ok()?;
    Some(PagePixels { width, height })
}

#[cfg(test)]
mod tests {
    use super::{measure, PagePixels};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 一个只属于这一次用例的落地目录。
    fn scratch(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "yomika-page-budget-{name}-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("建落地目录");
        root
    }

    /// 写一张页图。格式写死成 PNG 而不是让 `save` 按扩展名猜：这条用例要试的正是**没有
    /// 扩展名**的落点，`save` 在那上头会直接说「不认识这个格式」。
    fn write_png(path: &std::path::Path, width: u32, height: u32) {
        let image =
            image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(width, height, image::Luma([0x20])));
        let file = std::fs::File::create(path).expect("建文件");
        image
            .write_to(&mut std::io::BufWriter::new(file), image::ImageFormat::Png)
            .expect("存一张页图");
    }

    /// 尺寸是从**头**里读出来的，而且读完之后那张图还在（不用把像素解出来）。
    #[test]
    fn a_page_of_a_known_size_comes_back_from_the_header() {
        let root = scratch("header");
        let page = root.join("page.png");
        write_png(&page, 8, 5);

        assert_eq!(
            measure(&page),
            Some(PagePixels {
                width: 8,
                height: 5
            }),
            "头里写着 8×5，量出来就得是 8×5"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 内容寻址的落点**没有扩展名**：认格式不能看文件名，得看字节开头的魔数。
    #[test]
    fn a_page_without_an_extension_is_still_measured() {
        let root = scratch("no-extension");
        let page = root.join("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
        write_png(&page, 13, 7);

        assert_eq!(
            measure(&page),
            Some(PagePixels {
                width: 13,
                height: 7
            }),
            "没有扩展名也要认出来：缓存里的位置本来就没有它"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 量不到就返回 `None`（调用方据此**放行**，把判决交给 worker）。
    #[test]
    fn bytes_that_are_not_an_image_have_no_size() {
        let root = scratch("not-an-image");
        let page = root.join("page.png");
        std::fs::write(&page, b"not an image, not even a magic number").expect("写文件");

        assert_eq!(measure(&page), None, "认不出来就得说认不出来，不许猜一个尺寸");
        assert_eq!(
            measure(&root.join("missing.png")),
            None,
            "文件不在也是量不到，不是 0×0"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 界限就是 worker 那一条：多一点、少一点都不含糊。
    #[test]
    fn the_limit_is_the_same_one_the_worker_uses() {
        let limit = crate::compute::resource_policy::PAGE_PIXEL_LIMIT;
        assert_eq!(
            PagePixels {
                width: 16000,
                height: 8000
            }
            .count(),
            limit,
            "16000×8000 恰好是这个上限本身"
        );
        assert!(
            PagePixels {
                width: 16000,
                height: 8000
            }
            .within_limit(),
            "恰好到顶是允许的（与 worker 的 `<=` 一致）"
        );
        assert!(
            !PagePixels {
                width: 16000,
                height: 8001
            }
            .within_limit(),
            "多一行也拒"
        );
        assert!(
            !PagePixels {
                width: u32::MAX,
                height: u32::MAX
            }
            .within_limit(),
            "u32 的极值不许在乘法里溢出成一个「还行」的数"
        );
    }

    /// 输出的那一侧与源图那一侧共用同一个上限：卡在线上放行，多一个像素就拒。
    #[test]
    fn the_output_side_uses_the_same_budget() {
        let on_the_line = PagePixels {
            width: 8000,
            height: 4000,
        };
        assert_eq!(on_the_line.projected_output(2), 128_000_000);
        assert!(
            on_the_line.output_within_limit(2),
            "x2 之后恰好是上限本身：允许"
        );
        assert!(
            !PagePixels {
                width: 8000,
                height: 5000
            }
            .output_within_limit(2),
            "40 MP source projects to 160 MP at x2, requiring worker preprocessing"
        );
        assert!(
            PagePixels {
                width: 16000,
                height: 8000
            }
            .output_within_limit(1),
            "x1 与源图那一侧同一条线"
        );
    }
}
