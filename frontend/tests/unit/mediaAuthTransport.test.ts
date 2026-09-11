import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ApiClientCore } from "../../lib/api/core";
import { WithAudiobooks } from "../../lib/api/audiobooks";
import { WithMedia } from "../../lib/api/media";
import { WithPodcasts } from "../../lib/api/podcasts";
import { WithSettings } from "../../lib/api/settings";
import { WithYouTube } from "../../lib/api/youtube";
import { WithYtMusic } from "../../lib/api/ytmusic";
import { readMediaAuthCookie } from "../../lib/media-auth";
import { AUTH_SESSION_CHANGE_KEY } from "../../lib/auth-offline-session";

GlobalRegistrator.register({ url: "https://soundspan.test/api/test" });

const MEDIA_AUTH_COOKIE_NAME = "soundspan_media_auth";
const ACCESS_TOKEN = "header.payload.signature";

class MediaClient extends WithMedia(ApiClientCore) {}
class SettingsClient extends WithSettings(ApiClientCore) {}
class AudioClient extends WithPodcasts(
    WithAudiobooks(WithYouTube(WithYtMusic(WithMedia(ApiClientCore)))),
) {}

function clearMediaAuthCookie(): void {
    document.cookie = `${MEDIA_AUTH_COOKIE_NAME}=; Path=/api; Max-Age=0; SameSite=Strict; Secure`;
}

beforeEach(() => {
    localStorage.clear();
    clearMediaAuthCookie();
});

after(async () => {
    clearMediaAuthCookie();
    await GlobalRegistrator.unregister();
});

test("access-token rotation mirrors only the current access token into the media cookie", () => {
    const client = new MediaClient("https://api.soundspan.test");

    client.setToken(ACCESS_TOKEN, "refresh-secret");
    assert.match(
        document.cookie,
        new RegExp(`${MEDIA_AUTH_COOKIE_NAME}=header\\.payload\\.signature`),
    );
    assert.doesNotMatch(document.cookie, /refresh-secret/);

    client.setToken("rotated.payload.signature", "refresh-rotated");
    assert.match(document.cookie, /rotated\.payload\.signature/);
    assert.doesNotMatch(document.cookie, /header\.payload\.signature/);

    client.clearToken();
    assert.equal(readMediaAuthCookie(document.cookie), null);
});

test("login and logout publish opaque cross-tab generations", () => {
    const client = new MediaClient("https://api.soundspan.test");

    client.setToken(ACCESS_TOKEN, "refresh-secret");
    const loginGeneration = localStorage.getItem(AUTH_SESSION_CHANGE_KEY);
    assert.ok(loginGeneration);
    assert.doesNotMatch(loginGeneration, /header|payload|signature|refresh/);

    client.clearToken();
    const logoutGeneration = localStorage.getItem(AUTH_SESSION_CHANGE_KEY);
    assert.ok(logoutGeneration);
    assert.notEqual(logoutGeneration, loginGeneration);
    assert.doesNotMatch(logoutGeneration, /header|payload|signature|refresh/);
});

test("a stored access token is mirrored into the media cookie when a browser session initializes", () => {
    localStorage.setItem("auth_token", ACCESS_TOKEN);

    const client = new MediaClient("https://api.soundspan.test");

    assert.equal(client.getToken(), ACCESS_TOKEN);
    assert.match(
        document.cookie,
        /soundspan_media_auth=header\.payload\.signature/,
    );
    client.clearToken();
});

test("cross-tab storage reload replaces and revokes an in-memory credential", () => {
    const client = new MediaClient("https://api.soundspan.test");
    client.setToken(ACCESS_TOKEN, "refresh-secret");

    localStorage.setItem("auth_token", "other-user.payload.signature");
    assert.equal(
        client.reloadTokenFromStorage(),
        "other-user.payload.signature",
    );
    assert.equal(client.getToken(), "other-user.payload.signature");
    assert.match(document.cookie, /other-user\.payload\.signature/);

    localStorage.removeItem("auth_token");
    localStorage.removeItem("refresh_token");
    assert.equal(client.reloadTokenFromStorage(), null);
    assert.equal(client.getToken(), null);
    assert.equal(readMediaAuthCookie(document.cookie), null);
});

test("cover-art and browse-image URLs stay same-origin and never embed the access token", () => {
    const client = new MediaClient("https://api.soundspan.test");
    client.setToken(ACCESS_TOKEN, "refresh-secret");

    const coverUrl = client.getCoverArtUrl(
        "https://images.example.test/cover.jpg",
        320,
    );
    const browseUrl = client.getBrowseImageUrl(
        "https://lh3.googleusercontent.com/cover.jpg",
    );

    assert.equal(coverUrl.startsWith("/api/library/cover-art?"), true);
    assert.equal(browseUrl.startsWith("/api/browse/ytmusic/image?"), true);
    assert.equal(
        new URL(coverUrl, window.location.origin).searchParams.has("token"),
        false,
    );
    assert.equal(
        new URL(browseUrl, window.location.origin).searchParams.has("token"),
        false,
    );
    assert.doesNotMatch(coverUrl, new RegExp(ACCESS_TOKEN));
    assert.doesNotMatch(browseUrl, new RegExp(ACCESS_TOKEN));
    client.clearToken();
});

