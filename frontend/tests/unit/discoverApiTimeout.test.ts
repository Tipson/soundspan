import assert from "node:assert/strict";
import test from "node:test";
import { WithDiscover } from "../../lib/api/discover";
import { ApiClientCore } from "../../lib/api/core";

interface RecordedCall {
    endpoint: string;
    timeoutMs: number | undefined;
    retryOnTimeout: boolean | undefined;
    signal: AbortSignal | null | undefined;
}

class RecordingCore extends ApiClientCore {
    public readonly calls: RecordedCall[] = [];

    override async request<T>(
        endpoint: string,
        options: RequestInit & {
            timeoutMs?: number;
            retryOnTimeout?: boolean;
        } = {},
    ): Promise<T> {
        this.calls.push({
            endpoint,
            timeoutMs: options.timeoutMs,
            retryOnTimeout: options.retryOnTimeout,
            signal: options.signal,
        });
        return {} as T;
    }
}

class DiscoverClient extends WithDiscover(RecordingCore) {}

test("discover search owns a client budget above backend deadlines and below the proxy", async () => {
    const client = new DiscoverClient();
    const controller = new AbortController();

    await client.discoverSearch(
        "massive attack",
        "music",
        50,
        controller.signal,
    );

    assert.deepEqual(client.calls, [
        {
            endpoint: "/search/discover?q=massive%20attack&type=music&limit=50",
            timeoutMs: 14_000,
            retryOnTimeout: false,
            signal: controller.signal,
        },
    ]);
});
