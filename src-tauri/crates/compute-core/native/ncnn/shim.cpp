#include <net.h>
#include <gpu.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>

extern "C" void kmp_set_defaults(const char*);
namespace {
std::once_flag instance;
thread_local std::string last_error;
int gpu_index() {
    std::call_once(instance, [] {
        // Android CPU hotplug can invalidate libomp's affinity topology snapshot.
        setenv("KMP_AFFINITY", "disabled", 1); setenv("KMP_TOPOLOGY_METHOD", "flat", 1);
        setenv("OMP_PROC_BIND", "false", 1); unsetenv("OMP_PLACES");
        kmp_set_defaults("KMP_AFFINITY=disabled|KMP_TOPOLOGY_METHOD=flat");
        ncnn::create_gpu_instance();
    });
    for (int i = 0; i < ncnn::get_gpu_count(); ++i)
        if (ncnn::get_gpu_info(i).type() <= 1) return i;
    return -1;
}
struct Session { ncnn::Net net; };
}
extern "C" {
const char* yomika_ncnn_error() { return last_error.c_str(); }
const char* yomika_ncnn_device() {
    int gpu = gpu_index();
    return gpu < 0 ? nullptr : ncnn::get_gpu_info(gpu).device_name();
}
void* yomika_ncnn_open(const char* param, const unsigned char* weights) {
    try {
        int gpu = gpu_index();
        if (gpu < 0) { last_error = "No physical Vulkan GPU"; return nullptr; }
        auto s = std::make_unique<Session>();
        s->net.opt.use_vulkan_compute = true;
        s->net.opt.num_threads = 2;
        s->net.opt.use_fp16_packed = false;
        s->net.opt.use_fp16_storage = false;
        s->net.opt.use_fp16_arithmetic = false;
        s->net.set_vulkan_device(gpu);
        if (s->net.load_param_mem(param) != 0 || s->net.load_model(weights) == 0) {
            last_error = "ncnn model load failed"; return nullptr;
        }
        return s.release();
    } catch (const std::exception& e) { last_error = e.what(); return nullptr; }
}
int yomika_ncnn_run(void* handle, const float* input, float* output,
                    int width, int height, int whole_frame) {
    try {
        auto* s = static_cast<Session*>(handle);
        ncnn::Mat in(width, height, 3);
        if (in.empty()) { last_error = "ncnn could not allocate RGB input"; return -1; }
        size_t pixels = size_t(width) * height;
        for (int c = 0; c < 3; ++c)
            std::memcpy(in.channel(c), input + c * pixels, pixels * sizeof(float));
        if (whole_frame) {
            // Match the ONNX graph: reflect by 18 and round the padded extent up to even.
            ncnn::Mat padded;
            ncnn::copy_make_border(in, padded, 18, 18 + height % 2, 18, 18 + width % 2,
                                   ncnn::BORDER_REFLECT, 0.f);
            if (padded.empty()) { last_error = "ncnn could not pad RGB input"; return -1; }
            in = padded;
        }
        auto ex = s->net.create_extractor();
        ncnn::Mat out;
        if (ex.input("input", in) != 0 || ex.extract("output", out) != 0) {
            last_error = "ncnn Vulkan inference failed"; return -1;
        }
        const int ow = width * 2, oh = height * 2;
        if (out.w != ow + (whole_frame ? 2 * (width % 2) : 0) ||
            out.h != oh + (whole_frame ? 2 * (height % 2) : 0) ||
            out.c != 3 || out.elempack != 1 || out.elemsize != 4) {
            last_error = "ncnn returned unexpected RGB output shape"; return -1;
        }
        // Match the dynamic ONNX output crop for odd dimensions.
        for (int c = 0; c < 3; ++c) {
            const float* plane = out.channel(c);
            float* destination = output + size_t(c) * ow * oh;
            for (int y = 0; y < oh; ++y) {
                const float* row = plane + size_t(y) * out.w;
                for (int x = 0; x < ow; ++x) {
                    if (!std::isfinite(row[x])) { last_error = "Non-finite ncnn output"; return -1; }
                    destination[size_t(y) * ow + x] = row[x];
                }
            }
        }
        return 0;
    } catch (const std::exception& e) { last_error = e.what(); return -1; }
}
void yomika_ncnn_close(void* handle) { delete static_cast<Session*>(handle); }
}
