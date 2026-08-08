# Security scanning policy

## Python dependency audit exceptions

The `pip-audit` CI job is blocking. Each hash-pinned runtime lock is audited
without dependency resolution, and unexpected advisory IDs fail the job. The
exact temporary exceptions live beside their matrix lanes in
[`security-scanning.yml`](../.github/workflows/security-scanning.yml).

Two legacy TensorFlow lanes have compatibility exceptions:

| Lock | Constrained packages | Removal condition |
| --- | --- | --- |
| `services/audio-analyzer/requirements.lock` | cryptography, Keras, Markdown, protobuf, requests, setuptools, urllib3, Werkzeug, wheel | Replace the Ubuntu 20.04 / Python 3.8 / TensorFlow 2.13 analyzer stack under roadmap F51. |
| `requirements-aio.lock` | Keras 2.15 and protobuf 4.25 | Move the AIO analyzer off TensorFlow 2.15, whose dependency constraints prevent the audited fixed major versions. |

These entries are compatibility risk acceptances, not declarations that the
affected releases are safe. Lock regeneration is performed with `uv pip
compile --upgrade-package`; if the resolver can select a compatible fixed
release, remove the corresponding advisory ID in the same change. New IDs are
never added automatically.
