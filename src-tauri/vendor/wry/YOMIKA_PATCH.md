# Android response heap fix

Upstream: wry 0.55.1 (MIT / Apache-2.0). Only Android response transport is changed.

`src/android/binding.rs`: responses larger than 256 KiB use a Java
`ParcelFileDescriptor.AutoCloseInputStream` instead of retaining the complete
body in a Java `byte[]`. An anonymous Unix socket carries the existing Rust body
from a background producer to Chromium with bounded kernel buffering. Java
duplicates the read descriptor; completion/cancellation closes it and unblocks
the producer. No temporary file, full Java array, or extra Rust body copy is
needed. Small producer stacks (64 KiB) keep per-response thread overhead low.
Small responses retain upstream behavior. Headers/status/body bytes are unchanged.

This covers both custom image protocols and Tauri binary IPC responses (original
images, cached pages, remote results). Raising Android's heap limit does not fix
the underlying retained-response problem and is intentionally avoided.

No additional dependencies. Cargo's workspace-root
`[patch.crates-io]` applies this patch to Tauri/Wry on developer machines and CI.
When upgrading Wry, preserve or replace this fix and verify large binary IPC and
image protocol responses on a release APK. Upstream source and license notices
are retained here.
