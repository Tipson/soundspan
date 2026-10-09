import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Track } from "../../lib/audio-state-context";
import { toMusicSourcePlaybackTrack } from "../../lib/audio/musicSourcePlayback";

let history: Array<{
    id: string;
    playedAt: string;
    track: Track;
}> = [];
const queues: Array<{ tracks: Track[]; index: number }> = [];
const playTracks = (tracks: Track[], index: number) =>
    queues.push({ tracks, index });
const router = { push() {} };
const Wrapper = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
const Icon = () => null;
const trackLists: Array<{
    items: typeof history;
    onPlay(entry: (typeof history)[number], index: number): void;
    rowOverflow(entry: (typeof history)[number]): { track: Track };
}> = [];
let readHistory = async () => history;
mock.module("next/navigation", { namedExports: { useRouter: () => router } });
mock.module("lucide-react", {
    namedExports: { AlertCircle: Icon, History: Icon, ListMusic: Icon },
});
mock.module("@/components/ui/Button", { namedExports: { Button: Wrapper } });
mock.module("@/components/ui/EmptyState", {
    namedExports: {
        EmptyState: ({ title }: { title: string }) =>
            React.createElement("p", null, title),
    },
});
mock.module("@/components/ui/LoadingScreen", {
    namedExports: {
        LoadingScreen: ({ message }: { message: string }) =>
            React.createElement("p", null, message),
    },
});
mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: Icon },
});
mock.module("@/components/layout/PageHeader", {
    namedExports: {
        PageHeader: ({
            title,
            subtitle,
        }: {
            title: string;
            subtitle: string;
        }) => React.createElement("header", null, title, subtitle),
    },
});
mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ isAuthenticated: true }) },
});
mock.module("@/lib/audio-controls-context", {
    namedExports: { useAudioControls: () => ({ playTracks }) },
});
mock.module("@/lib/toast-context", {
    namedExports: { useToast: () => ({ toast: { success() {} } }) },
});
mock.module("@/components/track", {
    namedExports: {
        TrackList: (props: (typeof trackLists)[number]) => {
            trackLists.push(props);
            return React.createElement(
                "div",
                null,
                props.items.map((entry) =>
                    React.createElement(
                        "button",
                        {
                            key: entry.id,
                            onClick: () =>
                                props.onPlay(entry, props.items.indexOf(entry)),
                        },
                        String(entry.track.title),
                    ),
                ),
            );
        },
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            get: () => readHistory(),
            getBrowseImageUrl: (value: string) => value,
            getCoverArtUrl: (value: string) => value,
        },
    },
});
before(() => {
    GlobalRegistrator.register();
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => GlobalRegistrator.unregister());

for (const provider of ["vk", "yandex"] as const) {
    test(`${provider} history page replays the exact recording and keeps selected occurrence`, async () => {
        const { default: Page } = await import("../../app/my-history/page");
        const { createRoot } = await import("react-dom/client");
        const first = toMusicSourcePlaybackTrack({
            provider,
            id: provider === "vk" ? "-12_34" : "123",
            title: "Song",
            artists: ["First", "Second"],
            duration: 180.5,
            contentVersion: "clean",
            preview: false,
        });
        const second = {
            ...first,
            musicSourceRecording: {
                ...first.musicSourceRecording!,
                contentVersion: "explicit" as const,
            },
        };
        history = [first, second].map((track, index) => ({
            id: `play-${index}`,
            playedAt: new Date().toISOString(),
            track,
        }));
        queues.length = 0;
        trackLists.length = 0;
        const container = document.createElement("div");
        const root = createRoot(container);
        try {
            await React.act(async () => {
                root.render(React.createElement(Page));
                await new Promise<void>((done) => setImmediate(done));
            });
            assert.match(container.textContent ?? "", /История прослушиваний/);
            assert.match(container.textContent ?? "", /Недавно слушали \(2\)/);
            assert.ok(
                container.querySelector('[data-consumer-surface="history"]'),
            );
            await React.act(async () =>
                (
                    container.querySelectorAll("button")[1] as HTMLButtonElement
                ).click(),
            );
            assert.equal(queues.length, 1);
            assert.equal(queues[0].index, 1);
            assert.equal(queues[0].tracks.length, 2);
            assert.deepEqual(
                queues[0].tracks[1].musicSourceRecording,
                second.musicSourceRecording,
            );
            assert.equal(
                queues[0].tracks[1].provider?.providerTrackId,
                first.musicSourceRecording!.id,
            );
            assert.equal(queues[0].tracks[1].streamSource, provider);
            assert.deepEqual(
                trackLists.at(-1)!.rowOverflow(history[1]).track
                    .musicSourceRecording,
                second.musicSourceRecording,
            );
        } finally {
            await React.act(async () => root.unmount());
            container.remove();
        }
    });
}

test("history route renders Russian loading and empty states from actual request timing", async () => {
    const { default: Page } = await import("../../app/my-history/page");
    const { createRoot } = await import("react-dom/client");
    let resolve: (entries: typeof history) => void = () => {};
    const pending = new Promise<typeof history>((done) => {
        resolve = done;
    });
    readHistory = () => pending;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
        await React.act(async () => root.render(React.createElement(Page)));
        assert.match(container.textContent ?? "", /Загружаем историю/);
        await React.act(async () => resolve([]));
        assert.match(container.textContent ?? "", /История пока пуста/);
        assert.ok(container.querySelector('[data-consumer-state="empty"]'));
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
        readHistory = async () => history;
    }
});
