import assert from "node:assert/strict";
import test from "node:test";
import { WithLibrary } from "../../lib/api/library";
import { ApiClientCore } from "../../lib/api/core";

class RecordingCore extends ApiClientCore {
    public readonly endpoints: string[] = [];

    override async request<T>(endpoint: string): Promise<T> {
        this.endpoints.push(endpoint);
        return {} as T;
    }
}

class LibraryClient extends WithLibrary(RecordingCore) {}

test("artist tracks API encodes identity and pagination", async () => {
    const client = new LibraryClient();

    await client.getArtistTracks("AC/DC", { limit: 100, offset: 200 });

    assert.deepEqual(client.endpoints, [
        "/library/artists/AC%2FDC/tracks?limit=100&offset=200",
    ]);
});
