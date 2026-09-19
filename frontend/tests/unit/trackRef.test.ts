import assert from "node:assert/strict";
import test from "node:test";
import {
    isRetiredRemoteOnlyTrack,
    isRemoteTrack,
    isTrackActionable,
    resolvePreferenceTrackId,
    toAddToPlaylistRef,
    toTrackRef,
    type AddToPlaylistRef,
} from "../../lib/trackRef";

test("retired remote-only TIDAL identity is not actionable", () => {
    const historical = {
        id: "tidal:991",
        streamSource: "tidal" as const,
        tidalTrackId: 991,
    };

    assert.equal(isRetiredRemoteOnlyTrack(historical), true);
    assert.equal(isTrackActionable(historical), false);
    assert.equal(isTrackActionable({ id: "tidal:991" }), false);
});

test("local or active YouTube backing wins over incidental TIDAL metadata", () => {
    const localWithStaleTidal = {
        id: "local-track-1",
        filePath: "/music/local-track-1.flac",
        streamSource: "tidal" as const,
        tidalTrackId: 991,
    };
    const youtubeWithStaleTidal = {
        id: "tidal:991",
        source: "youtube" as const,
        youtubeVideoId: "active-video",
        tidalTrackId: 991,
    };

    assert.equal(isRetiredRemoteOnlyTrack(localWithStaleTidal), false);
    assert.equal(isTrackActionable(localWithStaleTidal), true);
    assert.equal(isRetiredRemoteOnlyTrack(youtubeWithStaleTidal), false);
    assert.equal(isTrackActionable(youtubeWithStaleTidal), true);
    assert.deepEqual(toTrackRef(youtubeWithStaleTidal), {
        youtubeVideoId: "active-video",
    });
    assert.equal(
        resolvePreferenceTrackId(youtubeWithStaleTidal),
        "yt:active-video",
    );
    assert.equal(
        resolvePreferenceTrackId({
            id: "tidal:991",
            streamSource: "tidal",
            tidalTrackId: 991,
        }),
        "tidal:991",
        "historical preference identity remains available for unlike/clear",
    );
});

test("provider authority follows provider, canonical media, stream, source, then id prefix", () => {
    const cases = [
        {
            input: {
                id: "yt:prefixed-video",
                provider: {
                    source: "tidal" as const,
                    tidalTrackId: 991,
                },
                mediaSource: "youtube" as const,
                streamSource: "youtube" as const,
                source: "youtube" as const,
                youtubeVideoId: "source-video",
            },
            expected: { tidalTrackId: 991 },
            actionable: false,
        },
        {
            input: {
                id: "yt:prefixed-video",
                mediaSource: "tidal" as const,
                streamSource: "youtube" as const,
                source: "youtube" as const,
                tidalTrackId: 992,
                youtubeVideoId: "source-video",
            },
            expected: { tidalTrackId: 992 },
            actionable: false,
        },
        {
            input: {
                id: "yt:prefixed-video",
                streamSource: "tidal" as const,
                source: "youtube" as const,
                tidalTrackId: 993,
                youtubeVideoId: "source-video",
            },
            expected: { tidalTrackId: 993 },
            actionable: false,
        },
        {
            input: {
                id: "tidal:994",
                source: "youtube" as const,
                youtubeVideoId: "source-video",
            },
            expected: { youtubeVideoId: "source-video" },
            actionable: true,
        },
        {
            input: { id: "tidal:995" },
            expected: { tidalTrackId: 995 },
            actionable: false,
        },
    ];

    for (const { input, expected, actionable } of cases) {
        assert.deepEqual(toTrackRef(input), expected);
        assert.equal(isTrackActionable(input), actionable);
    }
});

