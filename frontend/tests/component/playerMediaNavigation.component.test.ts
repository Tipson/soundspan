import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Track } from "../../lib/audio-state-context";

GlobalRegistrator.register();
const state = {
    currentTrack: null as Track | null,
    currentAudiobook: null,
    currentPodcast: null,
    playbackType: "track",
};
mock.module("@/lib/audio-context", {
    namedExports: { useAudioState: () => state },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (value: string) => `/cover/${value}`,
            getProfilePictureUrl: (id: string) =>
                `/api/social/profile-picture/${encodeURIComponent(id)}`,
        },
    },
});
mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ user: { id: "user/id", username: "Listener" } }),
    },
});
mock.module("@/lib/toast-context", {
    namedExports: { useToast: () => ({ toast: {} }) },
});
mock.module("@/hooks/useJobStatus", {
    namedExports: { useJobStatus: () => ({ isPolling: false }) },
});
mock.module("next/image", {
    defaultExport: ({ src, alt }: { src: string; alt: string }) =>
        React.createElement("img", { src, alt }),
});
after(() => GlobalRegistrator.unregister());

test("avatar menu supports keyboard navigation and returns focus on Escape", async () => {
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const { createRoot } = await import("react-dom/client");
    const { UserAvatarMenu } =
        await import("../../components/layout/UserAvatarMenu");
    const client = new QueryClient();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
        await React.act(async () =>
            root.render(
                React.createElement(
                    QueryClientProvider,
                    { client },
                    React.createElement(UserAvatarMenu),
                ),
            ),
        );
        const trigger = container.querySelector<HTMLButtonElement>(
            "button[aria-haspopup]",
        )!;
        await React.act(async () =>
            trigger.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "ArrowDown",
                    bubbles: true,
                }),
            ),
        );
        const items = [
            ...container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
        ];
        assert.ok(items.length >= 2, "menu opens with actionable items");
        assert.ok(
            document.activeElement === items[0],
            "first item receives focus",
        );
        await React.act(async () =>
            items[0].dispatchEvent(
                new KeyboardEvent("keydown", { key: "End", bubbles: true }),
            ),
        );
        assert.ok(
            document.activeElement === items.at(-1),
            "End moves to last item",
        );
        await React.act(async () =>
            items.at(-1)!.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Escape",
                    bubbles: true,
                }),
            ),
        );
        assert.equal(trigger.getAttribute("aria-expanded"), "false");
        assert.ok(
            document.activeElement === trigger,
            "Escape restores avatar focus",
        );
        await React.act(async () => trigger.click());
        await React.act(async () => trigger.focus());
        await React.act(async () => trigger.click());
        assert.equal(
            trigger.getAttribute("aria-expanded"),
            "false",
            "a second avatar click closes the menu after focus moves back to it",
        );
    } finally {
        await React.act(async () => root.unmount());
        client.clear();
        container.remove();
    }
});

async function links(track: Track) {
    state.currentTrack = track;
    const { useMediaInfo } = await import("../../hooks/useMediaInfo");
    let result: ReturnType<typeof useMediaInfo> | undefined;
    function Probe() {
        result = useMediaInfo();
        return null;
    }
    renderToStaticMarkup(React.createElement(Probe));
    assert.ok(result);
    return result;
}

const local: Track = {
    id: "local-track",
    title: "Track",
    duration: 180,
    artist: { id: "local-artist", name: "Artist", mbid: "a-mbid" },
    album: { id: "local-album", title: "Album" },
};

test("player retains exact library routes for local entities", async () => {
    const result = await links(local);
    assert.equal(result.artistLink, "/artist/local-artist");
    assert.equal(result.albumLink, "/album/local-album");
    assert.equal(result.mediaLink, result.albumLink);
});

test("player routes a YouTube channel and album through their provider pages", async () => {
    const result = await links({
        ...local,
        streamSource: "youtube",
        youtubeVideoId: "video",
        artist: { id: "UCmtzi13ZHv9f_4KRbJsaUJQ", name: "Linkin Park" },
        album: { id: "MPREb_qMlbe7gLeuH", title: "Meteora" },
    });
    assert.equal(
        result.artistLink,
        "/artist/Linkin%20Park?provider=ytmusic&channelId=UCmtzi13ZHv9f_4KRbJsaUJQ",
    );
    assert.equal(
        result.albumLink,
        "/explore/yt-playlist/MPREb_qMlbe7gLeuH?type=album",
    );
    assert.equal(result.mediaLink, result.albumLink);
});

test("provider routes work for restored tracks lacking streamSource", async () => {
    const result = await links({
        ...local,
        artist: { id: "UCmtzi13ZHv9f_4KRbJsaUJQ", name: "AC/DC & Friends" },
        album: { id: "MPREb_qMlbe7gLeuH", title: "Album" },
    });
    assert.equal(
        new URL(result.artistLink!, "https://soundspan.test").pathname,
        "/artist/AC%2FDC%20%26%20Friends",
    );
    assert.match(result.albumLink!, /^\/explore\/yt-playlist\//);
});

test("absent entity IDs do not produce dead player links", async () => {
    const result = await links({
        ...local,
        artist: { name: "Artist" },
        album: { title: "Album" },
    });
    assert.equal(result.artistLink, null);
    assert.equal(result.albumLink, null);
});

test("avatar cache revision is a query parameter, not part of the user ID", async () => {
    const { UserAvatarMenu } =
        await import("../../components/layout/UserAvatarMenu");
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            React.createElement(UserAvatarMenu),
        ),
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const url = new URL(
        container.querySelector("img")!.getAttribute("src")!,
        "https://soundspan.test",
    );
    assert.equal(url.pathname, "/api/social/profile-picture/user%2Fid");
    assert.equal(url.searchParams.get("_k"), "0");
});
