import assert from "node:assert/strict";
import test from "node:test";
import { WithLibrary } from "../../lib/api/library";
import { ApiClientCore } from "../../lib/api/core";

interface RecordedCall {
    endpoint: string;
    method: string | undefined;
    body: string | undefined;
    signal?: AbortSignal | null;
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
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return {} as T;
    }
}

class LibraryClient extends WithLibrary(RecordingCore) {}

test("saved collection search sends the literal query and cancellation through the API boundary", async () => {
    const client = new LibraryClient();
    const controller = new AbortController();
    const q = "Кино 100% _ \\";
    await client.listSavedMusicEntities(
        { type: "artist", limit: 50, offset: 50, q },
        controller.signal,
    );
    const url = new URL(client.calls[0].endpoint, "https://fixture.test");
    assert.equal(url.pathname, "/library/saved");
    assert.equal(url.searchParams.get("q"), q);
    assert.equal(url.searchParams.get("type"), "artist");
    assert.equal(client.calls[0].signal, controller.signal);
});

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
