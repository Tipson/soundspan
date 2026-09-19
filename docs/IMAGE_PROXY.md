# External cover images

The backend validates image URLs and their DNS results before fetching them.
Every redirect is followed manually and validated again. Private destinations
are rejected, unsuccessful response bodies are cancelled, and image bodies have
a streamed byte limit (15 MiB by default). Each request deadline covers its body.

The HTTPS image origins `i.ytimg.com`, `yt3.ggpht.com`,
`yt3.googleusercontent.com` and `lh3.googleusercontent.com` use Axios's Node HTTP
adapter. This adapter honors the operator's existing `HTTPS_PROXY` and `NO_PROXY`
configuration. It uses a direct connection when no applicable proxy is configured.
No additional credentials or application-wide proxy switch are required.

Proxy eligibility requires an exact hostname, the standard HTTPS port, and no
URL credentials. Arbitrary subdomains and redirect targets are not implicitly
trusted. All other images use native fetch, retaining their existing connection
policy. Audio, provider extraction, and internal service requests are unaffected.

For proxied connections, the proxy resolves the origin and is part of the trust
boundary; the local DNS guard cannot pin the proxy's destination. This is why
proxy-aware image fetching is restricted to the fixed provider-owned origins,
not enabled for arbitrary user-supplied URLs. Proxy credentials must remain in
the server's protected environment and must not be logged or sent to browsers.

The Node-to-Web stream bridge uses a byte-counted 64 KiB buffer, and the existing
consumer enforces the image size cap. Cancellation propagates to the upstream
stream. Neither an unlimited buffer nor a direct-connection retry is used to
bypass a failed proxy.
