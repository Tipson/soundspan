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

test("playlist detail action dock keeps secondary actions in one touch-friendly menu at every width", async () => {
    const { PlaylistDetailActionDock } =
        await import("@/features/playlist/components/PlaylistDetailActionDock");
    const html = renderToStaticMarkup(
        React.createElement(PlaylistDetailActionDock, createDockProps()),
    );

    assert.match(html, /data-music-detail="actions"/);
    assert.match(html, /data-detail-action-tier="primary"/);
    assert.match(html, /data-detail-action-tier="secondary"/);
    assert.match(html, /data-playlist-actions-overflow/);
    assert.match(html, /aria-label="Ещё действия с плейлистом"/);
    const overflowTrigger = html.match(
        /<button[^>]*data-playlist-actions-overflow[^>]*class="([^"]*)"[^>]*>/,
    );
    const secondaryActions = html.match(
        /<div[^>]*id="playlist-secondary-actions"[^>]*class="([^"]*)"[^>]*>/,
    );
    assert.ok(overflowTrigger);
    assert.ok(secondaryActions);
    assert.match(overflowTrigger[1], /\bh-11\b/);
    assert.match(overflowTrigger[1], /\bw-11\b/);
    assert.doesNotMatch(overflowTrigger[1], /sm:hidden/);
    assert.match(secondaryActions[1], /\bhidden\b/);
    assert.doesNotMatch(secondaryActions[1], /sm:flex/);
    assert.match(secondaryActions[1], /max-h-/);
    assert.match(secondaryActions[1], /overflow-y-auto/);
    assert.match(secondaryActions[1], /overscroll-contain/);
    assert.match(html, /data-radio-actions="true"/);
    assert.match(html, /aria-label="Воспроизвести всё"/);
    assert.match(html, /data-playlist-primary-label="compact"[^>]*>Слушать</);
    assert.match(
        html,
        /data-playlist-primary-label="full"[^>]*>Воспроизвести всё</,
    );

    for (const match of html.matchAll(/<button[^>]*>/g)) {
        assert.match(match[0], /(h-11 w-11|min-h-11)/);
    }
});

test("playlist detail overflow remains operable and closes after a secondary action", async () => {
    const { PlaylistDetailActionDock } =
        await import("@/features/playlist/components/PlaylistDetailActionDock");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const modalFocusTarget = document.createElement("button");
    document.body.appendChild(container);
    document.body.appendChild(modalFocusTarget);
    const root = createRoot(container);
    let addAllCalls = 0;

    await React.act(async () => {
        root.render(
            React.createElement(
                PlaylistDetailActionDock,
                createDockProps({
                    onAddAllToQueue: () => {
                        addAllCalls += 1;
                    },
                    onOpenShare: () => modalFocusTarget.focus(),
                }),
            ),
        );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
        "[data-playlist-actions-overflow]",
    );
    const secondaryActions = container.querySelector<HTMLElement>(
        "#playlist-secondary-actions",
    );
    assert.ok(trigger);
    assert.ok(secondaryActions);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.match(secondaryActions.className, /\bhidden\b/);

    await React.act(async () => trigger.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.match(secondaryActions.className, /\bflex\b/);
    assert.doesNotMatch(secondaryActions.className, /\bhidden\b/);

    const addAll = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Добавить всё в очередь"]',
    );
    assert.ok(addAll);
    await React.act(async () => addAll.click());
    assert.equal(addAllCalls, 1);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.match(secondaryActions.className, /\bhidden\b/);

    await React.act(async () => trigger.click());
    addAll.focus();
    assert.equal(document.activeElement, addAll);
    await React.act(async () => {
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, trigger);

    await React.act(async () => trigger.click());
    const share = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Создать ссылку для доступа"]',
    );
    assert.ok(share);
    await React.act(async () => share.click());
    assert.equal(document.activeElement, modalFocusTarget);

    await React.act(async () => root.unmount());
    container.remove();
    modalFocusTarget.remove();
});
