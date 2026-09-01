import assert from "node:assert/strict";
import test from "node:test";
import { shouldOpenCreatePlaylist } from "../../features/playlist/createPlaylistRoute";

test("playlist create deep link opens only for an explicit create request", () => {
    assert.equal(shouldOpenCreatePlaylist("1"), true);
    assert.equal(shouldOpenCreatePlaylist("true"), true);
    assert.equal(shouldOpenCreatePlaylist(null), false);
    assert.equal(shouldOpenCreatePlaylist("0"), false);
});
