// Adapted from mihon_img_upscale (Apache-2.0), see ../litert/NOTICE.md.
#include <litert/c/litert_compiled_model.h>
#include <litert/c/litert_environment.h>
#include <litert/c/litert_model.h>
#include <litert/c/litert_options.h>
#include <litert/c/litert_tensor_buffer.h>
#include <android/log.h>
#include <cstring>
#include <string>
#include <cmath>
#include <vector>
#include <memory>
#include <dlfcn.h>
#include <sys/system_properties.h>

namespace {
#define API_FUNCTIONS(X) \
  X(LiteRtCreateEnvironment) X(LiteRtDestroyEnvironment) \
  X(LiteRtCreateOptions) X(LiteRtDestroyOptions) X(LiteRtSetOptionsHardwareAccelerators) \
  X(LiteRtCreateModelFromFile) X(LiteRtDestroyModel) X(LiteRtGetModelSignature) \
  X(LiteRtGetNumSignatureInputs) X(LiteRtGetNumSignatureOutputs) \
  X(LiteRtGetSignatureInputTensorByIndex) X(LiteRtGetSignatureOutputTensorByIndex) \
  X(LiteRtGetRankedTensorType) X(LiteRtCreateCompiledModel) X(LiteRtDestroyCompiledModel) \
  X(LiteRtCompiledModelIsFullyAccelerated) X(LiteRtGetCompiledModelInputBufferRequirements) \
  X(LiteRtGetCompiledModelOutputBufferRequirements) X(LiteRtCreateManagedTensorBufferFromRequirements) \
  X(LiteRtDestroyTensorBuffer) X(LiteRtLockTensorBuffer) X(LiteRtUnlockTensorBuffer) \
  X(LiteRtRunCompiledModel)

struct Runtime {
  void *library = nullptr;
#define DECLARE(name) decltype(&name) name##_ = nullptr;
  API_FUNCTIONS(DECLARE)
#undef DECLARE
  LiteRtEnvironment environment = nullptr;
  LiteRtOptions options = nullptr;
  LiteRtModel model = nullptr;
  LiteRtCompiledModel compiled = nullptr;
  LiteRtTensorBuffer input = nullptr, output = nullptr;
  LiteRtRankedTensorType input_type{}, output_type{};
  int scale = 2, padding = 18;
  bool npu = false;
  std::string key, error, library_directory, cache_directory;

