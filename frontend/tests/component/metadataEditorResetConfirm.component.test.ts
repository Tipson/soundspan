import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let saveError: Error | null = null;
const updateArtistMetadata = mock.fn(async (..._args: unknown[]) => {
    if (saveError) throw saveError;
    return { name: "Name" };
});
const resetArtistMetadata = mock.fn(async () => ({
    message: "ok",
    artist: {},
}));

mock.module("@/lib/api", {
    namedExports: {
        api: {
            resetArtistMetadata,
            resetAlbumMetadata: async () => ({}),
            resetTrackMetadata: async () => ({}),
            updateArtistMetadata,
            updateAlbumMetadata: async () => ({}),
            updateTrackMetadata: async () => ({}),
        },
    },
});

const toast = Object.assign(() => undefined, {
    success: () => undefined,
    error: () => undefined,
    info: () => undefined,
});
mock.module("sonner", { namedExports: { toast } });

mock.module("@/components/ui/MusicBrainzLookup", {
    namedExports: { MusicBrainzLookup: () => null },
});
mock.module("next/image", { defaultExport: () => null });
mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    resetArtistMetadata.mock.resetCalls();
    updateArtistMetadata.mock.resetCalls();
    saveError = null;
    document.body.replaceChildren();
});

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new Event("click", { bubbles: true }));
    });
}

function findButton(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes(text),
    );
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

function findLastExactButton(text: string): HTMLButtonElement {
    const buttons = Array.from(document.querySelectorAll("button")).filter(
        (candidate) => candidate.textContent === text,
    );
    const button = buttons.at(-1);
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

async function mountEditor(genres: string[] = []) {
    const { MetadataEditor } = await import("../../components/MetadataEditor");
    const { createRoot } = await import("react-dom/client");
    const onSave = mock.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(MetadataEditor, {
                type: "artist",
                id: "artist-1",
                currentData: {
                    name: "Name",
                    genres,
                    _originalGenres: genres,
                    _hasUserOverrides: true,
                },
                onSave,
            }),
        );
    });

    return {
        container,
        onSave,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

async function openResetConfirmation(): Promise<void> {
    const closedButtons = document.querySelectorAll("button");
    assert.equal(closedButtons.length, 1);
    await click(closedButtons[0]);
    await click(findButton("Вернуть исходные"));
}

test("confirms before resetting artist metadata", async (t) => {
    const harness = await mountEditor();
    t.after(harness.unmount);

    await openResetConfirmation();

    assert.equal(resetArtistMetadata.mock.callCount(), 0);
    assert.match(
        document.body.textContent ?? "",
        /Восстановить метаданные|нельзя отменить/i,
    );

    const confirmButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Восстановить",
    );
    assert.ok(confirmButton instanceof HTMLButtonElement);
    await click(confirmButton);
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.equal(resetArtistMetadata.mock.callCount(), 1);
});

test("cancelling reset confirmation does not reset artist metadata", async (t) => {
    const harness = await mountEditor();
    t.after(harness.unmount);

    await openResetConfirmation();
    await click(findLastExactButton("Отмена"));

    assert.equal(resetArtistMetadata.mock.callCount(), 0);
});

test("editor escapes clipped ancestor, closes by Escape and restores focus/scroll", async (t) => {
    const h = await mountEditor();
    t.after(h.unmount);
    h.container.style.overflow = "hidden";
    const opener = h.container.querySelector("button")!;
    opener.focus();
    await click(opener);
    const dialog = document.querySelector("[role=dialog]");
    assert.ok(dialog);
    assert.equal(h.container.contains(dialog), false);
    assert.equal(document.body.style.overflow, "hidden");
    await React.act(async () => {
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    assert.equal(document.querySelector("[role=dialog]"), null);
    assert.notEqual(document.body.style.overflow, "hidden");
    assert.equal(document.activeElement, opener);
    assert.equal(updateArtistMetadata.mock.callCount(), 0);
});

test("nested reset Escape preserves editor then Cancel discards without API", async (t) => {
    const h = await mountEditor();
    t.after(h.unmount);
    await openResetConfirmation();
    assert.equal(
        document.querySelectorAll("[role=dialog],[role=alertdialog]").length,
        2,
    );
    await React.act(async () => {
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    assert.equal(
        document.querySelectorAll("[role=dialog],[role=alertdialog]").length,
        1,
    );
    assert.equal(document.body.style.overflow, "hidden");
    await click(findLastExactButton("Отмена"));
    assert.equal(document.querySelector("[role=dialog]"), null);
    assert.equal(resetArtistMetadata.mock.callCount(), 0);
    assert.equal(updateArtistMetadata.mock.callCount(), 0);
});

test("labels bind fields, save failure stays announced and retry preserves API payload", async (t) => {
    const h = await mountEditor(["Рок", "Джаз"]);
    t.after(h.unmount);
    await click(h.container.querySelector("button")!);
    for (const caption of [
        "Имя исполнителя",
        "Биография",
        "Жанры",
        "Ссылка на изображение исполнителя",
    ]) {
        const label = Array.from(document.querySelectorAll("label")).find((x) =>
            x.textContent?.includes(caption),
        );
        assert.ok(label);
        assert.ok(label.htmlFor);
        assert.ok(document.getElementById(label.htmlFor));
    }
    saveError = Error("failure");
    await click(findButton("Сохранить изменения"));
    assert.ok(document.querySelector("[role=alert]"));
    assert.ok(document.querySelector("[role=dialog]"));
    saveError = null;
    await click(findButton("Сохранить изменения"));
    assert.equal(updateArtistMetadata.mock.callCount(), 2);
    assert.equal(updateArtistMetadata.mock.calls[1].arguments[0], "artist-1");
    assert.deepEqual(
        (
            updateArtistMetadata.mock.calls[1].arguments[1] as {
                genres: string[];
            }
        ).genres,
        ["Рок", "Джаз"],
    );
    assert.equal(h.onSave.mock.callCount(), 1);
    assert.equal(document.querySelector("[role=dialog]"), null);
});

test("opening and cancelling does not reorder original genre arrays", async (t) => {
    const genres = ["Рок", "Джаз"];
    const h = await mountEditor(genres);
    t.after(h.unmount);
    await click(h.container.querySelector("button")!);
    await click(findLastExactButton("Отмена"));
    assert.deepEqual(genres, ["Рок", "Джаз"]);
});
