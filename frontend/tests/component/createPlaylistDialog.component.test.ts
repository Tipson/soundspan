import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
    url: "http://localhost:3000/library?tab=playlists",
});
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const Icon = (props: Record<string, unknown>) =>
    React.createElement("i", props);
const createCalls: Array<{ name: string; isPublic: boolean }> = [];
let malformedResponse = false;
let createQuery: string | null = null;
const routerCalls: Array<{ kind: "push" | "replace"; url: string }> = [];
const originalReplace = window.history.replaceState.bind(window.history);
const historyEntries: Array<{ state: Record<string, unknown>; url: string }> = [
    { state: { __NA: true, tree: "library" }, url: "/library?tab=playlists" },
];
let historyIndex = 0;
let pendingBack = 0;
originalReplace(historyEntries[0].state, "", historyEntries[0].url);
mock.method(
    window.history,
    "pushState",
    (
        state: Record<string, unknown>,
        _unused: string,
        url?: string | URL | null,
    ) => {
        historyEntries.splice(++historyIndex);
        historyEntries.push({
            state,
            url: String(url ?? window.location.href),
        });
        originalReplace(state, "", historyEntries[historyIndex].url);
    },
);
mock.method(
    window.history,
    "replaceState",
    (
        state: Record<string, unknown>,
        _unused: string,
        url?: string | URL | null,
    ) => {
        historyEntries[historyIndex] = {
            state,
            url: String(url ?? window.location.href),
        };
        originalReplace(state, "", historyEntries[historyIndex].url);
    },
);
mock.method(window.history, "back", () => {
    pendingBack++;
});
function flushHistoryBack() {
    assert.equal(pendingBack, 1, "exactly one asynchronous Back is pending");
    pendingBack--;
    const entry = historyEntries[--historyIndex];
    originalReplace(entry.state, "", entry.url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: entry.state }));
}

mock.module("lucide-react", {
    namedExports: Object.fromEntries(
        [
            "Plus",
            "X",
            "Album",
            "ArrowRight",
            "Download",
            "Heart",
            "HardDriveDownload",
            "ListMusic",
            "Loader2",
            "Music2",
            "RotateCcw",
            "Search",
            "Sparkles",
            "Upload",
            "UserRound",
        ].map((name) => [name, Icon]),
    ),
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
                return malformedResponse
                    ? { name }
                    : { id: "playlist-new", name, isPublic };
            },
        },
    },
});