test("canonical-only retired TIDAL is fenced while canonical local backing wins stale fields", () => {
    const canonicalTidal = {
        id: "canonical-tidal-row",
        mediaSource: "tidal" as const,
        tidalTrackId: 991,
    };
    const canonicalLocal = {
        id: "canonical-local-row",
        mediaSource: "local" as const,
        tidalTrackId: 992,
    };

    assert.equal(isRetiredRemoteOnlyTrack(canonicalTidal), true);
    assert.equal(isTrackActionable(canonicalTidal), false);
    assert.equal(isRemoteTrack(canonicalTidal), true);
    assert.throws(() => toAddToPlaylistRef(canonicalTidal), /retired tidal/i);
    assert.equal(isRetiredRemoteOnlyTrack(canonicalLocal), false);
    assert.deepEqual(toTrackRef(canonicalLocal), {
        trackId: "canonical-local-row",
    });
});

test("toTrackRef returns local ref for local tracks", () => {
    const ref = toTrackRef({
        id: "local-track-1",
        streamSource: "local",
    });

    assert.deepEqual(ref, {
        trackId: "local-track-1",
    });
});

test("toTrackRef respects explicit local source even when id has remote prefix", () => {
    const ref = toTrackRef({
        id: "yt:video-local-shadow",
        streamSource: "local",
    });

    assert.deepEqual(ref, {
        trackId: "yt:video-local-shadow",
    });
});

test("toTrackRef returns tidal ref when tidal identifiers are present", () => {
    const ref = toTrackRef({
        id: "local-shadow-id",
        streamSource: "tidal",
        tidalTrackId: 123456,
    });

    assert.deepEqual(ref, {
        tidalTrackId: 123456,
    });
});

test("toTrackRef respects explicit tidal source when both remote ids are present", () => {
    const ref = toTrackRef({
        id: "local-shadow-id",
        streamSource: "tidal",
        tidalTrackId: 456789,
        youtubeVideoId: "yt-shadow",
    });

    assert.deepEqual(ref, {
        tidalTrackId: 456789,
    });
});

test("toTrackRef returns youtube ref when youtube identifiers are present", () => {
    const ref = toTrackRef({
        id: "yt:video-123",
        streamSource: "youtube",
        youtubeVideoId: "video-123",
    });

    assert.deepEqual(ref, {
        youtubeVideoId: "video-123",
    });
});

test("toTrackRef infers youtube ref from yt: prefixed ids", () => {
    const ref = toTrackRef({
        id: "yt:dQw4w9WgXcQ",
    });

    assert.deepEqual(ref, {
        youtubeVideoId: "dQw4w9WgXcQ",
    });
});

test("toTrackRef infers tidal ref from tidal: prefixed ids", () => {
    const ref = toTrackRef({
        id: "tidal:987654",
    });

    assert.deepEqual(ref, {
        tidalTrackId: 987654,
    });
});

test("toTrackRef infers local ref from plain non-prefixed ids", () => {
    const ref = toTrackRef({
        id: "plain-local-track-id",
    });

    assert.deepEqual(ref, {
        trackId: "plain-local-track-id",
    });
});

test("toTrackRef accepts explicit remote id when prefixed id is malformed", () => {
    const ytRef = toTrackRef({
        id: "yt:",
        youtubeVideoId: "video-explicit",
    });
    assert.deepEqual(ytRef, {
        youtubeVideoId: "video-explicit",
    });

    const tidalRef = toTrackRef({
        id: "tidal:invalid",
        tidalTrackId: 12345,
    });
    assert.deepEqual(tidalRef, {
        tidalTrackId: 12345,
    });
});

test("toTrackRef rejects malformed remote-prefixed ids", () => {
    assert.throws(() => toTrackRef({ id: "yt:" }));
    assert.throws(() => toTrackRef({ id: "tidal:abc" }));
});

test("toAddToPlaylistRef maps local refs to playlist body", () => {
    const payload: AddToPlaylistRef = toAddToPlaylistRef({
        id: "local-track-99",
    });
    assert.deepEqual(payload, { trackId: "local-track-99" });
});

test("toAddToPlaylistRef keeps a real local file local despite stale TIDAL metadata", () => {
    const payload = toAddToPlaylistRef({
        id: "local-track-with-stale-provider",
        filePath: "/music/local.flac",
        streamSource: "tidal",
        tidalTrackId: 991,
    });

    assert.deepEqual(payload, { trackId: "local-track-with-stale-provider" });
});

