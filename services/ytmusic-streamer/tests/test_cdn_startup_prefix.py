"""A slow CDN must not hold a playable prefix behind a bulk read buffer."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace


def test_first_prefix_arrives_before_cdn_releases_bulk_body(monkeypatch):
    import ytmusic_stream as stream

    prefix = b"a" * 8192
    payload = prefix + b"b" * (131072 - len(prefix))
    release_body = threading.Event()
    ranges = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            first, last = map(int, self.headers["Range"].removeprefix("bytes=").split("-"))
            ranges.append((first, last))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {first}-{last}/{len(payload)}")
            self.send_header("Content-Length", str(last - first + 1))
            self.end_headers()
            if first == 0:
                self.wfile.write(prefix)
                self.wfile.flush()
                release_body.wait(timeout=5)
                first = len(prefix)
            self.wfile.write(payload[first : last + 1])

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setattr(stream, "_SPOOL_CDN_RANGE_BYTES", 65536)
    chunks = stream._iter_progressive_cdn_chunks(
        f"http://127.0.0.1:{server.server_port}/audio",
        {},
        SimpleNamespace(cancel_event=threading.Event(), current_priority=lambda: 2),
        len(payload),
        time.monotonic(),
    )
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            first_chunk = executor.submit(next, chunks)
            try:
                assert first_chunk.result(timeout=1) == (prefix, len(payload))
            finally:
                release_body.set()
        remaining = list(chunks)
        assert prefix + b"".join(chunk for chunk, _ in remaining) == payload
        assert ranges == [(0, 65535), (65536, 131071)]
        assert len(remaining[-1][0]) == 65536
    finally:
        release_body.set()
        chunks.close()
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
