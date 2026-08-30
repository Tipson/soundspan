import assert from "node:assert/strict";
import { test } from "node:test";

import {
    createTasteProfile,
    getTasteProfile,
    replaceTasteProfile,
    skipTasteProfile,
} from "../../features/taste-profile/api";

const state = {
    profile: null,
    completedAt: null,
    skippedAt: null,
    needsOnboarding: false,
};

test("taste profile API uses GET and account-scoped POST/PUT payloads", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
    ) => {
        calls.push({
            url: String(input),
            method: init?.method ?? "GET",
            body:
                typeof init?.body === "string"
                    ? JSON.parse(init.body)
                    : undefined,
        });
        return Response.json(state);
    }) as typeof fetch;

    try {
        await getTasteProfile();
        await createTasteProfile({
            genres: ["Рок"],
            artists: ["Кино", "Muse"],
        });
        await replaceTasteProfile({
            genres: ["Инди"],
            artists: ["Земфира", "Radiohead"],
        });
        await skipTasteProfile("create");
        await skipTasteProfile("replace");
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.deepEqual(
        calls.map(({ url, method, body }) => ({
            path: new URL(url).pathname,
            method,
            body,
        })),
        [
            { path: "/api/taste-profile", method: "GET", body: undefined },
            {
                path: "/api/taste-profile",
                method: "POST",
                body: {
                    genres: ["Рок"],
                    artists: ["Кино", "Muse"],
                },
            },
            {
                path: "/api/taste-profile",
                method: "PUT",
                body: {
                    genres: ["Инди"],
                    artists: ["Земфира", "Radiohead"],
                },
            },
            {
                path: "/api/taste-profile",
                method: "POST",
                body: { skip: true },
            },
            {
                path: "/api/taste-profile",
                method: "PUT",
                body: { skip: true },
            },
        ],
    );
});
