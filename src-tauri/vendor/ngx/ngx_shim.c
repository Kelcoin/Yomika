/* Yomika 的 NGX 核心垫片。
 *
 * 为什么要垫一层：`nvsdk_ngx_s.lib`（NVIDIA 的 DLSS SDK 静态库）是用 /MT 编的，
 * 我们的 Rust 程序是 /MD——直接链会被链接器按 LNK2038 挡下来（RuntimeLibrary
 * 不匹配），硬混两个 CRT 也不安全。所以把「/MT 的世界」关在一个小 DLL 里：这个
 * DLL 只导出三个纯 C 函数，参数与返回值全是整数和裸指针，不跨 CRT 传任何对象。
 *
 * 函数名与签名照 nvsdk_ngx.h 里的声明写——**不 include 那份头**（它是 C++ 的，
 * 我们只要符号名对得上）。
 *
 * 授权：这份 DLL 里链着 NVIDIA 的 DLSS SDK（见同目录 NVIDIA-DLSS-LICENSE.txt），
 * 只能作为本应用的一部分使用与分发。 */

#include <stddef.h>

typedef unsigned int NgxResult;
typedef struct NgxParameter NgxParameter;

/* nvsdk_ngx_s.lib 的导出（C 名字，x64 下不加下划线）。 */
NgxResult NVSDK_NGX_D3D12_Init_with_ProjectID(
    const char *project_id,
    int engine_type,
    const char *engine_version,
    const wchar_t *application_data_path,
    void *device,
    const void *feature_info,
    unsigned int sdk_version);
NgxResult NVSDK_NGX_D3D12_AllocateParameters(NgxParameter **parameters);
NgxResult NVSDK_NGX_D3D12_DestroyParameters(NgxParameter *parameters);

__declspec(dllexport) NgxResult yomika_ngx_init(
    const char *project_id,
    int engine_type,
    const char *engine_version,
    const wchar_t *application_data_path,
    void *device,
    const void *feature_info,
    unsigned int sdk_version)
{
    return NVSDK_NGX_D3D12_Init_with_ProjectID(
        project_id, engine_type, engine_version, application_data_path, device,
        feature_info, sdk_version);
}

__declspec(dllexport) NgxResult yomika_ngx_allocate(NgxParameter **parameters)
{
    return NVSDK_NGX_D3D12_AllocateParameters(parameters);
}

__declspec(dllexport) NgxResult yomika_ngx_destroy(NgxParameter *parameters)
{
    return NVSDK_NGX_D3D12_DestroyParameters(parameters);
}

/* 特性（feature）侧：核心自己会去搜索路径里找 `nvngx_dlssnr.dll` 并调它，所以
 * 创建/评估/释放都走核心的这几个导出（而不是直接调片段的同名导出）。 */
NgxResult NVSDK_NGX_D3D12_CreateFeature(
    void *command_list,
    int feature_id,
    void *parameters,
    void **feature);
NgxResult NVSDK_NGX_D3D12_EvaluateFeature(
    void *command_list,
    const void *feature,
    void *parameters,
    const void *callback);
NgxResult NVSDK_NGX_D3D12_ReleaseFeature(void *feature);

__declspec(dllexport) NgxResult yomika_ngx_create_feature(
    void *command_list, int feature_id, void *parameters, void **feature)
{
    return NVSDK_NGX_D3D12_CreateFeature(command_list, feature_id, parameters, feature);
}

__declspec(dllexport) NgxResult yomika_ngx_evaluate_feature(
    void *command_list, void *feature, void *parameters)
{
    return NVSDK_NGX_D3D12_EvaluateFeature(command_list, feature, parameters, NULL);
}

__declspec(dllexport) NgxResult yomika_ngx_release_feature(void *feature)
{
    return NVSDK_NGX_D3D12_ReleaseFeature(feature);
}
