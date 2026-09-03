import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientCore } from "../../lib/api/core";
import { WithPlaylists } from "../../lib/api/playlists";

class RecordingCore extends ApiClientCore {
    public readonly endpoints: string[] = [];

    override async request<T>(endpoint: string): Promise<T> {
        this.endpoints.push(endpoint);
        return {} as T;
    }
}

class PlaylistsClient extends WithPlaylists(RecordingCore) {}

test("playlist pages send the opaque cursor and a bounded limit", async () => {
    const client = new PlaylistsClient();

    await client.getPlaylistPage("playlist/id", {
        limit: 100,
        cursor: "cursor+with/slashes=",
    });

    assert.deepEqual(client.endpoints, [
        "/playlists/playlist/id?limit=100&cursor=cursor%2Bwith%2Fslashes%3D",
    ]);
});