mock.module("next/navigation", {
    namedExports: {
        useSearchParams: () => ({
            get: (name: string) =>
                name === "create" ? createQuery : "playlists",
        }),
        useRouter: () => ({
            push: (url: string) => {
                routerCalls.push({ kind: "push", url });
                window.history.pushState(
                    { __NA: true, tree: "playlist" },
                    "",
                    url,
                );
            },
            replace: (url: string) => {
                routerCalls.push({ kind: "replace", url });
                createQuery = null;
                historyEntries[historyIndex].url = url;
                originalReplace(window.history.state, "", url);
            },
        }),
    },
});
mock.module("@/hooks/useQueries", {
    namedExports: {
        usePlaylistsQuery: () => ({
            data: [],
            isLoading: false,
            isError: false,
            refetch: async () => undefined,
        }),
        useLikedPlaylistQuery: () => ({
            data: { total: 0, tracks: [] },
            isLoading: false,
            isError: false,
        }),
    },
});
mock.module("@/features/library/hooks/useSavedMusic", {
    namedExports: {
        useSavedMusicEntities: () => ({
            items: [],
            total: 0,
            isLoading: false,
            isError: false,
            hasNextPage: false,
            isFetchingNextPage: false,
            fetchNextPage: async () => undefined,
            refetch: async () => undefined,
        }),
    },
});
mock.module("@/features/device-offline/DeviceOfflineProvider", {
    namedExports: { useOptionalDeviceOffline: () => ({ records: [] }) },
});
mock.module("@/features/device-offline/components/DownloadsList", {
    namedExports: { DownloadsList: () => null },
});
mock.module("@/hooks/useNetworkOnline", {
    namedExports: { useNetworkOnline: () => true },
});
mock.module("next/link", {
    defaultExport: ({
        children,
        ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
        React.createElement("a", props, children),
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

test("CreatePlaylistDialog navigates only after its modal guard Back has completed", async () => {
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

    function Page() {
        const [isOpen, setOpen] = React.useState(true);
        return React.createElement(CreatePlaylistDialog, {
            isOpen,
            onClose: () => {
                closeCalls += 1;
                completionOrder.push("close");
                setOpen(false);
            },
            onCreated: (playlist: { id: string }) => {
                createdId = playlist.id;
                completionOrder.push("created");
            },
        });
    }
    await React.act(async () => root.render(React.createElement(Page)));

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
        (button) =>
            button.type === "submit" &&
            button.closest('[role="dialog"]') &&
            button.textContent?.includes("Создать плейлист"),
    );
    assert.ok(submit);
    await React.act(async () => {
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });

    assert.deepEqual(createCalls, [{ name: "Дорога домой", isPublic: false }]);
    assert.equal(
        createdId,
        null,
        "navigation cannot race the modal history Back",
    );
    assert.deepEqual(completionOrder, ["close"]);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
    await React.act(async () => flushHistoryBack());
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

async function submitNamedPlaylist(name: string) {
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
        setter.call(input, name);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = Array.from(document.body.querySelectorAll("button")).find(
        (button) =>
            button.type === "submit" &&
            button.closest('[role="dialog"]') &&
            button.textContent?.includes("Создать плейлист"),
    );
    assert.ok(submit);
    await React.act(async () => {
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

test("CreatePlaylistDialog without a navigation callback preserves ordinary close", async () => {
    const { createRoot } = await import("react-dom/client");
    const { CreatePlaylistDialog } =
        await import("../../features/playlist/components/CreatePlaylistDialog");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let closes = 0;
    function Page() {
        const [isOpen, setOpen] = React.useState(true);
        return React.createElement(CreatePlaylistDialog, {
            isOpen,
            onClose: () => {
                closes++;
                setOpen(false);
            },
        });
    }
    try {
        await React.act(async () => root.render(React.createElement(Page)));
        await submitNamedPlaylist("Обычный плейлист");
        assert.equal(closes, 1);
        assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
        assert.equal(pendingBack, 1);
        await React.act(async () => flushHistoryBack());
        assert.equal(window.location.pathname, "/library");
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

test("a malformed create response keeps the dialog open without publishing or navigating", async () => {
    const { createRoot } = await import("react-dom/client");
    const { CreatePlaylistDialog } =
        await import("../../features/playlist/components/CreatePlaylistDialog");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let closes = 0;
    let navigations = 0;
    let events = 0;
    const onEvent = () => events++;
    malformedResponse = true;
    window.addEventListener("playlist-created", onEvent);
    try {
        await React.act(async () =>
            root.render(
                React.createElement(CreatePlaylistDialog, {
                    isOpen: true,
                    onClose: () => closes++,
                    onCreated: () => navigations++,
                }),
            ),
        );
        await submitNamedPlaylist("Не завершён");
        assert.equal(closes, 0);
        assert.equal(navigations, 0);
        assert.equal(events, 0);
        assert.equal(pendingBack, 0);
        assert.ok(document.querySelector('[role="dialog"]'));
        assert.ok(document.querySelector('[role="alert"]'));
    } finally {
        malformedResponse = false;
        window.removeEventListener("playlist-created", onEvent);
        await React.act(async () => root.unmount());
        await React.act(async () => flushHistoryBack());
        container.remove();
    }
});

for (const query of ["1", "true"]) {
    test(`Library create=${query} performs one destination push after Back without an intermediate replace`, async () => {
        const { createRoot } = await import("react-dom/client");
        const { default: LibraryPage } = await import("../../app/library/page");
        createQuery = query;
        routerCalls.length = 0;
        historyEntries.splice(0, historyEntries.length, {
            state: { __NA: true, tree: "library" },
            url: `/library?tab=playlists&create=${query}`,
        });
        historyIndex = 0;
        originalReplace(historyEntries[0].state, "", historyEntries[0].url);
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await React.act(async () =>
                root.render(React.createElement(LibraryPage)),
            );
            await submitNamedPlaylist("Через ссылку");
            assert.deepEqual(
                routerCalls,
                [],
                "successful creation must not enqueue a competing Library replace",
            );
            assert.equal(
                document.querySelectorAll('[role="dialog"]').length,
                0,
                "successful close must dismiss the query-derived dialog before navigation",
            );
            assert.equal(pendingBack, 1);
            await React.act(async () => flushHistoryBack());
            assert.deepEqual(routerCalls, [
                { kind: "push", url: "/playlist/playlist-new" },
            ]);
            assert.equal(
                historyEntries[historyIndex - 1].url,
                "/library?tab=playlists",
                "Back from the destination must not reopen the consumed create deep link",
            );
            assert.deepEqual(historyEntries[historyIndex - 1].state, {
                __NA: true,
                tree: "library",
            });
            assert.equal(window.location.pathname, "/playlist/playlist-new");
            assert.deepEqual(window.history.state, {
                __NA: true,
                tree: "playlist",
            });
            await React.act(async () => {
                const entry = historyEntries[--historyIndex];
                originalReplace(entry.state, "", entry.url);
                createQuery = new URL(window.location.href).searchParams.get(
                    "create",
                );
                window.dispatchEvent(
                    new PopStateEvent("popstate", { state: entry.state }),
                );
                root.render(React.createElement(LibraryPage));
            });
            assert.equal(
                document.querySelectorAll('[role="dialog"]').length,
                0,
            );
            assert.equal(window.location.search, "?tab=playlists");
            await React.act(async () => {
                createQuery = query;
                window.history.pushState(
                    { __NA: true, tree: "library" },
                    "",
                    `/library?tab=playlists&create=${query}`,
                );
                root.render(React.createElement(LibraryPage));
            });
            assert.equal(
                document.querySelectorAll('[role="dialog"]').length,
                1,
                "a fresh deep-link intent must reopen the previously dismissed create dialog",
            );
        } finally {
            createQuery = null;
            await React.act(async () => root.unmount());
            if (pendingBack) await React.act(async () => flushHistoryBack());
            container.remove();
        }
    });
}

for (const action of ["cancel", "back", "escape"] as const) {
    test(`Library deep-link ${action} still clears the creation query without creating a playlist`, async () => {
        const { createRoot } = await import("react-dom/client");
        const { default: LibraryPage } = await import("../../app/library/page");
        createQuery = "1";
        routerCalls.length = 0;
        const callsBefore = createCalls.length;
        historyEntries.splice(
            0,
            historyEntries.length,
            { state: { __NA: true, tree: "home" }, url: "/" },
            {
                state: { __NA: true, tree: "library" },
                url: "/library?tab=playlists&create=1",
            },
        );
        historyIndex = 1;
        originalReplace(historyEntries[1].state, "", historyEntries[1].url);
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await React.act(async () =>
                root.render(React.createElement(LibraryPage)),
            );
            await React.act(async () => {
                if (action === "cancel") {
                    const cancel = Array.from(
                        document.querySelectorAll<HTMLButtonElement>(
                            '[role="dialog"] button',
                        ),
                    ).find((button) => button.textContent === "Отмена");
                    assert.ok(cancel);
                    cancel.dispatchEvent(
                        new MouseEvent("click", { bubbles: true }),
                    );
                } else if (action === "escape") {
                    window.dispatchEvent(
                        new KeyboardEvent("keydown", {
                            key: "Escape",
                            bubbles: true,
                        }),
                    );
                } else {
                    const entry = historyEntries[--historyIndex];
                    originalReplace(entry.state, "", entry.url);
                    window.dispatchEvent(
                        new PopStateEvent("popstate", { state: entry.state }),
                    );
                }
            });
            await React.act(async () =>
                root.render(React.createElement(LibraryPage)),
            );
            if (action !== "back") {
                assert.deepEqual(
                    routerCalls,
                    [],
                    "query cleanup must wait for native guard removal",
                );
                assert.equal(pendingBack, 1);
                await React.act(async () => flushHistoryBack());
            }
            assert.deepEqual(routerCalls, [
                { kind: "replace", url: "/library?tab=playlists" },
            ]);
            assert.deepEqual(window.history.state, {
                __NA: true,
                tree: "library",
            });
            assert.equal(
                historyIndex,
                1,
                "cleanup removes the guard rather than replacing its copy",
            );
            assert.equal(createCalls.length, callsBefore);
            assert.equal(
                document.querySelectorAll('[role="dialog"]').length,
                0,
            );
            assert.equal(window.location.search, "?tab=playlists");
            await React.act(async () => {
                const entry = historyEntries[--historyIndex];
                originalReplace(entry.state, "", entry.url);
                createQuery = new URL(window.location.href).searchParams.get(
                    "create",
                );
                window.dispatchEvent(
                    new PopStateEvent("popstate", { state: entry.state }),
                );
                root.render(React.createElement(LibraryPage));
            });
            assert.equal(window.location.pathname, "/");
            assert.equal(
                document.querySelectorAll('[role="dialog"]').length,
                0,
            );
            await React.act(async () => {
                createQuery = "1";
                window.history.pushState(
                    { __NA: true, tree: "library" },
                    "",
                    "/library?tab=playlists&create=1",
                );
                root.render(React.createElement(LibraryPage));
            });
            assert.equal(
                document.querySelectorAll('[role="dialog"]').length,
                1,
            );
        } finally {
            createQuery = null;
            await React.act(async () => root.unmount());
            if (pendingBack) await React.act(async () => flushHistoryBack());
            container.remove();
        }
    });
}

for (const action of ["cancel", "escape", "back"] as const) {
    test(`Library deep-link ${action} preserves a lower player until its own Back and cleans the real base`, async () => {
        const { createRoot } = await import("react-dom/client");
        const { default: LibraryPage } = await import("../../app/library/page");
        const { useDismissibleLayer } =
            await import("../../hooks/useDismissibleLayer");
        createQuery = "1";
        routerCalls.length = 0;
        let parentCloses = 0;
        historyEntries.splice(
            0,
            historyEntries.length,
            { state: { __NA: true, tree: "home" }, url: "/" },
            {
                state: { __NA: true, tree: "library" },
                url: "/library?tab=playlists&create=1",
            },
        );
        historyIndex = 1;
        originalReplace(historyEntries[1].state, "", historyEntries[1].url);
        function Parent() {
            const [open, setOpen] = React.useState(true);
            useDismissibleLayer(
                open,
                () => {
                    parentCloses++;
                    setOpen(false);
                },
                10,
            );
            return open
                ? React.createElement(
                      "section",
                      { "data-parent-layer": true },
                      "Lower player",
                  )
                : null;
        }
        const scene = () =>
            React.createElement(
                React.Fragment,
                null,
                React.createElement(LibraryPage),
                React.createElement(Parent),
            );
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await React.act(async () => root.render(scene()));
            await React.act(async () => {
                if (action === "cancel") {
                    const b = Array.from(
                        document.querySelectorAll<HTMLButtonElement>(
                            '[role="dialog"] button',
                        ),
                    ).find((b) => b.textContent === "Отмена");
                    assert.ok(b);
                    b.click();
                } else if (action === "escape")
                    window.dispatchEvent(
                        new KeyboardEvent("keydown", {
                            key: "Escape",
                            bubbles: true,
                        }),
                    );
                else {
                    const entry = historyEntries[--historyIndex];
                    originalReplace(entry.state, "", entry.url);
                    window.dispatchEvent(
                        new PopStateEvent("popstate", { state: entry.state }),
                    );
                }
            });
            assert.equal(
                document.querySelectorAll('[role="dialog"]').length,
                0,
            );
            assert.ok(document.querySelector("[data-parent-layer]"));
            assert.equal(parentCloses, 0);
            assert.deepEqual(routerCalls, []);
            assert.equal(pendingBack, 0);
            await React.act(async () => {
                const entry = historyEntries[--historyIndex];
                originalReplace(entry.state, "", entry.url);
                window.dispatchEvent(
                    new PopStateEvent("popstate", { state: entry.state }),
                );
                root.render(scene());
            });
            assert.equal(parentCloses, 1);
            assert.equal(document.querySelector("[data-parent-layer]"), null);
            assert.deepEqual(routerCalls, [
                { kind: "replace", url: "/library?tab=playlists" },
            ]);
            assert.deepEqual(window.history.state, {
                __NA: true,
                tree: "library",
            });
            assert.equal(historyIndex, 1);
            await React.act(async () => {
                const entry = historyEntries[--historyIndex];
                originalReplace(entry.state, "", entry.url);
                createQuery = null;
                window.dispatchEvent(
                    new PopStateEvent("popstate", { state: entry.state }),
                );
                root.render(scene());
            });
            assert.equal(window.location.pathname, "/");
            assert.equal(
                document.querySelectorAll('[role="dialog"]').length,
                0,
            );
        } finally {
            createQuery = null;
            await React.act(async () => root.unmount());
            if (pendingBack) await React.act(async () => flushHistoryBack());
            container.remove();
        }
    });
}
