import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type MockSocialUser = {
    id: string;
    username: string;
    displayName: string;
    isInListenTogetherGroup: boolean;
    listeningStatus: "playing" | "paused" | "idle";
    listeningTrack: {
        id: string;
        title: string;
        duration: number;
        artistName: string;
        artistId: string | null;
        albumTitle: string;
        albumId: string | null;
        coverArt: string | null;
    } | null;
    lastHeartbeatAt: string;
};

const state = {
    users: [] as MockSocialUser[],
    isLoading: false,
    error: null as Error | null,
};

const Icon = () => React.createElement("i");

mock.module("next/image", {
    defaultExport: ({ src, alt, ...rest }: { src: string; alt: string }) =>
        React.createElement("img", { src, alt, ...rest }),
});

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    }) => React.createElement("a", { href, ...rest }, children),
});

mock.module("@/hooks/useSocialPresence", {
    namedExports: {
        useSocialPresence: () => ({
            users: state.users,
            isLoading: state.isLoading,
            error: state.error,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (coverArt: string, size: number) =>
                `/api/cover/${coverArt}?size=${size}`,
        },
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("lucide-react", {
    namedExports: {
        Music2: Icon,
        Users: Icon,
        Radio: Icon,
    },
});

beforeEach(() => {
    state.users = [];
    state.isLoading = false;
    state.error = null;
});

test("renders unavailable state when initial fetch fails", async () => {
    state.error = new Error("network");

    const { SocialTab } = await import("../../components/activity/SocialTab");
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /Статус друзей недоступен/);
});

test("renders loading spinner when query is still loading and no users are present", async () => {
    state.isLoading = true;

    const { SocialTab } = await import("../../components/activity/SocialTab");
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /animate-spin/);
    assert.doesNotMatch(html, /Сейчас никого нет онлайн/);
});

test("renders empty state when there are no users and no request error", async () => {
    const { SocialTab } = await import("../../components/activity/SocialTab");
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /Сейчас никого нет онлайн/);
    assert.match(
        html,
        /Здесь появятся пользователи, которые делятся своим статусом/,
    );
});

test("keeps rendering social users when a refetch error occurs", async () => {
    state.users = [
        {
            id: "u-1",
            username: "listener",
            displayName: "Listener",
            isInListenTogetherGroup: false,
            listeningStatus: "idle",
            listeningTrack: null,
            lastHeartbeatAt: "2026-02-18T13:00:00.000Z",
        },
    ];
    state.error = new Error("transient");

    const { SocialTab } = await import("../../components/activity/SocialTab");
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /Listener/);
    assert.doesNotMatch(html, /Статус друзей недоступен/);
});

test("renders paused track details with cover art, listen-together badge, and plain text track metadata without ids", async () => {
    state.users = [
        {
            id: "u-1",
            username: "listener_user",
            displayName: "Listener",
            isInListenTogetherGroup: true,
            listeningStatus: "paused",
            listeningTrack: {
                id: "track-1",
                title: "Song One",
                duration: 180,
                artistName: "Artist One",
                artistId: null,
                albumTitle: "Album One",
                albumId: null,
                coverArt: "cover-1",
            },
            lastHeartbeatAt: "2026-02-18T13:00:00.000Z",
        },
    ];

    const { SocialTab } = await import("../../components/activity/SocialTab");
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /1 пользователь онлайн/);
    assert.match(html, /В реальном времени/);
    assert.match(html, /Пауза/);
    assert.match(html, /Участвует в совместном прослушивании/);
    assert.match(html, /src=\"\/api\/cover\/cover-1\?size=32\"/);
    assert.match(html, /@listener_user/);
    assert.match(html, />Song One</);
    assert.match(html, />Artist One</);
    assert.doesNotMatch(html, /href=\"\/album\//);
    assert.doesNotMatch(html, /href=\"\/artist\//);
});

test("renders playing state with song and artist links when ids are present", async () => {
    state.users = [
        {
            id: "u-1",
            username: "listener",
            displayName: "Listener",
            isInListenTogetherGroup: false,
            listeningStatus: "playing",
            listeningTrack: {
                id: "track-1",
                title: "Song One",
                duration: 180,
                artistName: "Artist One",
                artistId: "artist-1",
                albumTitle: "Album One",
                albumId: "album-1",
                coverArt: null,
            },
            lastHeartbeatAt: "2026-02-18T13:00:00.000Z",
        },
    ];

    const { SocialTab } = await import("../../components/activity/SocialTab");
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /Слушает/);
    assert.match(html, /href=\"\/album\/album-1\"/);
    assert.match(html, /href=\"\/artist\/artist-1\"/);
    assert.doesNotMatch(html, /Сейчас ничего не слушает/);
});

test("renders idle users as not currently playing", async () => {
    state.users = [
        {
            id: "u-1",
            username: "listener",
            displayName: "Listener",
            isInListenTogetherGroup: false,
            listeningStatus: "idle",
            listeningTrack: {
                id: "track-1",
                title: "Song One",
                duration: 180,
                artistName: "Artist One",
                artistId: "artist-1",
                albumTitle: "Album One",
                albumId: "album-1",
                coverArt: null,
            },
            lastHeartbeatAt: "2026-02-18T13:00:00.000Z",
        },
    ];

    const { SocialTab } = await import("../../components/activity/SocialTab");
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /Неактивен/);
    assert.match(html, /Сейчас ничего не слушает/);
    assert.doesNotMatch(html, /href=\"\/album\/album-1\"/);
    assert.doesNotMatch(html, /href=\"\/artist\/artist-1\"/);
});

test("formats last seen timestamps for now, minutes, hours, today, and invalid dates", async () => {
    const originalNow = Date.now;
    Date.now = () => Date.parse("2026-02-20T12:00:00.000Z");

    state.users = [
        {
            id: "u-now",
            username: "now",
            displayName: "Now",
            isInListenTogetherGroup: false,
            listeningStatus: "idle",
            listeningTrack: null,
            lastHeartbeatAt: "2026-02-20T11:59:40.000Z",
        },
        {
            id: "u-mins",
            username: "mins",
            displayName: "Mins",
            isInListenTogetherGroup: false,
            listeningStatus: "idle",
            listeningTrack: null,
            lastHeartbeatAt: "2026-02-20T11:55:00.000Z",
        },
        {
            id: "u-hours",
            username: "hours",
            displayName: "Hours",
            isInListenTogetherGroup: false,
            listeningStatus: "idle",
            listeningTrack: null,
            lastHeartbeatAt: "2026-02-20T10:00:00.000Z",
        },
        {
            id: "u-today",
            username: "today",
            displayName: "Today",
            isInListenTogetherGroup: false,
            listeningStatus: "idle",
            listeningTrack: null,
            lastHeartbeatAt: "2026-02-19T12:00:00.000Z",
        },
        {
            id: "u-invalid",
            username: "invalid",
            displayName: "Invalid",
            isInListenTogetherGroup: false,
            listeningStatus: "idle",
            listeningTrack: null,
            lastHeartbeatAt: "not-a-date",
        },
    ];

    try {
        const { SocialTab } =
            await import("../../components/activity/SocialTab");
        const html = renderToStaticMarkup(React.createElement(SocialTab));

        assert.match(html, />только что</);
        assert.match(html, />5 мин назад</);
        assert.match(html, />2 ч назад</);
        assert.match(html, />19 февр/);
        assert.match(html, />недавно</);
    } finally {
        Date.now = originalNow;
    }
});
