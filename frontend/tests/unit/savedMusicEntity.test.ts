import assert from "node:assert/strict";
import test from "node:test";
import { getSavedMusicEntityHref } from "../../features/library/savedMusicEntity";

test("saved provider and Soundspan identities reopen on their canonical pages", () => {
    assert.equal(
        getSavedMusicEntityHref({
            entityType: "album",
            source: "ytmusic",
            entityId: "MPREb_example",
            title: "Meteora",
        }),
        "/explore/yt-playlist/MPREb_example?type=album",
    );
    assert.equal(
        getSavedMusicEntityHref({
            entityType: "artist",
            source: "ytmusic",
            entityId: "UC_linkin_park",
            title: "Linkin Park",
        }),
        "/artist/Linkin%20Park?provider=ytmusic&channelId=UC_linkin_park",
    );
    assert.equal(
        getSavedMusicEntityHref({
            entityType: "album",
            source: "library",
            entityId: "album/local id",
            title: "Local album",
        }),
        "/album/album%2Flocal%20id",
    );
});
