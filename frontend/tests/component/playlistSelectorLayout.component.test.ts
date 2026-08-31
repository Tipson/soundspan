import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const Icon = (props: Record<string, unknown>) =>
    React.createElement("i", props);

interface TestPlaylist {
    id: string;
    name: string;
    trackCount?: number;
    isOwner?: boolean;
}

const defaultPlaylists: TestPlaylist[] = [
    { id: "playlist-1", name: "В дорогу", trackCount: 18 },
    { id: "playlist-2", name: "Спокойный вечер", trackCount: 9 },
];
const apiState = {
    getPlaylists: async (): Promise<TestPlaylist[]> => defaultPlaylists,
    createPlaylist: async (name: string): Promise<TestPlaylist> => ({
        id: "playlist-new",
        name,
    }),
};

mock.module("lucide-react", {
    namedExports: { Check: Icon, Music2: Icon, Plus: Icon, X: Icon },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("span", null, "spinner"),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getPlaylists: () => apiState.getPlaylists(),
            createPlaylist: (name: string) => apiState.createPlaylist(name),
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: { error: () => undefined },
    },
});

beforeEach(() => {
    apiState.getPlaylists = async () => defaultPlaylists;
    apiState.createPlaylist = async (name: string) => ({
        id: "playlist-new",
        name,
    });
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

async function mountSelector(
    onSelectPlaylist: (playlistId: string) => Promise<void> = async () =>
        undefined,
    onClose: () => void = () => undefined,
) {
    const { createRoot } = await import("react-dom/client");
    const { PlaylistSelector } =
        await import("../../components/ui/PlaylistSelector");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const render = async (isOpen: boolean) => {
        await React.act(async () => {
            root.render(
                React.createElement(PlaylistSelector, {
                    isOpen,
                    onClose,
                    onSelectPlaylist,
                }),
            );
            await Promise.resolve();
            await Promise.resolve();
        });
    };
    await render(true);

    return { container, root, render };
}

async function unmountSelector(
    mounted: Awaited<ReturnType<typeof mountSelector>>,
) {
    await React.act(async () => mounted.root.unmount());
    mounted.container.remove();
}

async function fillPlaylistName(input: HTMLInputElement, value: string) {
    await React.act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
        )?.set;
        assert.ok(setter);
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

test("PlaylistSelector portals one responsive dialog with independently scrollable options and a stable create area", async () => {
    const mounted = await mountSelector();

    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.getAttribute("aria-labelledby"));
    assert.equal(mounted.container.querySelector('[role="dialog"]'), null);
    assert.match(dialog.textContent ?? "", /В дорогу/);
    assert.match(dialog.textContent ?? "", /Спокойный вечер/);
    assert.ok(dialog.querySelector('[data-playlist-selector="options"]'));
    assert.ok(dialog.querySelector('[data-playlist-selector="create"]'));
    const input = dialog.querySelector<HTMLInputElement>(
        'input[name="playlist-name"]',
    );
    assert.ok(input);
    assert.equal(input.getAttribute("maxlength"), "200");
    assert.equal(input.hasAttribute("autofocus"), false);
    assert.match(dialog.className, /overscroll-contain/);
    assert.match(dialog.className, /safe-area-inset-bottom/);
    assert.match(
        dialog.querySelector('[data-playlist-selector="options"]')?.className ??
            "",
        /overscroll-contain/,
    );

    await unmountSelector(mounted);
});

test("PlaylistSelector shows an inline loading error", async () => {
    apiState.getPlaylists = async () => {
        throw new Error("offline");
    };
    const mounted = await mountSelector();

    const alert = document.body.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent ?? "", /Не удалось загрузить плейлисты/);

    await unmountSelector(mounted);
});

test("PlaylistSelector only offers playlists the current user can mutate", async () => {
    apiState.getPlaylists = async () => [
        {
            id: "playlist-owned",
            name: "Мой плейлист",
            trackCount: 3,
            isOwner: true,
        },
        {
            id: "playlist-legacy",
            name: "Старый плейлист",
            trackCount: 2,
        },
        {
            id: "playlist-foreign",
            name: "Чужой публичный плейлист",
            trackCount: 11,
            isOwner: false,
        },
    ];

    const mounted = await mountSelector();
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? "", /Мой плейлист/);
    assert.match(dialog.textContent ?? "", /Старый плейлист/);
    assert.doesNotMatch(dialog.textContent ?? "", /Чужой публичный плейлист/);

    await unmountSelector(mounted);
});