  bool fail(const std::string &message) {
    error = message;
    __android_log_print(ANDROID_LOG_ERROR, "LiteRtBackend", "%s", message.c_str());
    return false;
  }
  bool okay(LiteRtStatus status, const char *stage) {
    return status == kLiteRtStatusOk || fail(std::string(stage) + ": " + std::to_string(status));
  }
  ~Runtime() { close(); }
  void close() {
    if (input) LiteRtDestroyTensorBuffer_(input);
    if (output) LiteRtDestroyTensorBuffer_(output);
    if (compiled) LiteRtDestroyCompiledModel_(compiled);
    if (model) LiteRtDestroyModel_(model);
    if (options) LiteRtDestroyOptions_(options);
    if (environment) LiteRtDestroyEnvironment_(environment);
    input = output = nullptr;
    compiled = nullptr; model = nullptr; options = nullptr; environment = nullptr;
    npu = false; key.clear();
    // Runtime DSOs own TLS destructors: never unload on a worker thread.
    library = nullptr;
  }
  bool check_type(const LiteRtRankedTensorType &type, int side) {
    const auto &l = type.layout;
    return type.element_type == kLiteRtElementTypeFloat32 && l.rank == 4 &&
        !l.has_strides && l.dimensions[0] == 1 && l.dimensions[1] == side &&
        l.dimensions[2] == side && l.dimensions[3] == 3;
  }
  bool load(const std::string &path, const std::string &cache, const std::string &libraries,
            int output_scale, int border, bool cpu_test) {
    std::string identity = path + "|" + cache + "|" + libraries + "|" + std::to_string(output_scale) + "|" + std::to_string(border) + (cpu_test ? "|cpu-test" : "|npu");
    if (compiled && key == identity) return true;
    close(); error.clear();
    if (output_scale < 2 || output_scale > 4) return fail("Unsupported model scale");
    library = dlopen("libLiteRt.so", RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE);
    if (!library) return fail("Unable to load LiteRT runtime");
#define LOAD(name) name##_ = reinterpret_cast<decltype(name##_)>(dlsym(library, #name)); \
    if (!name##_) return fail("Missing LiteRT API: " #name);
    API_FUNCTIONS(LOAD)
#undef LOAD
    LiteRtEnvOption env_options[3]{};
    const LiteRtEnvOptionTag tags[] = {kLiteRtEnvOptionTagCompilerPluginLibraryDir,
        kLiteRtEnvOptionTagDispatchLibraryDir, kLiteRtEnvOptionTagCompilerCacheDir};
    library_directory = libraries; cache_directory = cache;
    const char *values[] = {library_directory.c_str(), library_directory.c_str(), cache_directory.c_str()};
    for (int i = 0; i < 3; ++i) {
      env_options[i].tag = tags[i];
      env_options[i].value.type = kLiteRtAnyTypeString;
      env_options[i].value.str_value = values[i];
    }
    if (!okay(LiteRtCreateEnvironment_(3, env_options, &environment), "Create environment") ||
        !okay(LiteRtCreateOptions_(&options), "Create options") ||
        !okay(LiteRtSetOptionsHardwareAccelerators_(options, cpu_test ?
            kLiteRtHwAcceleratorCpu : kLiteRtHwAcceleratorNpu), "Select accelerator") ||
        !okay(LiteRtCreateModelFromFile_(environment, path.c_str(), &model), "Load model")) return false;
    LiteRtSignature signature = nullptr;
    LiteRtTensor in_tensor = nullptr, out_tensor = nullptr;
    LiteRtParamIndex input_count = 0, output_count = 0;
    if (!okay(LiteRtGetModelSignature_(model, 0, &signature), "Read signature") ||
        !okay(LiteRtGetNumSignatureInputs_(signature, &input_count), "Count inputs") ||
        !okay(LiteRtGetNumSignatureOutputs_(signature, &output_count), "Count outputs")) return false;
    if (input_count != 1 || output_count != 1) return fail("Expected one input and output");
    if (!okay(LiteRtGetSignatureInputTensorByIndex_(signature, 0, &in_tensor), "Input tensor") ||
        !okay(LiteRtGetSignatureOutputTensorByIndex_(signature, 0, &out_tensor), "Output tensor") ||
        !okay(LiteRtGetRankedTensorType_(in_tensor, &input_type), "Input type") ||
        !okay(LiteRtGetRankedTensorType_(out_tensor, &output_type), "Output type")) return false;
    if (!check_type(input_type, 256) || !check_type(output_type, 256 * output_scale))
      return fail("Expected contiguous FP32 NHWC RGB tensors, 256 to 512/768");
    if (!okay(LiteRtCreateCompiledModel_(environment, model, options, &compiled), "Compile model")) return false;
    bool fully_accelerated = false;
    if (!okay(LiteRtCompiledModelIsFullyAccelerated_(compiled, &fully_accelerated), "Check delegation")) return false;
    // Request NPU only and reject any CPU/partial delegation. Never label a CPU model as NPU.
    if (!cpu_test && !fully_accelerated) {
      LiteRtDestroyCompiledModel_(compiled); compiled = nullptr;
      return fail("The model could not be fully delegated to NPU; falling back to another backend");
    }
    LiteRtTensorBufferRequirements in_requirements = nullptr, out_requirements = nullptr;
    if (!okay(LiteRtGetCompiledModelInputBufferRequirements_(compiled, 0, 0, &in_requirements), "Input requirements") ||
        !okay(LiteRtGetCompiledModelOutputBufferRequirements_(compiled, 0, 0, &out_requirements), "Output requirements") ||
        !okay(LiteRtCreateManagedTensorBufferFromRequirements_(environment, &input_type, in_requirements, &input), "Input buffer") ||
        !okay(LiteRtCreateManagedTensorBufferFromRequirements_(environment, &output_type, out_requirements, &output), "Output buffer")) return false;
    key = identity; scale = output_scale; padding = border; npu = !cpu_test;
    __android_log_print(ANDROID_LOG_INFO, "LiteRtBackend", "Ready: %s (%s)", path.c_str(),
                        npu ? "fully delegated NPU" : "CPU validation only");
    return true;
  }
  bool run(const std::vector<float> &data, std::vector<float> &result) {
    if (!compiled || !input || !output || data.size() != 256*256*3) return fail("Model is not ready");
    void *memory = nullptr;
    if (!okay(LiteRtLockTensorBuffer_(input, &memory, kLiteRtTensorBufferLockModeWrite), "Lock input")) return false;
    std::memcpy(memory, data.data(), data.size() * sizeof(float));
    if (!okay(LiteRtUnlockTensorBuffer_(input), "Unlock input") ||
        !okay(LiteRtRunCompiledModel_(compiled, 0, 1, &input, 1, &output), "Execute model")) return false;
    if (!okay(LiteRtLockTensorBuffer_(output, &memory, kLiteRtTensorBufferLockModeRead), "Lock output")) return false;
    result.resize(static_cast<size_t>(256 * scale) * 256 * scale * 3);
    std::memcpy(result.data(), memory, result.size() * sizeof(float));
    return okay(LiteRtUnlockTensorBuffer_(output), "Unlock output");
  }
};
} // namespace
extern "C" {
thread_local std::string npu_error;
const char* yomika_native_directory() {
  static const std::string dir = [] {
    Dl_info info{};
    if (!dladdr(reinterpret_cast<void*>(&yomika_native_directory), &info) || !info.dli_fname) return std::string();
    std::string path(info.dli_fname); return path.substr(0, path.find_last_of('/'));
  }(); return dir.c_str();
}
const char* yomika_npu_vendor() {
  static const std::string vendor = [] {
    char name[PROP_VALUE_MAX]{}; __system_property_get("ro.board.platform", name);
    if (std::string(name).find("mt") == 0) return std::string("MediaTek");
    if (dlopen("libcdsprpc.so", RTLD_NOW | RTLD_NODELETE)) return std::string("Qualcomm");
    return std::string();
  }(); return vendor.c_str();
}
const char* yomika_device_fingerprint() {
  static const std::string value = [] {
    char fingerprint[PROP_VALUE_MAX]{}; __system_property_get("ro.build.fingerprint", fingerprint);
    return std::string(fingerprint);
  }(); return value.c_str();
}
const char* yomika_litert_error() { return npu_error.c_str(); }
void* yomika_litert_open(const char* model, const char* cache, const char* libraries, int scale, bool cpu_test) {
  try {
    // Vendor plugins also register TLS callbacks; hold a NODELETE reference
    // even when LiteRT destroys its own temporary dynamic-library wrappers.
    for (const char* name : {"libQnnHtp.so", "libQnnSystem.so", "libQnnHtpPrepare.so"})
      dlopen(name, RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE);
    const std::string dsp = std::string(yomika_native_directory()) + ";/vendor/dsp/cdsp;/vendor/lib/rfsa/cdsp;/system/vendor/lib/rfsa/cdsp";
    setenv("ADSP_LIBRARY_PATH", dsp.c_str(), 1);
    auto session = std::make_unique<Runtime>();
    if (!session->load(model, cache, libraries, scale, 8, cpu_test)) {
      npu_error = session->error; return nullptr;
    }
    return session.release();
  } catch (const std::exception& e) { npu_error = e.what(); return nullptr; }
}
int yomika_litert_run(void* handle, const float* input, float* output) {
  try {
    auto* session = static_cast<Runtime*>(handle);
    std::vector<float> data(input, input + 256*256*3), result;
    if (!session->run(data, result)) { npu_error = session->error; return -1; }
    for (float v : result) if (!std::isfinite(v)) { npu_error = "Non-finite NPU output"; return -1; }
    std::memcpy(output, result.data(), result.size()*sizeof(float));
    return 0;
  } catch (const std::exception& e) { npu_error = e.what(); return -1; }
}
void yomika_litert_close(void* handle) { delete static_cast<Runtime*>(handle); }
}
