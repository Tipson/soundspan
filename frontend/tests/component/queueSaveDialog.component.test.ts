import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const calls: Array<{ kind: string; value: unknown }> = [];
const tracks = [
    {
        id: "track-one",
        title: "Первый трек",
        duration: 180,
        artist: { name: "Артист" },
        album: { title: "Альбом", coverArt: null },
    },
    {
        id: "track-two",
        title: "Второй трек",
        duration: 180,
        artist: { name: "Артист" },
        album: { title: "Альбом", coverArt: null },
    },
];
mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: (value: string) => calls.push({ kind: "route", value }),
        }),
    },
});
mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ isAuthenticated: true }) },
});
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            queue: tracks,
            currentTrack: tracks[0],
            currentIndex: 0,
        }),
        useAudioControls: () => ({
            playQueueIndex() {},
            removeFromQueue() {},
            clearQueue() {},
            moveQueueItem() {},
        }),
    },
});
mock.module("@/lib/listen-together-context", {
    namedExports: {
        useListenTogether: () => ({
            isInGroup: false,
            isHost: false,
            trackAvailability: new Map(),
        }),
    },
});
mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({ toast: { success() {}, error() {}, info() {} } }),
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (value: string) => value,
            createPlaylist: async (name: string) => {
                calls.push({ kind: "create", value: name });
                return { id: "saved-playlist" };
            },
            addTrackToPlaylist: async (id: string, reference: unknown) => {
                calls.push({ kind: "add", value: { id, reference } });
            },
        },
    },
});
mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: { TrackPreferenceButtons: () => null },
});
mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: () => null,
        TrackMenuButton: () => null,
    },
});
mock.module("@/components/ui/CachedImage", {
    namedExports: { CachedImage: () => null },
});
mock.module("react-virtuoso", { namedExports: { Virtuoso: () => null } });
after(() => GlobalRegistrator.unregister());

async function mount() {
    calls.length = 0;
    const { createRoot } = await import("react-dom/client");
    const { default: QueuePage } = await import("../../app/queue/page");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(QueuePage)));
    const opener = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Сохранить как плейлист",
    );
    assert.ok(opener);
    opener.focus();
    await React.act(async () => opener.click());
    return {
        root,
        container,
        opener,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("Queue Save dialog traps focus, closes on Escape, and restores its opener", async () => {
    const mounted = await mount();
    try {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        assert.ok(dialog);
        assert.ok(dialog.contains(document.activeElement));
        const last = Array.from(dialog.querySelectorAll("button")).at(-1);
        assert.ok(last);
        last.focus();
        await React.act(async () =>
            last.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Tab",
                    bubbles: true,
                    cancelable: true,
                }),
            ),
        );
        assert.ok(dialog.contains(document.activeElement));
        await React.act(async () =>
            document.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape" }),
            ),
        );
        assert.equal(
            document.querySelector('[role="dialog"]') === null,
            true,
            "Escape closes the save dialog",
        );
        assert.equal(
            document.activeElement === mounted.opener,
            true,
            "focus returns to Save as Playlist",
        );
        assert.equal(calls.length, 0, "dismissal does not save a playlist");
    } finally {
        await mounted.unmount();
    }
});

test("Queue Save retains its name and saves both queued track references", async () => {
    const mounted = await mount();
    try {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        assert.ok(dialog);
        const field = dialog.querySelector<HTMLInputElement>("input");
        assert.ok(field);
        assert.ok(
            dialog.querySelector(`label[for="${field.id}"]`),
            "the playlist name has an associated label",
        );
        const valueSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
        )?.set;
        assert.ok(valueSetter);
        await React.act(async () => {
            valueSetter.call(field, "Моя очередь");
            field.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const save = Array.from(dialog.querySelectorAll("button")).find(
            (button) => button.textContent === "Сохранить",
        );
        assert.ok(save);
        await React.act(async () => save.click());
        assert.deepEqual(calls, [
            { kind: "create", value: "Моя очередь" },
            {
                kind: "add",
                value: {
                    id: "saved-playlist",
                    reference: { trackId: "track-one" },
                },
            },
            {
                kind: "add",
                value: {
                    id: "saved-playlist",
                    reference: { trackId: "track-two" },
                },
            },
            { kind: "route", value: "/playlist/saved-playlist" },
        ]);
        assert.equal(document.querySelector('[role="dialog"]') === null, true);
    } finally {
        await mounted.unmount();
    }
});
