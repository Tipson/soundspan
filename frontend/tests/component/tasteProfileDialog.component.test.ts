import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";

import { TasteProfileDialog } from "../../features/taste-profile/components/TasteProfileDialog";
import type { TasteProfileSelection } from "../../features/taste-profile/types";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    GlobalRegistrator.unregister();
});

function findButton(container: ParentNode, label: string) {
    return Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === label,
    );
}

function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the input value setter");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mountDialog(
    overrides: Partial<React.ComponentProps<typeof TasteProfileDialog>> = {},
) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const saves: TasteProfileSelection[] = [];
    let skips = 0;
    let closes = 0;
    const props: React.ComponentProps<typeof TasteProfileDialog> = {
        mode: "onboarding",
        initialSelection: { genres: [], artists: [] },
        isSaving: false,
        error: null,
        onSave: async (selection) => {
            saves.push(selection);
        },
        onSkip: async () => {
            skips += 1;
        },
        onClose: () => {
            closes += 1;
        },
        ...overrides,
    };
    await React.act(async () => {
        root.render(React.createElement(TasteProfileDialog, props));
    });
    return {
        container,
        saves,
        get skips() {
            return skips;
        },
        get closes() {
            return closes;
        },
        cleanup: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("onboarding is a Russian accessible dialog and explains that it does not create likes", async () => {
    const mounted = await mountDialog();
    const dialog = mounted.container.querySelector('[role="dialog"]');

    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.getAttribute("aria-labelledby"));
    assert.ok(dialog.getAttribute("aria-describedby"));
    assert.match(dialog.textContent ?? "", /Настроим музыку под вас/);
    assert.match(dialog.textContent ?? "", /не ставит лайки автоматически/i);
    assert.match(dialog.textContent ?? "", /Шаг 1 из 2/);

    await mounted.cleanup();
});

test("a listener can choose genres, add an artist, and save 3 real taste signals", async () => {
    const mounted = await mountDialog();
    const rock = findButton(mounted.container, "Рок");
    const metal = findButton(mounted.container, "Метал");
    assert.ok(rock);
    assert.ok(metal);

    await React.act(async () => {
        rock.click();
        metal.click();
    });
    assert.equal(rock.getAttribute("aria-pressed"), "true");

    const next = findButton(mounted.container, "Дальше: артисты");
    assert.ok(next);
    await React.act(async () => next.click());

    const artist = findButton(mounted.container, "Linkin Park");
    assert.ok(artist);
    await React.act(async () => artist.click());

    const save = findButton(mounted.container, "Сохранить вкусы");
    assert.ok(save);
    assert.equal(save.disabled, false);
    await React.act(async () => save.click());

    assert.deepEqual(mounted.saves, [
        { genres: ["Рок", "Метал"], artists: ["Linkin Park"] },
    ]);
    await mounted.cleanup();
});

test("artist search accepts a manual real name and skip is explicit", async () => {
    const mounted = await mountDialog();
    const next = findButton(mounted.container, "Дальше: артисты");
    assert.ok(next);
    await React.act(async () => next.click());

    const input = mounted.container.querySelector<HTMLInputElement>(
        'input[aria-label="Найти или добавить артиста"]',
    );
    assert.ok(input);
    await React.act(async () => {
        typeInto(input, "  Дайте танк (!)  ");
    });
    await React.act(async () => {
        input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
    });
    assert.match(mounted.container.textContent ?? "", /Дайте танк \(!\)/);

    const skip = findButton(mounted.container, "Пропустить настройку");
    assert.ok(skip);
    await React.act(async () => skip.click());
    assert.equal(mounted.skips, 1);
    assert.equal(mounted.closes, 0);

    await mounted.cleanup();
});

test("editing can be dismissed with Escape while mandatory onboarding uses its explicit skip", async () => {
    const editor = await mountDialog({ mode: "edit" });
    await React.act(async () => {
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    assert.equal(editor.closes, 1);
    await editor.cleanup();

    const onboarding = await mountDialog();
    await React.act(async () => {
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    assert.equal(onboarding.closes, 0);
    await onboarding.cleanup();
});

test("rapid repeated save clicks start only one provider-backed write", async () => {
    let saveCalls = 0;
    let resolveSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
        resolveSave = resolve;
    });
    const mounted = await mountDialog({
        initialSelection: {
            genres: ["Рок"],
            artists: ["Кино", "Muse"],
        },
        onSave: async () => {
            saveCalls += 1;
            await pendingSave;
        },
    });
    const next = findButton(mounted.container, "Дальше: артисты");
    assert.ok(next);
    await React.act(async () => next.click());
    const save = findButton(mounted.container, "Сохранить вкусы");
    assert.ok(save);

    await React.act(async () => {
        save.click();
        save.click();
        await Promise.resolve();
    });
    assert.equal(saveCalls, 1);

    await React.act(async () => {
        resolveSave();
        await pendingSave;
    });
    await mounted.cleanup();
});
