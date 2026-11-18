import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClientCore, IMPORT_PREVIEW_TIMEOUT_MS } from "@/lib/api/core";
import { WithImports } from "@/lib/api/imports";

// Import previews resolve every playlist entry against the library before
// responding, so they can legitimately outlive the default request timeout.
// These tests pin the extended-timeout contract for both preview endpoints.

test("playlist preview client budget stays below the proxy budget", () => {
    assert.equal(IMPORT_PREVIEW_TIMEOUT_MS, 120_000);
});

interface RecordedCall {
    endpoint: string;
    timeoutMs: number | undefined;
}

class RecordingCore extends ApiClientCore {
    public readonly calls: RecordedCall[] = [];

    override async request<T>(
        endpoint: string,
        options: RequestInit & { timeoutMs?: number } = {},
    ): Promise<T> {
        this.calls.push({ endpoint, timeoutMs: options.timeoutMs });
        return {} as T;
    }
}

class ImportsClient extends WithImports(RecordingCore) {}

test("previewM3UImport uses the extended import-preview timeout", async () => {
    const client = new ImportsClient();
    await client.previewM3UImport("#EXTM3U\n/music/song.mp3", "My Mix");

    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].endpoint, "/import/m3u/preview");
    assert.equal(client.calls[0].timeoutMs, IMPORT_PREVIEW_TIMEOUT_MS);
});

test("previewPlaylistImport uses the extended import-preview timeout", async () => {
    const client = new ImportsClient();
    await client.previewPlaylistImport("https://example.com/playlist/123");

    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].endpoint, "/import/preview");
    assert.equal(client.calls[0].timeoutMs, IMPORT_PREVIEW_TIMEOUT_MS);
});

test("file draft API keeps revision/digest confirmation on the existing authenticated boundary", async () => {
    const calls: Array<{ endpoint: string; options: RequestInit }> = [];
    class DraftCore extends ApiClientCore {
        override async request<T>(
            endpoint: string,
            options: RequestInit = {},
        ): Promise<T> {
            calls.push({ endpoint, options });
            return { job: { id: "draft-1" } } as T;
        }
    }
    const client = new (WithImports(DraftCore))();
    const upload = { format: "text" as const, content: "Artist - Song" };
    await client.createImportDraft(upload);
    await client.getImportDraft("draft/id");
    await client.updateImportDraft("draft/id", { ...upload, revision: 2 });
    await client.previewImportDraft("draft/id", 3);
    const confirmation = {
        revision: 3,
        previewRevision: 4,
        mappingDigest: "a".repeat(64),
        categories: ["playlists" as const],
    };
    await client.confirmImportDraft("draft/id", confirmation);
    assert.deepEqual(
        calls.map((call) => call.endpoint),
        [
            "/import/drafts",
            "/import/drafts/draft%2Fid",
            "/import/drafts/draft%2Fid",
            "/import/drafts/draft%2Fid/preview",
            "/import/drafts/draft%2Fid/confirm",
        ],
    );
    assert.equal(calls[2].options.method, "PUT");
    assert.deepEqual(JSON.parse(calls[4].options.body as string), confirmation);
});
