import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

GlobalRegistrator.register({
    url: "https://soundspan.test/playlist/playlist-1",
});
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => GlobalRegistrator.unregister());

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        X: Icon,
        Eye: Icon,
        EyeOff: Icon,
        Globe: Icon,
        GlobeLock: Icon,
        Heart: Icon,
        Ellipsis: Icon,
        ListMusic: Icon,
        Loader2: Icon,
        Pause: Icon,
        Play: Icon,
        Radio: Icon,
        Share2: Icon,
        Shuffle: Icon,
        Trash2: Icon,
    },
});

mock.module(
    "@/features/device-offline/components/DeviceCollectionDownloadButton",
    {
        namedExports: {
            DeviceCollectionDownloadButton: () =>
                React.createElement(
                    "button",
                    { className: "min-h-11" },
                    "download",
                ),
        },
    },
);

function createDockProps({
    onAddAllToQueue = () => undefined,
    onOpenShare = () => undefined,
}: {
    onAddAllToQueue?: () => void;
    onOpenShare?: () => void;
} = {}) {
    return {
        playlistId: "playlist-1",
        playlistName: "Редакционная подборка",
        trackItemCount: 2,
        playableTracks: [
            {
                id: "track-1",
                title: "Первый трек",
                artist: { name: "Исполнитель" },
                album: { title: "Альбом" },
                duration: 180,
            },
            {
                id: "track-2",
                title: "Второй трек",
                artist: { name: "Исполнитель" },
                album: { title: "Альбом" },
                duration: 190,
            },
        ],
        isThisPlaylistPlaying: false,
        isPlaying: false,
        showPlaySpinner: false,
        isAllLiked: false,
        isApplyingLikeAll: false,
        isOwner: true,
        isPublic: false,
        isHidden: false,
        isTogglingShare: false,
        isHiding: false,
        radioActions: React.createElement("span", {
            "data-radio-actions": true,
        }),
        onPlay: () => undefined,
        onShuffle: () => undefined,
        onAddAllToQueue,
        onToggleLikeAll: () => undefined,
        onStartRadio: () => undefined,
        onToggleShare: () => undefined,
        onOpenShare,
        onToggleHide: () => undefined,
        onDelete: () => undefined,
    };
}

test("playlist toolbar is compact and mounts secondary controls outside its hero", async () => {
    const { PlaylistDetailActionDock } =
        await import("@/features/playlist/components/PlaylistDetailActionDock");
    const html = renderToStaticMarkup(
        React.createElement(PlaylistDetailActionDock, createDockProps()),
    );
    assert.equal([...html.matchAll(/<button\b/g)].length, 3);
    assert.doesNotMatch(html, /data-detail-action-tier="secondary"/);
});

test("playlist sheet preserves callbacks, ownership and focus when opening another dialog", async () => {
    const { PlaylistDetailActionDock } =
        await import("@/features/playlist/components/PlaylistDetailActionDock");
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    const target = document.createElement("button");
    document.body.append(host, target);
    const root = createRoot(host);
    let calls = 0;
    await React.act(async () =>
        root.render(
            React.createElement(
                PlaylistDetailActionDock,
                createDockProps({
                    onAddAllToQueue: () => {
                        calls++;
                    },
                    onOpenShare: () => target.focus(),
                }),
            ),
        ),
    );
    const trigger = host.querySelector<HTMLButtonElement>(
        '[aria-label="Ещё действия"]',
    );
    assert.ok(trigger);
    await React.act(async () => {
        trigger.focus();
        trigger.click();
    });
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(host.contains(dialog), false);
    const add = dialog.querySelector<HTMLButtonElement>(
        '[aria-label="Добавить всё в очередь"]',
    );
    assert.ok(add);
    await React.act(async () => add.click());
    assert.equal(calls, 1);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await React.act(async () => trigger.click());
    const share = document.querySelector<HTMLButtonElement>(
        '[aria-label="Создать ссылку для доступа"]',
    );
    assert.ok(share);
    await React.act(async () => share.click());
    assert.ok(
        document.activeElement === target,
        "closing actions must not steal focus from the opened dialog",
    );
    await React.act(async () =>
        root.render(
            React.createElement(PlaylistDetailActionDock, {
                ...createDockProps(),
                isOwner: false,
            }),
        ),
    );
    await React.act(async () => trigger.click());
    assert.equal(
        document.querySelector('[aria-label="Создать ссылку для доступа"]'),
        null,
    );
    assert.equal(
        document.querySelector('[aria-label="Удалить плейлист"]'),
        null,
    );
    await React.act(async () => root.unmount());
    host.remove();
    target.remove();
});