test("PlaylistSelector shows inline create and add errors without closing", async () => {
    apiState.createPlaylist = async () => {
        throw new Error("create unavailable");
    };
    const mounted = await mountSelector(async () => {
        throw new Error("add unavailable");
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const input = dialog.querySelector<HTMLInputElement>(
        'input[name="playlist-name"]',
    );
    assert.ok(input);
    await fillPlaylistName(input, "Новый список");
    const createButton = Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Создать",
    );
    assert.ok(createButton);

    await React.act(async () => {
        createButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
    assert.match(
        dialog.querySelector('[role="alert"]')?.textContent ?? "",
        /Не удалось создать плейлист/,
    );

    const playlistButton = Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("В дорогу"),
    );
    assert.ok(playlistButton);
    await React.act(async () => {
        playlistButton.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
        await Promise.resolve();
    });
    assert.match(
        dialog.querySelector('[role="alert"]')?.textContent ?? "",
        /Не удалось добавить трек в плейлист/,
    );

    await unmountSelector(mounted);
});

test("PlaylistSelector retries the same created playlist after closing and reopening", async () => {
    let createCalls = 0;
    const selectedPlaylistIds: string[] = [];
    let closeCalls = 0;
    let addAttempts = 0;
    let createdEvents = 0;
    const handleCreated = (event: Event) => {
        createdEvents++;
        assert.equal(
            (event as CustomEvent<{ id: string }>).detail.id,
            "playlist-new",
        );
    };
    window.addEventListener("playlist-created", handleCreated);
    apiState.createPlaylist = async (name: string) => {
        createCalls++;
        return { id: "playlist-new", name, isOwner: true };
    };
    const mounted = await mountSelector(
        async (playlistId) => {
            assert.equal(createdEvents, 1);
            selectedPlaylistIds.push(playlistId);
            addAttempts++;
            if (addAttempts === 1) throw new Error("add unavailable");
        },
        () => {
            closeCalls++;
        },
    );
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const input = dialog.querySelector<HTMLInputElement>(
        'input[name="playlist-name"]',
    );
    assert.ok(input);
    await fillPlaylistName(input, "Новый список");
    const createButton = Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Создать",
    );
    assert.ok(createButton);

    await React.act(async () => {
        createButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.equal(createCalls, 1);
    assert.deepEqual(selectedPlaylistIds, ["playlist-new"]);
    assert.equal(createdEvents, 1);
    assert.equal(closeCalls, 0);
    assert.match(
        dialog.querySelector('[role="alert"]')?.textContent ?? "",
        /Плейлист создан, но не удалось добавить/,
    );

    await mounted.render(false);
    assert.equal(document.body.querySelector('[role="dialog"]'), null);
    await mounted.render(true);
    const reopenedDialog = document.body.querySelector('[role="dialog"]');
    assert.ok(reopenedDialog);
    const retryButton = Array.from(
        reopenedDialog.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Повторить добавление"));
    assert.ok(retryButton);

    await React.act(async () => {
        retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.equal(createCalls, 1);
    assert.deepEqual(selectedPlaylistIds, ["playlist-new", "playlist-new"]);
    assert.equal(createdEvents, 1);
    assert.equal(closeCalls, 1);

    window.removeEventListener("playlist-created", handleCreated);
    await unmountSelector(mounted);
});

test("PlaylistSelector ignores a second Enter while playlist creation is in flight", async () => {
    let createCalls = 0;
    const selectedPlaylistIds: string[] = [];
    let resolveCreate: ((playlist: TestPlaylist) => void) | undefined;
    const pendingCreate = new Promise<TestPlaylist>((resolve) => {
        resolveCreate = resolve;
    });
    apiState.createPlaylist = async () => {
        createCalls++;
        return pendingCreate;
    };
    const mounted = await mountSelector(async (playlistId) => {
        selectedPlaylistIds.push(playlistId);
    });
    const input = document.body.querySelector<HTMLInputElement>(
        'input[name="playlist-name"]',
    );
    assert.ok(input);
    await fillPlaylistName(input, "Один список");
    const playlistButton = Array.from(
        document.body.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("В дорогу"));
    assert.ok(playlistButton);

    await React.act(async () => {
        input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        playlistButton.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
        await Promise.resolve();
    });

    assert.equal(createCalls, 1);
    assert.deepEqual(selectedPlaylistIds, []);

    await React.act(async () => {
        assert.ok(resolveCreate);
        resolveCreate({ id: "playlist-new", name: "Один список" });
        await pendingCreate;
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.deepEqual(selectedPlaylistIds, ["playlist-new"]);

    await unmountSelector(mounted);
});

test("PlaylistSelector ignores create clicks while adding to an existing playlist", async () => {
    let createCalls = 0;
    const selectedPlaylistIds: string[] = [];
    let resolveAdd: (() => void) | undefined;
    const pendingAdd = new Promise<void>((resolve) => {
        resolveAdd = resolve;
    });
    apiState.createPlaylist = async (name: string) => {
        createCalls++;
        return { id: "playlist-new", name };
    };
    const mounted = await mountSelector(async (playlistId) => {
        selectedPlaylistIds.push(playlistId);
        await pendingAdd;
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const input = dialog.querySelector<HTMLInputElement>(
        'input[name="playlist-name"]',
    );
    assert.ok(input);
    await fillPlaylistName(input, "Не создавать");
    const playlistButton = Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("В дорогу"),
    );
    const createButton = Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Создать",
    );
    assert.ok(playlistButton);
    assert.ok(createButton);

    await React.act(async () => {
        playlistButton.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
        createButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });

    assert.deepEqual(selectedPlaylistIds, ["playlist-1"]);
    assert.equal(createCalls, 0);

    await React.act(async () => {
        assert.ok(resolveAdd);
        resolveAdd();
        await pendingAdd;
        await Promise.resolve();
        await Promise.resolve();
    });

    await unmountSelector(mounted);
});
