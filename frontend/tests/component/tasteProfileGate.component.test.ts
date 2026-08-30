import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let needsOnboarding = false;
const accountCalls: string[] = [];

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
});

test("the gate opens only when the authenticated account explicitly needs onboarding", async () => {
    const { TasteProfileOnboardingGate } =
        await import("../../features/taste-profile/components/TasteProfileOnboardingGate");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(TasteProfileOnboardingGate, {
                accountId: "account-a",
            }),
        );
    });
    assert.equal(container.querySelector('[role="dialog"]'), null);

    needsOnboarding = true;
    await React.act(async () => {
        root.render(
            React.createElement(TasteProfileOnboardingGate, {
                accountId: "account-b",
            }),
        );
    });
    assert.ok(container.querySelector('[role="dialog"]'));
    assert.deepEqual(accountCalls, ["account-a", "account-b"]);

    await React.act(async () => root.unmount());
    container.remove();
});
