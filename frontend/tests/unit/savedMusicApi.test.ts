import assert from "node:assert/strict";
import test from "node:test";
import { WithLibrary } from "../../lib/api/library";
import { ApiClientCore } from "../../lib/api/core";

interface RecordedCall {
    endpoint: string;
    method: string | undefined;
    body: string | undefined;
}

class RecordingCore extends ApiClientCore {
    public readonly calls: RecordedCall[] = [];

    override async request<T>(
        endpoint: string,
        options: RequestInit = {},
    ): Promise<T> {
        this.calls.push({
            endpoint,
            method: options.method,
            body: typeof options.body === "string" ? options.body : undefined,
        });
        return {} as T;
    }
}

class LibraryClient extends WithLibrary(RecordingCore) {}

test("saved music API preserves provider identity across list, status, save, and remove", async () => {
    const client = new LibraryClient();
    const identity = {
        type: "album" as const,
        source: "ytmusic",
        entityId: "MPREb_example",
    };

    await client.listSavedMusicEntities({
        type: "album",
        limit: 40,
        offset: 2,
    });
    await client.getSavedMusicEntityStatus(identity);
    await client.saveMusicEntity({
        ...identity,
        title: "Meteora",
        subtitle: "Linkin Park",
        imageUrl: "https://example.test/cover.jpg",
    });
    await client.removeSavedMusicEntity(identity);

    assert.deepEqual(client.calls, [
        {
            endpoint: "/library/saved?type=album&limit=40&offset=2",
            method: undefined,
            body: undefined,
        },
        {
            endpoint:
                "/library/saved/status?type=album&source=ytmusic&entityId=MPREb_example",
            method: undefined,
            body: undefined,
        },
        {
            endpoint: "/library/saved",
            method: "PUT",
            body: JSON.stringify({
                ...identity,
                title: "Meteora",
                subtitle: "Linkin Park",
                imageUrl: "https://example.test/cover.jpg",
            }),
        },
        {
            endpoint: "/library/saved",
            method: "DELETE",
            body: JSON.stringify(identity),
        },
    ]);
});
