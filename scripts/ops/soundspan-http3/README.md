# Dedicated Soundspan HTTP/3 egress

These host-specific examples belong in the music host's network namespace,
not the router or a shared VPN host. They use a direct Freedom outbound;
there is no foreign relay or VPN outbound in `direct.example.json`.

The streamer opt-in is `YTMUSIC_CDN_HTTP3=1`. Signed GoogleVideo media uses
verified HTTP/3. `YTMUSIC_METADATA_HTTP3=1` additionally moves the fixed YouTube
extraction endpoints and ytimg assets to bounded, synchronous QUIC requests.
An optional `YTMUSIC_HTTP3_DOH_URL=https://1.1.1.1/dns-query` avoids dependency
on a filtered host resolver without changing it. Other metadata uses its
existing HTTP proxy interface. The example
bridge listens on `172.30.121.9:18125` and allows only the streamer's static
internal address `172.30.121.11`. Adapt those addresses to the actual private
Docker network. Do not allow a dynamically reused container address in the
proxy ACL. Keep `NO_PROXY` for internal services.

The native runtime needs `curl-cffi==0.17.0` and its locked dependencies.
The profile examples expect the previously verified zapret2 v1.0.7 runtime
(`nfqws2`, `zapret-lib.lua`, `zapret-antidpi.lua`, Google's QUIC fake blob)
under `/opt/soundspan-http3-egress`, and the existing Soundspan Xray binary at
`/opt/soundspan-egress-reserve/xray`. Binary/runtime artifacts are not stored
in Git. Copy `soundspan_http3_rules.py` from the parent directory as `rules.py`.
Install the adapted JSON and proxy configuration as `direct.json` and
`privoxy.config` beside it, with the unit files under `/etc/systemd/system`.

Create `youtube-hosts.txt` with these suffixes:

```text
youtube.com
googlevideo.com
ytimg.com
googleapis.com
gstatic.com
```

Validate the Xray configuration, Privoxy configuration and unit files before
starting the three units. The NFQUEUE number is `33363`; direct metadata
sockets use mark `0x5354`. Only marked TCP/443 and the exact IPv4 addresses
of `soundspan-prod-ytmusic` enter this queue. UDP fake processing is limited
to QUIC Initial payloads for the host list. Rules intentionally do not depend
on a host-wide `nf_conntrack_acct` setting. No table or chain is flushed.

DNS uses local-mode DoH with literal, TLS-verified upstream addresses. This
avoids routing the resolver back through the same outbound resolution path.
Resolver retries otherwise can dominate metadata acquisition even when the
media CDN responds quickly.

The helper verifies the running container name and Compose service label.
It derives source IPv4s from Docker, rather than capturing all traffic for a
UID or subnet. After recreating the container, reload the profile so dynamic
addresses are refreshed:

```sh
systemctl reload soundspan-http3-nfq.service
```

For a cutover, validate the profile against the current network namespace,
then stop the three dedicated units before replacing the container. Start
them after the replacement is healthy, and verify real audio and owned rule
counters. This avoids leaving an old dynamic source address selected during
container recreation. Retain the previous Compose file list, image ID and
proxy values for rollback. Revert only this streamer's overlay and stop these
three units; `ExecStopPost` removes only the exact owned rules even if Docker
is unavailable. Do not change the shared VPN to roll back this profile.
