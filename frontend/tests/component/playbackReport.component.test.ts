import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "https://soundspan.test" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
const reports: unknown[] = [];
mock.module("@/lib/audio-engine/audioPlaybackOrchestratorRuntime", {
    namedExports: {
        queueUserPlaybackReport: (input: unknown) => {
            reports.push(input);
            return "stored";
        },
    },
});
test("a reason sends current track evidence once with honest queued confirmation", async () => {
    const { PlaybackReport } =
        await import("../../components/player/PlaybackReport");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const track = { id: "yt:abc", title: "Song", artist: { name: "Artist" } };
    try {
        await act(async () =>
            root.render(React.createElement(PlaybackReport, { track })),
        );
        assert.equal(reports.length, 0);
        await act(async () =>
            host.querySelector<HTMLButtonElement>("button")!.click(),
        );
        assert.deepEqual(reports, [
            {
                reason: "wrong_version",
                reportTrackId: "yt:abc",
                reportTitle: "Song",
                reportArtist: "Artist",
            },
        ]);
        assert.match(host.textContent!, /очередь/);
        assert.equal(host.querySelectorAll("button:not([disabled])").length, 0);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
