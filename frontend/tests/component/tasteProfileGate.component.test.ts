import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let needsOnboarding = false;
const accountCalls: string[] = [];
const catalogCalls: string[] = [];

// The gate tests account visibility, not catalog networking. Keep its real
// dialog while isolating nested artwork/catalog queries from real services.
mock.module("@/lib/api", {
    namedExports: {
        api: {
            request: async (path: string) => {
                catalogCalls.push(path);
                if (path.startsWith("/taste-profile/artists?")) {
                    return { artists: [], nextPage: null };
                }
                if (path.startsWith("/taste-profile/artist-image?")) {
                    return { image: null };
                }
                throw new Error(`Unexpected gate request: ${path}`);
            },
        },
    },
});

mock.module("@/features/taste-profile/hooks/useTasteProfile", {
    namedExports: {
        useTasteProfile: (accountId: string) => {
            accountCalls.push(accountId);
            return {
                state: {
                    profile: null,
                    completedAt: null,
                    skippedAt: null,
                    needsOnboarding,
                },
                isLoading: false,
                error: null,
                isSaving: false,
                create: async () => undefined,
                replace: async () => undefined,
                skip: async () => undefined,
            };
        },
    },
});

after(() => GlobalRegistrator.unregister());
beforeEach(() => {
    needsOnboarding = false;
    accountCalls.length = 0;
    catalogCalls.length = 0;
});

test("the gate opens only when the authenticated account explicitly needs onboarding", async () => {
    const { TasteProfileOnboardingGate } =
        await import("../../features/taste-profile/components/TasteProfileOnboardingGate");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });

    const renderGate = (accountId: string) =>
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(TasteProfileOnboardingGate, { accountId }),
        );

    await React.act(async () => {
        root.render(renderGate("account-a"));
    });
    assert.equal(container.querySelector('[role="dialog"]'), null);

    needsOnboarding = true;
    await React.act(async () => {
        root.render(renderGate("account-b"));
    });
    assert.ok(container.querySelector('[role="dialog"]'));
    assert.deepEqual(accountCalls, ["account-a", "account-b"]);

    await React.act(async () => root.unmount());
    container.remove();
    queryClient.clear();
    assert.ok(
        catalogCalls.every((path) =>
            /^\/taste-profile\/(artists|artist-image)\?/.test(path),
        ),
    );
});
