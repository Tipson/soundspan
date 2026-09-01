import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let saved = false;
let toggleCalls = 0;

const Icon = () => React.createElement("i");

mock.module("lucide-react", {
    namedExports: {
        BookmarkPlus: Icon,
        Check: Icon,
        Loader2: Icon,
    },
});

mock.module("@/features/library/hooks/useSavedMusic", {
    namedExports: {
        useSavedMusicEntity: () => ({
            isSaved: saved,
            isLoading: false,
            isMutating: false,
            isError: false,
            toggle: async () => {
                toggleCalls += 1;
            },
        }),
    },
});

afterEach(() => {
    document.body.innerHTML = "";
    saved = false;
    toggleCalls = 0;
});

test("save control is explicit, pressed-aware, touch-sized, and actionable", async () => {
    const { SaveMusicEntityButton } =
        await import("../../features/library/components/SaveMusicEntityButton");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const entity = {
        type: "album" as const,
        source: "ytmusic",
        entityId: "MPREb_example",
        title: "Meteora",
        subtitle: "Linkin Park",
        imageUrl: null,
    };

    await act(async () => {
        root.render(React.createElement(SaveMusicEntityButton, { entity }));
    });

    const button = container.querySelector("button");
    assert.ok(button);
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.match(button.className, /min-h-11/);
    assert.match(button.textContent ?? "", /Сохранить в коллекцию/);

    await act(async () => {
        button.click();
    });
    assert.equal(toggleCalls, 1);

    saved = true;
    await act(async () => {
        root.render(React.createElement(SaveMusicEntityButton, { entity }));
    });
    assert.equal(
        container.querySelector("button")?.getAttribute("aria-pressed"),
        "true",
    );
    assert.match(container.textContent ?? "", /Удалить из коллекции/);

    await act(async () => root.unmount());
});
