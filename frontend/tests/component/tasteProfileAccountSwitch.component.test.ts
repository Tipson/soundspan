import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import type {
    TasteProfileSelection,
    TasteProfileState,
} from "../../features/taste-profile/types";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apiModule = new URL(
    "../../features/taste-profile/api.ts",
    import.meta.url,
).href;

let getCalls = 0;
let resolveCreate!: (state: TasteProfileState) => void;
let pendingCreate!: Promise<TasteProfileState>;

function profileState(genre: string): TasteProfileState {
    return {
        profile: {
            genres: [genre],
            artists: ["Кино", "Muse"],
            seedTracks: [],
        },
        completedAt: "2026-08-30T10:00:00.000Z",
        skippedAt: null,
        needsOnboarding: false,
    };
}

mock.module(apiModule, {
    namedExports: {
        getTasteProfile: async () =>
            getCalls++ === 0 ? profileState("Рок") : profileState("Инди"),
        createTasteProfile: async (_selection: TasteProfileSelection) =>
            pendingCreate,
        replaceTasteProfile: async () => profileState("Электроника"),
        skipTasteProfile: async () => ({
            profile: null,
            completedAt: null,
            skippedAt: "2026-08-30T10:00:00.000Z",
            needsOnboarding: false,
        }),
    },
});

after(() => GlobalRegistrator.unregister());
beforeEach(() => {
    getCalls = 0;
    pendingCreate = new Promise<TasteProfileState>((resolve) => {
        resolveCreate = resolve;
    });
});

async function flushReact() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

test("a write started by one account cannot populate the next account's cache", async () => {
    const [{ useTasteProfile }, { queryKeys }, { createRoot }] =
        await Promise.all([
            import("../../features/taste-profile/hooks/useTasteProfile"),
            import("../../lib/queryKeys"),
            import("react-dom/client"),
        ]);
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let currentHook: ReturnType<typeof useTasteProfile> | null = null;

    function Harness({ accountId }: { accountId: string }) {
        currentHook = useTasteProfile(accountId);
        return React.createElement(
            "span",
            null,
            currentHook.state?.profile?.genres[0] ?? "loading",
        );
    }

    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(Harness, { accountId: "account-a" }),
            ),
        );
    });
    await flushReact();
    assert.match(container.textContent ?? "", /Рок/);

    const personalizedKey = queryKeys.personalizedHome(24);
    queryClient.setQueryData(personalizedKey, { marker: "stale-profile" });

    let createPromise!: Promise<TasteProfileState>;
    await React.act(async () => {
        createPromise = currentHook!.create({
            genres: ["Метал"],
            artists: ["Кино", "Muse"],
        });
        await Promise.resolve();
    });
    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(Harness, { accountId: "account-b" }),
            ),
        );
    });
    await flushReact();
    assert.match(container.textContent ?? "", /Инди/);

    await React.act(async () => {
        resolveCreate(profileState("Метал"));
        await createPromise;
    });
    await flushReact();

    assert.equal(
        queryClient.getQueryData<TasteProfileState>(
            queryKeys.tasteProfile("account-a"),
        )?.profile?.genres[0],
        "Метал",
    );
    assert.equal(
        queryClient.getQueryData<TasteProfileState>(
            queryKeys.tasteProfile("account-b"),
        )?.profile?.genres[0],
        "Инди",
    );
    assert.equal(
        queryClient.getQueryState(personalizedKey)?.isInvalidated,
        true,
        "saving a profile should invalidate recommendations without assuming two accounts must receive different tracks",
    );

    await React.act(async () => root.unmount());
    container.remove();
    queryClient.clear();
});
