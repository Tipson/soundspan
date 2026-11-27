# Reverse Proxy and Cloudflare Tunnel Setup

This guide covers routing for soundspan, including Listen Together Socket.IO traffic.
It applies to any split frontend/backend deployment model (Kubernetes individual mode, docker-compose with separate `frontend` + `backend` services, or manual container setups).

Important for pre-published frontend images:

- `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_API_PATH_MODE` are build-time variables.
- Changing them at container runtime does not change browser routing behavior.
- Use edge reverse-proxy path routing for backend-direct API access.

## Why this matters

When frontend and backend are separate services, Socket.IO traffic still has to reach backend somehow.
soundspan now handles this by default through the frontend runtime proxy.

Listen Together uses:

- namespace: `/listen-together`
- Socket.IO path: `/socket.io/listen-together`
- default transport policy: websocket-only (`LISTEN_TOGETHER_ALLOW_POLLING=false`)

By default, requests to this path can terminate on frontend, which forwards them to backend.
Listen Together preflights this route and blocks create/join with an explicit routing error banner when it is misconfigured.

## Required routing

### Default (recommended): Route all traffic to frontend

For split frontend/backend deployments:

- Route all app traffic (including `/socket.io/listen-together`) to frontend service (`:3030`)
- Frontend proxies `/socket.io/listen-together` to backend service (`:3006`)
- Route `/api/*` to frontend when using frontend proxy mode (works without `NEXT_PUBLIC_*` runtime env overrides)

### Optional: Direct backend path-split routing

Use this when you want backend-direct API paths with pre-published frontend images (no custom frontend rebuild):

- Route the `/api/track-audio/versions/` prefix to the frontend service (`:3030`) before the general API rule.
- Route all other `/api/*` requests to the backend service (`:3006`). API clients send their bearer credentials directly.
- Route `/socket.io/listen-together` (Prefix) to backend service (`:3006`)
- Route all other app traffic (for example `/`) to frontend service (`:3030`)

The frontend proxy converts the browser's media cookie to an Authorization header
for `GET` and `HEAD` requests to version streams. The same stream path serves
administrator previews and published audio.

This route split is the runtime-safe replacement for trying to set `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_API_PATH_MODE` on a prebuilt image.
If you do want true in-app `direct` mode, publish a custom frontend image built with the desired `NEXT_PUBLIC_*` values.

For single-service deployments (all-in-one image, Helm `deploymentMode: aio`):

- Route everything to the single soundspan service (`:3030`)

## OIDC callback routing

