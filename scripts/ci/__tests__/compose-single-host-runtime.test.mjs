import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function renderSingleHostCompose() {
    const result = spawnSync(
        "docker",
        [
            "compose",
            "-f",
            "docker-compose.yml",
            "-f",
            "docker-compose.images.yml",
            "-f",
            "docker-compose.single-host.yml",
            "--profile",
            "worker",
            "config",
            "--format",
            "json",
        ],
        {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                ANALYSIS_SPOOL_PATH: "/srv/music/soundspan-analysis-spool",
                INTERNAL_API_SECRET: "test-internal-secret",
                HTTP_PROXY: "http://172.30.121.9:18118",
                HTTPS_PROXY: "http://172.30.121.9:18118",
                MUSIC_PATH: "/srv/music/library",
                MUSIC_VOLUME_MARKER_PATH: "/srv/music/.music-volume",
                POSTGRES_PASSWORD: "test-postgres-password",
                SESSION_SECRET: "test-session-secret",
                SETTINGS_ENCRYPTION_KEY: "test-settings-key",
                SOUNDSPAN_BIND_IP: "192.0.2.10",
                SOUNDSPAN_IMAGE_REPOSITORY: "ghcr.io/example/soundspan",
                SOUNDSPAN_IMAGE_TAG: "main-deadbee",
                SOUNDSPAN_EGRESS_NETWORK: "music-stack_soundspan-internal",
                TIDAL_DATA_PATH: "/opt/soundspan/tidal",
                YTMUSIC_DATA_PATH: "/opt/soundspan/ytmusic",
                YTMUSIC_SPOOL_CONCURRENCY: "4",
                YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT: "420",
                YTMUSIC_SPOOL_MAX_BYTES: "536870912",
                YTMUSIC_SPOOL_TIMEOUT: "125",
                YTMUSIC_SPOOL_TRACK_MAX_BYTES: "83886080",
                YTMUSIC_STREAM_CACHE_MAX: "2048",
                YTMUSIC_YTDLP_SOCKET_TIMEOUT: "25",
            },
        },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

function mountFor(config, serviceName, target) {
    return config.services[serviceName].volumes.find(
        (volume) => volume.target === target,
    );
}

test("single-host split overlay binds public and internal ports deliberately", () => {
    const config = renderSingleHostCompose();

    assert.equal(config.services.frontend.ports[0].host_ip, "192.0.2.10");
    assert.equal(config.services.backend.ports[0].host_ip, "127.0.0.1");
    assert.equal(config.services.postgres.ports[0].host_ip, "127.0.0.1");
    assert.equal(config.services.redis.ports[0].host_ip, "127.0.0.1");
});

test("single-host split overlay preserves tuned YouTube Music streaming limits", () => {
    const config = renderSingleHostCompose();
    const environment = config.services["ytmusic-streamer"].environment;

    assert.equal(environment.YTMUSIC_SPOOL_CONCURRENCY, "4");
    assert.equal(environment.YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT, "420");
    assert.equal(environment.YTMUSIC_SPOOL_MAX_BYTES, "536870912");
    assert.equal(environment.YTMUSIC_SPOOL_TIMEOUT, "125");
    assert.equal(environment.YTMUSIC_SPOOL_TRACK_MAX_BYTES, "83886080");
    assert.equal(environment.YTMUSIC_STREAM_CACHE_MAX, "2048");
    assert.equal(environment.YTMUSIC_YTDLP_SOCKET_TIMEOUT, "25");
});

test("split worker reaches provider sidecars through Compose DNS", () => {
    const config = renderSingleHostCompose();
    const environment = config.services["backend-worker"].environment;

    assert.equal(environment.TIDAL_SIDECAR_URL, "http://tidal-streamer:8585");
    assert.equal(
        environment.YTMUSIC_STREAMER_URL,
        "http://ytmusic-streamer:8586",
    );
});

test("single-host split overlay keeps API and worker responsibilities separate", () => {
    const config = renderSingleHostCompose();

    assert.equal(
        config.services.backend.environment.BACKEND_PROCESS_ROLE,
        "api",
    );
    assert.equal(
        config.services["backend-worker"].environment.BACKEND_PROCESS_ROLE,
        "worker",
    );
});

test("provider sidecars retain the isolated egress proxy network", () => {
    const config = renderSingleHostCompose();

    assert.equal(config.networks["soundspan-egress"].external, true);
    assert.equal(
        config.networks["soundspan-egress"].name,
        "music-stack_soundspan-internal",
    );
    assert.equal(
        config.services["ytmusic-streamer"].networks["soundspan-egress"]
            .ipv4_address,
        "172.30.121.11",
    );
    assert.equal(
        config.services["tidal-streamer"].networks["soundspan-egress"]
            .ipv4_address,
        "172.30.121.10",
    );
    for (const serviceName of ["ytmusic-streamer", "tidal-streamer"]) {
        assert.equal(
            config.services[serviceName].environment.HTTPS_PROXY,
            "http://172.30.121.9:18118",
        );
    }
});

test("backend runtimes reach the scoped egress proxy from allowlisted addresses", () => {
    const config = renderSingleHostCompose();

    assert.equal(
        config.services.backend.networks["soundspan-egress"].ipv4_address,
        "172.30.121.12",
    );
    assert.equal(
        config.services["backend-worker"].networks["soundspan-egress"]
            .ipv4_address,
        "172.30.121.13",
    );
});

test("single-host split overlay keeps the library read-only for core runtimes", () => {
    const config = renderSingleHostCompose();

    for (const serviceName of [
        "backend",
        "backend-worker",
        "audio-analyzer",
        "vibe-provider-dclap",
    ]) {
        const libraryMount = mountFor(config, serviceName, "/music");
        assert.ok(libraryMount, `${serviceName} is missing the music library`);
        assert.equal(
            libraryMount.read_only,
            true,
            `${serviceName} must not gain write access during the AIO migration`,
        );
    }

    for (const serviceName of ["backend", "backend-worker", "audio-analyzer"]) {
        const spoolMount = mountFor(
            config,
            serviceName,
            "/music/.soundspan-analysis-spool",
        );
        assert.ok(spoolMount, `${serviceName} is missing the analysis spool`);
        assert.notEqual(spoolMount.read_only, true);
    }

    const dclapSpool = mountFor(
        config,
        "vibe-provider-dclap",
        "/music/.soundspan-analysis-spool",
    );
    assert.ok(dclapSpool, "vibe-provider-dclap is missing the analysis spool");
    assert.equal(dclapSpool.read_only, true);

    assert.equal(
        mountFor(config, "ytmusic-streamer", "/data").source,
        "/opt/soundspan/ytmusic",
    );
    assert.equal(
        mountFor(config, "tidal-streamer", "/data").source,
        "/opt/soundspan/tidal",
    );
    assert.equal(
        mountFor(config, "ytmusic-streamer", "/run/music-volume").read_only,
        true,
    );
});
