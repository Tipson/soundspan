import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register({ url: "https://soundspan.test/settings" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const accountCalls: string[] = [];

mock.module("@/features/taste-profile/hooks/useTasteProfile", {
    namedExports: {
        useTasteProfile: (accountId: string) => {
            accountCalls.push(accountId);
            return {
                state: {
                    profile: {
                        genres: ["Рок", "Метал"],
                        artists: ["Кино"],
                        seedTracks: [],
                    },
                    completedAt: "2026-08-30T00:00:00.000Z",
                    skippedAt: null,
                    needsOnboarding: false,
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

mock.module("@/features/taste-profile/components/TasteProfileEditor", {
    namedExports: {
        TasteProfileEditor: ({ isOpen }: { isOpen: boolean }) =>
            React.createElement("div", {
                "data-testid": "taste-profile-editor",
                "data-open": String(isOpen),
            }),
    },
});

after(() => GlobalRegistrator.unregister());

test("settings expose account-scoped taste editing in Russian", async () => {
    const { TasteProfileSettingsSection } =
        await import("../../features/taste-profile/components/TasteProfileSettingsSection");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(TasteProfileSettingsSection, {
                accountId: "account-settings",
            }),
        );
    });

    assert.deepEqual(accountCalls, ["account-settings"]);
    assert.match(container.textContent ?? "", /Музыкальные вкусы/);
    assert.match(container.textContent ?? "", /3 выбора сохранено/);
    assert.equal(
        container
            .querySelector('[data-testid="taste-profile-editor"]')
            ?.getAttribute("data-open"),
        "false",
    );

    const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === "Изменить вкусы",
    );
    assert.ok(button);
    await React.act(async () => button.click());
    assert.equal(
        container
            .querySelector('[data-testid="taste-profile-editor"]')
            ?.getAttribute("data-open"),
        "true",
    );

    await React.act(async () => root.unmount());
    container.remove();
});
