import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../../lib/api";
import { toAudiusPlaybackTrack } from "../../lib/audio/audiusPlayback";
import { normalizeActionableAudioTrack } from "../../lib/trackRef";
import { getDeviceDownloadSourceUrl } from "../../features/device-offline/sourceUrl";
import { createPlaybackSourceLeaseController } from "../../components/player/hooks/playbackSourceLeaseController";
import { startTrackPlaybackSourceLease } from "../../components/player/hooks/startTrackPlaybackSourceLease";
import {
    NativeAudioElementEngine,
    type NativeAudioElementLike,
} from "../../lib/audio-engine/nativeAudioElementEngine";

const entry = {
    source: "audius",
    id: "7AlA9",
    title: "Sinners",
    artist: "RAC",
    artistHandle: "RAC",
    artistVerified: true,
    durationSeconds: 237,
    attributionUrl: "https://audius.co/RAC/sinners",
    fullStreamAvailable: true,
    automaticFallbackEligible: false,
    downloadAllowed: false,
};
const streamUrl =
    "https://creatornode.audius.co/tracks/cidstream/QmQqUCXvUESsp6j5Dp36n3i679q71UG9UNBMjT376cWRbb?signature=provider-only&skip_play_count=true";
const cdnStreamUrl =
    "https://validator.eeba4a6ca56a0d87af802270217c2a51.r2.cloudflarestorage.com/WRb/QmQqUCXvUESsp6j5Dp36n3i679q71UG9UNBMjT376cWRbb?" +
    new URLSearchParams({
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Checksum-Mode": "ENABLED",
        "X-Amz-Credential": "a".repeat(32) + "/20260905/ENAM/s3/aws4_request",
        "X-Amz-Date": "20260905T135000Z",
        "X-Amz-Expires": "7200",
        "X-Amz-SignedHeaders": "host",
        "X-Amz-Signature": "b".repeat(64),
        "x-id": "GetObject",
    });
function element(): NativeAudioElementLike {
    return {
        src: "",
        currentTime: 0,
        duration: 237,
        paused: true,
        ended: false,
        muted: false,
        volume: 1,
        preload: "",
        crossOrigin: null,
        error: null,
        play: async () => {},
        pause() {},
        removeAttribute() {},
        load() {},
        addEventListener() {},
        removeEventListener() {},
    };
}

for (const streamUrl of [
    "https://creatornode.audius.co/tracks/cidstream/QmQqUCXvUESsp6j5Dp36n3i679q71UG9UNBMjT376cWRbb?signature=provider-only&skip_play_count=true",
    cdnStreamUrl,
])
    test(`search API → source-labelled queue → fresh resolve → native engine never sends app credentials to ${new URL(streamUrl).hostname}`, async () => {
        const previous = globalThis.fetch;
        const calls: string[] = [];
        globalThis.fetch = async (input, init) => {
            const url = String(input);
            calls.push(url);
            assert.equal(
                new Headers(init?.headers).get("Authorization"),
                "Bearer private-fixture",
            );
            if (url.includes("/audius/search?"))
                return Response.json({ source: "audius", tracks: [entry] });
            assert.ok(url.endsWith("/audius/tracks/7AlA9/playback"));
            return Response.json({
                source: "audius",
                trackId: "7AlA9",
                streamUrl,
            });
        };
        api.setToken("private-fixture");
        const nativeElement = element();
        const engine = new NativeAudioElementEngine({
            createElement: () => nativeElement,
            bindGlobalListener: () => () => {},
            telemetry: () => {},
        });
        const controller = createPlaybackSourceLeaseController();
        try {
            const tracks = (await api.searchAudius("RAC")).map(
                toAudiusPlaybackTrack,
            );
            const queued = normalizeActionableAudioTrack(tracks[0])!;
            assert.throws(() => getDeviceDownloadSourceUrl(queued), /Audius/);
            await new Promise<void>((resolve, reject) =>
                startTrackPlaybackSourceLease({
                    controller,
                    track: queued,
                    networkUrl: "/must-not-load-local",
                    isCurrent: () => true,
                    onReady(url) {
                        engine.load(
                            { url, sourceType: "audius" },
                            {
                                autoplay: false,
                                format: "mp3",
                                withCredentials: false,
                            },
                        );
                        resolve();
                    },
                    onError: reject,
                }),
            );
            assert.equal(nativeElement.src, streamUrl);
            assert.equal(nativeElement.crossOrigin, "anonymous");
            assert.equal(calls.length, 2);
            assert.ok(
                calls.every(
                    (url) =>
                        !url.includes("/library/") &&
                        !url.includes("/ytmusic/"),
                ),
            );
            assert.doesNotMatch(nativeElement.src, /private-fixture|token=/);
        } finally {
            controller.release();
            engine.destroy();
            api.clearToken();
            globalThis.fetch = previous;
        }
    });

test("a CDN URL carrying an app credential is rejected before the engine receives it", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = async () =>
        Response.json({
            source: "audius",
            trackId: "7AlA9",
            streamUrl: cdnStreamUrl + "&token=private-fixture",
        });
    api.setToken("private-fixture");
    const controller = createPlaybackSourceLeaseController();
    try {
        const error = await new Promise<unknown>((resolve, reject) =>
            startTrackPlaybackSourceLease({
                controller,
                track: toAudiusPlaybackTrack(entry),
                networkUrl: "/must-not-load-local",
                isCurrent: () => true,
                onReady: () => reject(new Error("Unsafe CDN reached engine")),
                onError: resolve,
            }),
        );
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /private-fixture|X-Amz-Signature/);
    } finally {
        controller.release();
        api.clearToken();
        globalThis.fetch = previous;
    }
});

test("unavailable Audius fails the source lease instead of falling back to local/YouTube", async () => {
    const previous = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return Response.json(
            { error: "full stream unavailable" },
            { status: 422 },
        );
    };
    api.setToken("private-fixture");
    const controller = createPlaybackSourceLeaseController();
    try {
        const error = await new Promise<unknown>((resolve, reject) =>
            startTrackPlaybackSourceLease({
                controller,
                track: toAudiusPlaybackTrack(entry),
                networkUrl: "/must-not-load-local",
                isCurrent: () => true,
                onReady: () =>
                    reject(new Error("Unavailable source reached engine")),
                onError: resolve,
            }),
        );
        assert.equal((error as { status: number }).status, 422);
        assert.equal(calls, 1);
    } finally {
        controller.release();
        api.clearToken();
        globalThis.fetch = previous;
    }
});

test("a cancelled Audius resolution cannot reach the engine even when fetch returns late", async () => {
    const previous = globalThis.fetch;
    let finish!: (response: Response) => void;
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_input, init) => {
        requestSignal = init?.signal;
        return new Promise<Response>((resolve) => {
            finish = resolve;
        });
    };
    api.setToken("private-fixture");
    const controller = createPlaybackSourceLeaseController();
    let ready = 0;
    let errors = 0;
    try {
        startTrackPlaybackSourceLease({
            controller,
            track: toAudiusPlaybackTrack(entry),
            networkUrl: "/must-not-load-local",
            isCurrent: () => true,
            onReady() {
                ready++;
            },
            onError() {
                errors++;
            },
        });
        await new Promise((resolve) => setImmediate(resolve));
        controller.release();
        assert.equal(requestSignal?.aborted, true);
        finish(
            Response.json({ source: "audius", trackId: "7AlA9", streamUrl }),
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(ready, 0);
        assert.equal(errors, 0);
    } finally {
        controller.release();
        api.clearToken();
        globalThis.fetch = previous;
    }
});
