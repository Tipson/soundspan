import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "@playwright/test";
import { expectPlaying } from "../e2e/core/fixture";

function observedPage(times: number[]): Page {
    let index = 0;
    return {
        evaluate: async (_expression: unknown, source?: string) =>
            source === undefined
                ? 1
                : {
                      time: times[Math.min(index++, times.length - 1)],
                      paused: false,
                      readyState: 2,
                      src: "blob:core-track",
                  },
    } as unknown as Page;
}

test("a positive but frozen restored media position cannot pass", async () => {
    await assert.rejects(
        () => expectPlaying(observedPage([5]), "blob:", 0, 300),
        /Real media advances for blob:/,
    );
});

test("media must advance beyond its observed restored position", async () => {
    await expectPlaying(observedPage([5, 5, 5.4]), "blob:", 0, 300);
});