First select the app/API layout in the [`OIDC_SSO.md` deployment topology matrix](OIDC_SSO.md#deployment-topology). The matrix states when `OIDC_WEB_BASE_URL` is required. Cross-site app/API deployments on different registrable domains are not supported.

Set `OIDC_REDIRECT_URI` to the public URL that users open. Register the same exact value at the identity provider:

```env
OIDC_REDIRECT_URI=https://soundspan.example.com/api/auth/oidc/callback
```

The callback path must reach the backend. The default examples below send the callback through the frontend proxy. The direct path-split examples send it straight to the backend.

Keep the public scheme, host, port, and path identical in soundspan and the identity provider. Do not use a container-only hostname in `OIDC_REDIRECT_URI`.

When the callback origin differs from the web origin but remains same-site, set the canonical web origin:

```env
OIDC_REDIRECT_URI=https://api.example.com/api/auth/oidc/callback
OIDC_WEB_BASE_URL=https://music.example.com
```

Set `SECURE_COOKIES=true` when the browser uses HTTPS, including when Cloudflare or another edge terminates TLS.

## NGINX example (Docker/Kubernetes edge)

The track audio draft endpoint accepts a raw MP3 body up to 16 MiB. Set NGINX's
[`client_max_body_size`](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)
to at least `16m` in the server block or location that receives
`PUT /api/track-audio/<source>/<trackId>/draft`. The API enforces its own limit.

```nginx
server {
    listen 443 ssl http2;
    server_name soundspan.example.com;
    client_max_body_size 16m;

    # Everything -> frontend (frontend proxies Listen Together socket path)
    location / {
        proxy_pass http://soundspan-frontend:3030;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Optional direct path-split variant:

```nginx
server {
    listen 443 ssl http2;
    server_name soundspan.example.com;

    location ^~ /api/track-audio/versions/ {
        proxy_pass http://soundspan-frontend:3030;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ {
        client_max_body_size 16m;
        proxy_pass http://soundspan-backend:3006;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket.io/listen-together {
        proxy_pass http://soundspan-backend:3006;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        proxy_pass http://soundspan-frontend:3030;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

If your reverse proxy already fronts a Helm ingress or gateway, point it at the
Helm entrypoint. In individual mode the chart sends API requests, including
audio version streams, to the frontend and routes Listen Together sockets
directly to the backend.

## Caddy example

```caddy
soundspan.example.com {
    reverse_proxy soundspan-frontend:3030
}
```

Optional direct path-split variant:

```caddy
soundspan.example.com {
    reverse_proxy /api/track-audio/versions/* soundspan-frontend:3030

    @api path /api/*
    reverse_proxy @api soundspan-backend:3006

    @listenTogether path /socket.io/listen-together*
    reverse_proxy @listenTogether soundspan-backend:3006

    reverse_proxy soundspan-frontend:3030
}
```

## Cloudflare Tunnel example (`cloudflared`)

`cloudflared` supports websocket transport.
For default mode, route hostname to frontend.

```yaml
ingress:
  - hostname: soundspan.example.com
    service: http://soundspan-frontend.soundspan.svc.cluster.local:3030
  - service: http_status:404
```

Optional direct path-split variant (regex path matcher):

```yaml
ingress:
  - hostname: soundspan.example.com
    path: "^/api/track-audio/versions/"
    service: http://soundspan-frontend.soundspan.svc.cluster.local:3030
  - hostname: soundspan.example.com
    path: "^/api/"
    service: http://soundspan-backend.soundspan.svc.cluster.local:3006
  - hostname: soundspan.example.com
    path: "^/socket[.]io/listen-together(/|$)"
    service: http://soundspan-backend.soundspan.svc.cluster.local:3006
  - hostname: soundspan.example.com
    service: http://soundspan-frontend.soundspan.svc.cluster.local:3030
  - service: http_status:404
```

Notes:

- If your tunnel points to an existing reverse proxy/ingress, configure this path split there instead of in `cloudflared`.
- Keep websocket-friendly timeouts on any proxy layer between Cloudflare and soundspan.

## Verification checklist

1. Open browser devtools Network tab.
2. Visit Listen Together page and join/create a session.
3. Confirm socket handshake requests use `/socket.io/listen-together`.
4. Confirm requests return success and websocket upgrade is established.
5. Confirm UI state changes from `Connecting...` to connected (and no routing error banner appears).
6. Optional direct probe (when polling fallback is enabled): open `/socket.io/listen-together/?EIO=4&transport=polling` in browser.
7. If using default websocket-only policy (`LISTEN_TOGETHER_ALLOW_POLLING=false`), validate by confirming a successful websocket upgrade in browser devtools instead of polling probe.
8. In the track audio dialog, play a draft as an administrator. In the network tab, check that `GET /api/track-audio/versions/<id>/stream` returns `200` or `206`. After publication, start the track using an ordinary account and verify the same stream plays.

## Common failure signs

- Repeating frontend logs with `TypeError: fetch failed` when backend path is unreachable.
- Listen Together permanently showing `Connecting...`.
- Listen Together page shows a routing error banner and create/join buttons stay disabled.
- Socket.IO polling requests returning 404/502 from the wrong upstream.

---

## See also

- [Deployment Guide](DEPLOYMENT.md) — Docker and compose deployment options
- [Kubernetes Guide](KUBERNETES.md) — Helm deployment and HA rollout
- [Configuration and Security](CONFIGURATION_AND_SECURITY.md) — External access settings and CORS configuration
- [OIDC and SSO](OIDC_SSO.md) — Identity-provider and callback setup