test("cover-art URLs request the wide YouTube thumbnail without embedded letterbox bars", () => {
    const client = new MediaClient("https://api.soundspan.test");

    const coverUrl = client.getCoverArtUrl(
        "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        520,
    );
    const proxiedSource = new URL(
        coverUrl,
        window.location.origin,
    ).searchParams.get("url");

    assert.equal(
        proxiedSource,
        "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    );
});

test("profile-picture image URLs use the same clean authenticated proxy path", () => {
    const client = new SettingsClient("https://api.soundspan.test");
    client.setToken(ACCESS_TOKEN, "refresh-secret");

    const profileUrl = client.getProfilePictureUrl("user/with spaces");

    assert.equal(
        profileUrl,
        "/api/social/profile-picture/user%2Fwith%20spaces",
    );
    assert.doesNotMatch(profileUrl, new RegExp(ACCESS_TOKEN));
    client.clearToken();
});

test("all browser audio stream URLs stay same-origin and never embed access credentials", () => {
    const client = new AudioClient("https://api.soundspan.test");
    client.setToken(ACCESS_TOKEN, "refresh-secret");

    const urls = [
        client.getStreamUrl("track/with spaces"),
        client.getPreviewStreamUrl("preview/with spaces"),
        client.getYtMusicStreamUrl("yt/with spaces", "HIGH"),
        client.getYtMusicStreamUrl("public-video", "LOW", true),
        client.getYtMusicStreamUrl("preload-video", undefined, true, "preload"),
        client.getYouTubeStreamUrl("youtube/with spaces", "HIGH"),
        client.getAudiobookStreamUrl("book/with spaces"),
        client.getPodcastEpisodeStreamUrl(
            "podcast/with spaces",
            "episode/with spaces",
        ),
    ];

    for (const url of urls) {
        assert.equal(url.startsWith("/api/"), true, url);
        assert.equal(
            new URL(url, window.location.origin).searchParams.has("token"),
            false,
            url,
        );
        assert.doesNotMatch(url, new RegExp(ACCESS_TOKEN));
        assert.doesNotMatch(url, /refresh-secret/);
    }

    assert.equal(
        new URL(urls[2], window.location.origin).searchParams.get("quality"),
        "HIGH",
    );
    assert.equal(
        new URL(urls[4], window.location.origin).searchParams.get("purpose"),
        "preload",
    );
    client.clearToken();
});

test("public preload reuse is isolated by client and credential generation", () => {
    const client = new AudioClient();
    const getScope = (purpose: "interactive" | "preload" = "interactive") =>
        new URL(
            client.getYtMusicStreamUrl("dQw4w9WgXcQ", "HIGH", true, purpose),
            window.location.origin,
        ).searchParams.get("preloadSession");
    assert.equal(
        getScope(),
        null,
        "anonymous streams cannot reuse session bytes",
    );
    client.setToken(ACCESS_TOKEN);
    const initial = getScope();
    assert.match(initial ?? "", /^[0-9a-f-]{36}:\d+$/i);
    assert.equal(getScope("preload"), initial);
    assert.equal(getScope(), initial);
    const otherClient = new AudioClient();
    assert.notEqual(
        new URL(
            otherClient.getYtMusicStreamUrl("dQw4w9WgXcQ", "HIGH", true),
            window.location.origin,
        ).searchParams.get("preloadSession"),
        initial,
    );
    client.setToken("other-user.payload.signature");
    assert.notEqual(getScope(), initial);
    const rotated = getScope();
    client.reloadTokenFromStorage();
    assert.notEqual(getScope(), rotated);
    assert.equal(
        new URL(
            client.getYtMusicStreamUrl("dQw4w9WgXcQ"),
            window.location.origin,
        ).searchParams.has("preloadSession"),
        false,
    );
    client.clearToken();
    otherClient.clearToken();
    assert.equal(getScope(), null);
});

test("each audio load has a non-secret playback session for byte representation isolation", () => {
    const client = new AudioClient();
    const first = new URL(
        client.getYtMusicStreamUrl("jNQXAC9IVRw"),
        window.location.origin,
    );
    const second = new URL(
        client.getYtMusicStreamUrl("jNQXAC9IVRw"),
        window.location.origin,
    );
    assert.match(
        first.searchParams.get("playbackSession") ?? "",
        /^[0-9a-f-]{36}$/i,
    );
    assert.notEqual(
        first.searchParams.get("playbackSession"),
        second.searchParams.get("playbackSession"),
    );
});

test("credential updates revoke the controlling worker's completed preload bytes", () => {
    const original = Object.getOwnPropertyDescriptor(
        navigator,
        "serviceWorker",
    );
    const messages: unknown[] = [];
    Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
            controller: {
                postMessage: (message: unknown) => messages.push(message),
            },
        },
    });
    try {
        const client = new MediaClient();
        messages.length = 0;
        client.setToken(ACCESS_TOKEN);
        client.reloadTokenFromStorage();
        client.clearToken();
        assert.deepEqual(
            messages,
            Array.from({ length: 3 }, () => ({
                type: "CLEAR_STREAM_PRELOAD_CACHE",
            })),
        );
        assert.doesNotMatch(JSON.stringify(messages), /payload|signature/);
    } finally {
        if (original)
            Object.defineProperty(navigator, "serviceWorker", original);
        else Reflect.deleteProperty(navigator, "serviceWorker");
    }
});
