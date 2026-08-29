import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClientCore } from "../../lib/api/core";
import { WithPlays } from "../../lib/api/plays";

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
        return { id: "play-1", success: true } as T;
    }
}

class PlaysClient extends WithPlays(RecordingCore) {}

test("play API carries recommendation context and final engagement", async () => {
    const client = new PlaysClient();

    const play = await client.logPlay(
        {
            youtubeVideoId: "video-1",
            title: "Numb",
            artist: "Linkin Park",
            album: "Meteora",
            duration: 185,
        },
        { playContext: "wave", waveMode: "new" },
    );
    await client.updatePlayEngagement(play.id, {
        listenedSeconds: 181.5,
        completionRatio: 0.981,
        outcome: "completed",
    });

    assert.deepEqual(client.calls, [
        {
            endpoint: "/plays",
            method: "POST",
            body: JSON.stringify({
                youtubeVideoId: "video-1",
                title: "Numb",
                artist: "Linkin Park",
                album: "Meteora",
                duration: 185,
                playContext: "wave",
                waveMode: "new",
            }),
        },
        {
            endpoint: "/plays/play-1/engagement",
            method: "PATCH",
            body: JSON.stringify({
                listenedSeconds: 181.5,
                completionRatio: 0.981,
                outcome: "completed",
            }),
        },
    ]);
});
