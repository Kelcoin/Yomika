"""生成动图测试夹具（GIF / APNG / 动画 WebP）。

三个文件内容完全对应：64×48、3 帧、纯红/纯绿/纯蓝、延迟 100/250/40 毫秒、无限循环。
用 Pillow 而不是仓库里的编码器生成，是为了让测试面对的是**别的库写出来的**文件
（自己写自己读，解码器坏在同一处也照样绿）。成品请勿手改，要改就改这个脚本再跑一遍：

    C:\\Python314\\python.exe src-tauri\\src\\dlssnr\\testdata\\make-fixtures.py

WebP 必须 lossless：有损编码会把纯色改掉，而 `animation.rs` 的测试断言每帧颜色原样保留。
"""

from pathlib import Path

from PIL import Image

WIDTH = 64
HEIGHT = 48
COLORS = [(255, 0, 0), (0, 255, 0), (0, 0, 255)]
DURATIONS = [100, 250, 40]

TARGET = Path(__file__).resolve().parent


def frames():
    for color in COLORS:
        yield Image.new("RGB", (WIDTH, HEIGHT), color)


def build(path, **options):
    first, *rest = frames()
    first.save(path, save_all=True, append_images=rest, duration=DURATIONS, loop=0, **options)


def report(path):
    with Image.open(path) as image:
        count = getattr(image, "n_frames", 1)
        durations = []
        pixels = []
        for index in range(count):
            image.seek(index)
            durations.append(image.info.get("duration"))
            pixels.append(image.convert("RGB").getpixel((0, 0)))
        print(
            f"{path.name:16} frames={count} size={image.size} "
            f"durations={durations} pixels={pixels} loop={image.info.get('loop')}"
        )


build(TARGET / "animated.gif")
build(TARGET / "animated.png")
build(TARGET / "animated.webp", lossless=True, quality=100, method=0)
for name in ("animated.gif", "animated.png", "animated.webp"):
    report(TARGET / name)
