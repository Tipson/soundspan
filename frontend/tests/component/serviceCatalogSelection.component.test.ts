import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Track } from "../../lib/audio-state-context";
import { mergeServiceCatalogResults } from "../../features/search/serviceCatalogMerge";
GlobalRegistrator.register({ url: "https://soundspan.test/search" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
const calls: Track[][] = [];
let together = false;
mock.module("@/lib/listen-together-session", {
    namedExports: { isListenTogetherActiveOrPending: () => together },
});
mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push() {} }) },
});
mock.module("@/lib/api", {
    namedExports: { api: { getCoverArtUrl: () => "" } },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (tracks: Track[]) => calls.push(tracks),
        }),
    },
});
mock.module("@/features/search/hooks/useSearchTrackMatches", {
    namedExports: {
        useSearchTrackMatches: () => ({
            matches: new Map(),
            isMatching: false,
        }),
    },
});
mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: { TrackOverflowMenu: () => null },
});
mock.module("@/components/ui/CachedImage", {
    namedExports: { CachedImage: () => null },
});
mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: () => null },
});

test("changing catalog choice does not start audio and keeps the chosen identity after refresh", async () => {
    const { DiscoverTracksList } =
        await import("../../features/search/components/DiscoverTracksList");
    const rows = mergeServiceCatalogResults(
        [
            {
                type: "track",
                id: "yt",
                name: "Song",
                artist: "Artist",
                duration: 180,
                streamSource: "youtube",
                youtubeVideoId: "abcdefghijk",
            },
        ],
        [
            {
                provider: "vk",
                id: "1_2",
                title: "Song",
                artists: ["Artist"],
                duration: 180,
                contentVersion: "explicit",
                preview: false,
            },
        ],
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () =>
            root.render(
                React.createElement(DiscoverTracksList, { tracks: rows }),
            ),
        );
        const play = () =>
            host.querySelector<HTMLElement>('[role="button"]')!.click();
        await act(async () => play());
        assert.equal(calls.at(-1)?.[0].id, "vk:1_2");
        const select = host.querySelector("select")!;
        await act(async () => {
            select.value = select.options[0].value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        assert.equal(calls.length, 1);
        await act(async () =>
            root.render(
                React.createElement(DiscoverTracksList, {
                    tracks: [
                        {
                            ...rows[0],
                            versions: [...rows[0].versions!].reverse(),
                        },
                    ],
                }),
            ),
        );
        await act(async () => play());
        assert.equal(calls.at(-1)?.[0].id, "yt:abcdefghijk");
        together = true;
        const sourceSelect = host.querySelector("select")!;
        await act(async () => {
            sourceSelect.value = "vk:1_2";
            sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
        });
        const before = calls.length;
        await act(async () => play());
        assert.equal(
            calls.length,
            before,
            "personal service audio must not enter a shared queue",
        );
        assert.match(host.textContent!, /личного прослушивания/);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
