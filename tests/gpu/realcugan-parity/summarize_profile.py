"""Summarise an ORT profile by execution provider, per node.

`DmlExecutionProvider` appearing in the profile is the spec's "the GPU must be
shown doing the work" evidence; the CPU entries say which operators the
DirectML EP handed back, which is the honest way to describe a partial GPU run
instead of calling the whole model accelerated.

  C:\\Python314\\python.exe summarize_profile.py <profile.json>
"""

import collections
import json
import sys


GPU_PROVIDERS = ("Dml", "CUDA", "Tensorrt", "ROCM", "MIGraphX")


def main():
    path = sys.argv[1]
    with open(path, encoding="utf-8") as handle:
        events = json.load(handle)
    by_provider = collections.Counter()
    cpu_ops = collections.Counter()
    gpu_ops = collections.Counter()
    node_events = 0
    for event in events:
        if event.get("cat") != "Node":
            continue
        args = event.get("args") or {}
        provider = args.get("provider")
        if not provider:
            continue
        node_events += 1
        by_provider[provider] += 1
        op = args.get("op_name") or event.get("name")
        if provider.startswith(GPU_PROVIDERS):
            gpu_ops[op] += 1
        else:
            cpu_ops[op] += 1
    print(f"{path}")
    print(f"node events with a provider: {node_events}")
    for provider, count in by_provider.most_common():
        print(f"  {provider}: {count}")
    print(f"  gpu ops: {dict(gpu_ops.most_common())}")
    print(f"  cpu ops: {dict(cpu_ops.most_common())}")


if __name__ == "__main__":
    main()
