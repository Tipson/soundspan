import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const Icon = (props: Record<string, unknown>) =>
    React.createElement("i", props);
const createCalls: Array<{ name: string; isPublic: boolean }> = [];

mock.module("lucide-react", {
    namedExports: { Plus: Icon, X: Icon },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("span", null, "spinner"),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            createPlaylist: async (name: string, isPublic: boolean) => {
                createCalls.push({ name, isPublic });
                return { id: "playlist-new", name, isPublic };
            },
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: { error: () => undefined },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

test("CreatePlaylistDialog creates a named playlist and publishes it to the page", async () => {
    createCalls.length = 0;
    const { createRoot } = await import("react-dom/client");
    const { CreatePlaylistDialog } =
        await import("../../features/playlist/components/CreatePlaylistDialog");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let closeCalls = 0;
    let createdId: string | null = null;
    let eventId: string | null = null;
    const completionOrder: string[] = [];
    const handleCreated = (event: Event) => {
        eventId = (event as CustomEvent<{ id: string }>).detail.id;
    };
    window.addEventListener("playlist-created", handleCreated);

    await React.act(async () => {
        root.render(
            React.createElement(CreatePlaylistDialog, {
                isOpen: true,
                onClose: () => {
                    closeCalls += 1;
                    completionOrder.push("close");
                },
                onCreated: (playlist: { id: string }) => {
                    createdId = playlist.id;
                    completionOrder.push("created");
                },
            }),
        );
    });

    const input = document.body.querySelector<HTMLInputElement>(
        'input[name="playlist-name"]',
    );
    assert.ok(input);
    await React.act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
        )?.set;
        assert.ok(setter);
        setter.call(input, "  Дорога домой  ");
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submit = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Создать плейлист"),
    );
    assert.ok(submit);
    await React.act(async () => {
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });

    assert.deepEqual(createCalls, [{ name: "Дорога домой", isPublic: false }]);
    assert.equal(createdId, "playlist-new");
    assert.equal(eventId, "playlist-new");
    assert.equal(closeCalls, 1);
    assert.deepEqual(
        completionOrder,
        ["close", "created"],
        "the deep-link query must be cleared before navigating to the new playlist",
    );
    assert.equal(input.getAttribute("maxlength"), "200");
    assert.equal(input.hasAttribute("autofocus"), false);

    window.removeEventListener("playlist-created", handleCreated);
    await React.act(async () => root.unmount());
    container.remove();
});
