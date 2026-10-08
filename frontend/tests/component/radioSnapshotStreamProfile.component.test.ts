import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { usePlaybackStateSync } from "../../components/player/hooks/usePlaybackStateSync";
import type { Track } from "../../lib/audio-state-context";
import type { PlaybackStreamProfile } from "../../lib/audio-playback-context";

before(() => {
    GlobalRegistrator.register();
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => GlobalRegistrator.unregister());

test("radio-only clones retain the loaded stream profile while real source changes reset it", async () => {
    const { createRoot } = await import("react-dom/client");
    let currentTrack: Track = {
        id: "same",
        title: "Local",
        duration: 180,
        artist: { name: "Artist" },
        album: { title: "Album" },
        filePath: "original.flac",
        source: "local",
        mediaSource: "local",
        radioOrigin: { kind: "artist", source: "library", id: "a" },
    };
    let writes = 0,
        clears = 0;
    const refs = {
        currentTrackRef: { current: currentTrack as Track | null },
        trackEndWatchdogRef: {
            current: {
                clear() {
                    clears += 1;
                },
            },
        },
        startupRecoveryAttemptedTrackIdRef: { current: "same" },
        transientTrackRecoveryTrackIdRef: { current: "same" },
        queueLengthRef: { current: 1 },
        playbackTypeRef: { current: "track" },
    };
    const recovery = {
        clearTransientTrackRecovery() {
            clears += 1;
        },
    };
    type Options = Parameters<typeof usePlaybackStateSync>[0];
    let profile: PlaybackStreamProfile | null = null;
    let setLoaded!: React.Dispatch<
        React.SetStateAction<PlaybackStreamProfile | null>
    >;
    function Probe() {
        const [value, setValue] = React.useState<PlaybackStreamProfile | null>(
            null,
        );
        profile = value;
        setLoaded = setValue;
        const setProfile = React.useCallback(
            (p: PlaybackStreamProfile | null) => {
                writes += 1;
                setValue(p);
            },
            [],
        );
        usePlaybackStateSync({
            refs: refs as unknown as Options["refs"],
            playbackRecoveryHelpers:
                recovery as Options["playbackRecoveryHelpers"],
            currentTrack,
            playbackType: "track",
            queueLength: 1,
            setStreamProfile: setProfile,
        });
        return null;
    }
    const root = createRoot(document.createElement("div"));
    const render = () =>
        React.act(async () => root.render(React.createElement(Probe)));
    try {
        await render();
        assert.equal(writes, 1, "initial profile still initializes");
        const loaded: PlaybackStreamProfile = {
            mode: "direct",
            sourceType: "local",
            codec: "flac",
            bitrateKbps: 900,
        };
        await React.act(async () => setLoaded(loaded));
        currentTrack = {
            ...currentTrack,
            radioOrigin: { kind: "artist", source: "discovery", name: "B" },
        };
        await render();
        assert.deepEqual(profile, loaded);
        assert.equal(writes, 1);
        assert.equal(refs.currentTrackRef.current, currentTrack);
        assert.equal(clears, 0);
        currentTrack = { ...currentTrack, filePath: "replacement.flac" };
        await render();
        assert.equal(
            writes,
            2,
            "same ID source path change retains its existing reset",
        );
        currentTrack = {
            ...currentTrack,
            source: "youtube",
            mediaSource: "youtube",
            youtubeVideoId: "BBBBBBBBBBB",
        };
        await render();
        assert.deepEqual(profile, {
            mode: "direct",
            sourceType: "ytmusic",
            codec: null,
            bitrateKbps: null,
        });
        assert.equal(writes, 3);
        currentTrack = { ...currentTrack, id: "other" };
        await render();
        assert.equal(writes, 4);
        assert.equal(clears, 2);
    } finally {
        await React.act(async () => root.unmount());
    }
});
