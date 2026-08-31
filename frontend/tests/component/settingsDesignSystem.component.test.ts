import assert from "node:assert/strict";
import { test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

GlobalRegistrator.register({ url: "https://soundspan.test/settings" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("settings navigation exposes groups and the current section as two levels", async () => {
    const { SettingsSidebar } =
        await import("../../features/settings/components/ui/SettingsSidebar");
    const html = renderToStaticMarkup(
        React.createElement(SettingsSidebar, {
            items: [
                {
                    id: "account",
                    label: "Account",
                    groupId: "profile",
                    groupLabel: "Profile",
                },
                {
                    id: "playback",
                    label: "Playback",
                    groupId: "listening",
                    groupLabel: "Listening",
                },
                {
                    id: "admin",
                    label: "Admin",
                    groupId: "system",
                    groupLabel: "System",
                    adminOnly: true,
                },
            ],
            activeSection: "playback",
            onSectionClick: () => undefined,
            isAdmin: false,
        }),
    );

    assert.match(
        html,
        /data-settings-navigation-level="groups"[^>]+aria-label="Группы настроек"/,
    );
    assert.match(
        html,
        /data-settings-navigation-level="sections"[^>]+aria-label="Разделы настроек"/,
    );
    assert.match(html, /aria-current="page"[^>]*>Listening</);
    assert.match(html, /aria-current="location"[^>]*>Playback</);
    assert.match(html, /min-h-11/);
    assert.doesNotMatch(html, />Admin</);
});

test("settings sections are labelled card surfaces", async () => {
    const { SettingsSection } =
        await import("../../features/settings/components/ui/SettingsSection");
    const html = renderToStaticMarkup(
        React.createElement(
            SettingsSection,
            {
                id: "playback",
                title: "Playback",
                description: "Choose how music sounds.",
            } as React.ComponentProps<typeof SettingsSection>,
            React.createElement("div", null, "Controls"),
        ),
    );

    assert.match(html, /data-settings-section="true"/);
    assert.match(html, /aria-labelledby="playback-title"/);
    assert.match(html, /id="playback-title"/);
    assert.match(html, /Choose how music sounds\./);
});

test("password settings expose their visibility control", async () => {
    const { SettingsInput } =
        await import("../../features/settings/components/ui/SettingsInput");
    const html = renderToStaticMarkup(
        React.createElement(SettingsInput, {
            id: "provider-password",
            type: "password",
            value: "secret",
            onChange: () => undefined,
        }),
    );

    assert.match(html, /aria-label="Показать пароль"/);
    assert.match(html, /type="password"/);
    assert.match(html, /name="provider-password"/);
    assert.match(html, /autocomplete="off"/i);
});

test("settings rows give generated inputs a stable accessible relationship", async () => {
    const { SettingsInput } =
        await import("../../features/settings/components/ui/SettingsInput");
    const { SettingsRow } =
        await import("../../features/settings/components/ui/SettingsRow");
    const html = renderToStaticMarkup(
        React.createElement(
            SettingsRow,
            { label: "Soulseek username" } as React.ComponentProps<
                typeof SettingsRow
            >,
            React.createElement(SettingsInput, {
                value: "listener",
                onChange: () => undefined,
                placeholder: "your_username",
            }),
        ),
    );

    const labelId = html.match(/id="([^"]+-label)"/)?.[1];
    const inputId = html.match(/<input[^>]*id="([^"]+)"/)?.[1];
    assert.ok(labelId);
    assert.ok(inputId);
    assert.match(html, new RegExp(`aria-labelledby="${labelId}"`));
    assert.match(html, /name="soulseek-username"/);
    assert.match(html, /autocomplete="off"/i);
});

test("settings layout uses the existing application main landmark", async () => {
    const { SettingsLayout } =
        await import("../../features/settings/components/ui/SettingsLayout");
    const html = renderToStaticMarkup(
        React.createElement(
            SettingsLayout,
            {
                sidebarItems: [{ id: "account", label: "Account" }],
                isAdmin: false,
            } as React.ComponentProps<typeof SettingsLayout>,
            React.createElement("section", { id: "account" }, "Account"),
        ),
    );

    assert.doesNotMatch(html, /<main(?:\s|>)/);
    assert.match(html, /data-settings-layout="two-level"/);
    assert.doesNotMatch(html, /lg:grid-cols-\[14rem_minmax\(0,1fr\)\]/);
});

test("settings navigation deep-links sections and restores them without forced motion", async () => {
    const { SettingsLayout } =
        await import("../../features/settings/components/ui/SettingsLayout");
    const scrollCalls: Array<{ id: string; behavior?: ScrollBehavior }> = [];
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({ matches: true }),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value(this: HTMLElement, options?: ScrollIntoViewOptions) {
            scrollCalls.push({ id: this.id, behavior: options?.behavior });
        },
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                SettingsLayout,
                {
                    sidebarItems: [
                        {
                            id: "account",
                            label: "Account",
                            groupId: "profile",
                            groupLabel: "Profile",
                        },
                        {
                            id: "playback",
                            label: "Playback",
                            groupId: "listening",
                            groupLabel: "Listening",
                        },
                    ],
                    isAdmin: false,
                } as React.ComponentProps<typeof SettingsLayout>,
                React.createElement("section", { id: "account" }, "Account"),
                React.createElement("section", { id: "playback" }, "Playback"),
            ),
        );
    });

    const listeningButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
            '[data-settings-navigation-level="groups"] button',
        ),
    ).find((button) => button.textContent === "Listening");
    assert.ok(listeningButton);
    await React.act(async () => listeningButton.click());

    const playbackButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
            '[data-settings-navigation-level="sections"] button',
        ),
    ).find((button) => button.textContent === "Playback");
    assert.ok(playbackButton);
    await React.act(async () => playbackButton.click());
    assert.equal(window.location.hash, "#playback");
    assert.deepEqual(scrollCalls.at(-1), {
        id: "playback",
        behavior: "auto",
    });

    window.history.replaceState({}, "", "/settings#account");
    await React.act(async () =>
        window.dispatchEvent(new PopStateEvent("popstate")),
    );
    assert.deepEqual(scrollCalls.at(-1), { id: "account", behavior: "auto" });
    assert.equal(
        container.querySelector<HTMLButtonElement>(
            '[data-settings-navigation-level="sections"] button[aria-current]',
        )?.textContent,
        "Account",
    );

    await React.act(async () => root.unmount());
    container.remove();
});
