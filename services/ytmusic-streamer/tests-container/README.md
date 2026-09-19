# Container startup verification

Set `YTMUSIC_TEST_IMAGE` to an already-built YouTube Music sidecar image, then run:

```text
python -m pytest services/ytmusic-streamer/tests-container/test_entrypoint.py -q
```

Docker is required. The tests execute the checkout's entrypoint inside the image,
with no network and no host-mounted data. They cover root startup with privilege
dropping and an already non-root startup, argument/environment preservation, and
a writable private home directory. Temporary containers and probe directories are
removed automatically. No existing container or volume is changed.

Root startup switches HOME to the image-owned `/home/ytmusic` before dropping to
the `ytmusic` account. `setpriv` alone does not reset HOME. Proxy/auth environment
variables are retained; a general environment reset would break those settings.
This restores the cache directory contract, but does not prove an improvement in
full cold audio startup latency by itself.