test("toAddToPlaylistRef rejects retired TIDAL writes", () => {
    assert.throws(
        () =>
            toAddToPlaylistRef({
                id: "tidal:777",
                streamSource: "tidal",
                tidalTrackId: "777",
                title: "Remote TIDAL Track",
                artist: { name: "Remote Artist" },
                album: { title: "Remote Album" },
                duration: 245,
                isrc: "US-R1L-99-12345",
            }),
        /retired tidal/i,
    );
});

test("toAddToPlaylistRef rejects non-integer tidal ids", () => {
    assert.throws(() =>
        toAddToPlaylistRef({
            streamSource: "tidal",
            tidalTrackId: "777.5",
        }),
    );
});

test("toAddToPlaylistRef maps youtube refs to playlist body", () => {
    const payload: AddToPlaylistRef = toAddToPlaylistRef({
        id: "yt:video-abc",
        streamSource: "youtube",
        youtubeVideoId: "video-abc",
        title: "Remote YouTube Track",
        artist: { name: "Remote Artist" },
        album: { title: "Remote Album" },
        duration: 301,
        thumbnailUrl: "https://img.youtube.com/video-abc.jpg",
    });
    assert.deepEqual(payload, {
        youtubeVideoId: "video-abc",
        title: "Remote YouTube Track",
        artist: "Remote Artist",
        album: "Remote Album",
        duration: 301,
        thumbnailUrl: "https://img.youtube.com/video-abc.jpg",
    });
});

test("toAddToPlaylistRef supports string artist/album metadata", () => {
    const payload: AddToPlaylistRef = toAddToPlaylistRef({
        id: "yt:video-fallback",
        streamSource: "youtube",
        youtubeVideoId: "video-fallback",
        title: "Fallback Metadata Track",
        artist: "Fallback Artist",
        album: "Fallback Album",
        duration: 188,
    });

    assert.deepEqual(payload, {
        youtubeVideoId: "video-fallback",
        title: "Fallback Metadata Track",
        artist: "Fallback Artist",
        album: "Fallback Album",
        duration: 188,
    });
});

test("toAddToPlaylistRef rejects remote refs missing required metadata", () => {
    assert.throws(() =>
        toAddToPlaylistRef({
            id: "yt:video-no-meta",
            streamSource: "youtube",
            youtubeVideoId: "video-no-meta",
            title: "Missing Artist",
            album: { title: "Album" },
            duration: 210,
        }),
    );

    // Missing duration defaults to 0 instead of throwing
    const noDuration = toAddToPlaylistRef({
        id: "yt:video-no-duration",
        streamSource: "youtube",
        youtubeVideoId: "video-no-duration",
        title: "Missing Duration",
        artist: { name: "Artist" },
        album: { title: "Album" },
    });
    assert.ok("duration" in noDuration);
    assert.equal(noDuration.duration, 0);

    // Missing album defaults to "Single" instead of throwing
    const noAlbum = toAddToPlaylistRef({
        id: "yt:video-no-album",
        streamSource: "youtube",
        youtubeVideoId: "video-no-album",
        title: "No Album Track",
        artist: { name: "Artist" },
        duration: 180,
    });
    assert.ok("album" in noAlbum);
    assert.equal(noAlbum.album, "Single");
});

test("isRemoteTrack detects local and remote tracks across input shapes", () => {
    assert.equal(isRemoteTrack({ id: "local-track-1" }), false);
    assert.equal(isRemoteTrack({ trackId: "local-track-1" }), false);
    assert.equal(isRemoteTrack({ youtubeVideoId: "video-abc" }), true);
    assert.equal(isRemoteTrack({ tidalTrackId: 42 }), true);
    assert.equal(isRemoteTrack({ id: "yt:video-abc" }), true);
    assert.equal(
        isRemoteTrack({ streamSource: "tidal", tidalTrackId: 42 }),
        true,
    );
    assert.equal(
        isRemoteTrack({ id: "yt:video-abc", streamSource: "local" }),
        false,
    );
    assert.equal(isRemoteTrack({ id: "tidal:abc" }), true);
});
