import assert from "node:assert/strict";
import test from "node:test";
import { legacyPlaylistsRedirectTarget } from "../../features/playlist/legacyPlaylistsRedirect";

test("legacy playlists route redirects to the canonical Library tab", () => {
    assert.equal(
        legacyPlaylistsRedirectTarget(undefined),
        "/library?tab=playlists",
    );
    assert.equal(
        legacyPlaylistsRedirectTarget("1"),
        "/library?tab=playlists&create=1",
    );
    assert.equal(
        legacyPlaylistsRedirectTarget(["1", "0"]),
        "/library?tab=playlists&create=1",
    );
    assert.equal(legacyPlaylistsRedirectTarget("0"), "/library?tab=playlists");
});
