# Server memory stability

## Scope

The DCLAP single-host release limits resident decoded audio to one waveform across decoding, inference-lock waiting, model inference and cancellation cleanup. Text requests can still run during blocking audio decode. Quantization uses a bounded int16 temporary and preserves the float32 recipe exactly. Model weights, embedding identity, 30-minute decode cap, segmentation and recommendation weights are unchanged.

The single-host overlay gives DCLAP 4 GiB RAM, a 6 GiB combined RAM/swap ceiling, 120 seconds of shutdown grace and three rotating 10 MiB JSON logs. This is headroom for the real ONNX bundle and audio preprocessing, not a change to playback timeouts or user-facing queue capacity.

## Evidence

- Regression tests fail on the previous implementation: another request decodes while the first retains its waveform; quantization allocates 48,000,508 bytes of temporaries for a 16,000,000-byte input.
- The changed DCLAP suite passes 78 tests, including cancellation, error recovery, retained exception traceback cleanup, bit-identical quantization and bounded allocations. Seven single-host Compose behavior checks pass. Ruff and strict mypy pass for all seven DCLAP runtime modules.
- An isolated container with the actual production ONNX models, no network, two CPU cores and 4 GiB RAM runs three concurrent synthetic WAV requests and decodes an 1801-second file capped to 1800 seconds. Peak process RSS: 2424.2 MiB before, 1745.8 MiB after (28% lower). Text and all three audio vectors are exactly equal. This tests real model memory and compatibility, not recommendation quality or maximum simultaneous music listeners. The long file is decoded, not fully inferred.

## Host maintenance boundary

Obsolete image-transfer archives in a tmpfs staging directory consume RAM and swap. Release uploads belong on disk-backed `/var/tmp`, in a task-specific staging directory. After image import and identity verification, remove only the exact transfer archive; keep the active image and a rollback image. Do not prune volumes or backups as part of release staging cleanup.

For this host, 28 validated obsolete Soundspan archives released 8,940,198,400 bytes. Swap use fell from 8104 to 1635 MiB without swapoff or reboot. This is not evidence of a current host-wide OOM: the confirmed OOM belonged to DCLAP's former 2 GiB cgroup.

The general Proxmox backup job shares the Kingston SSD with Soundspan's container disks. Its configured bandwidth limit is 51200 KiB/s and maximum workers is two. Schedule, retained copies and guest exclusions are unchanged. The next complete nightly cycle remains a separate operational validation; a quiet daytime probe cannot establish peak backup latency. The minimal CT121 backup and offsite backup remain enabled.

## Deployment and rollback

Deploy only `vibe-provider-dclap`, with no dependency recreation. Preserve its media read-only mounts, internal authentication, network boundary and model files. Verify health, an authenticated embedding request, resource/log limits and unchanged IDs/start times for every other container.

Rollback uses the saved Compose overlay and the preceding local image. Keep the 4 GiB memory containment even if reverting code while investigating another issue. Re-render Compose and repeat the same single-service health checks. Do not combine this release with unrelated library updates or database migrations.
