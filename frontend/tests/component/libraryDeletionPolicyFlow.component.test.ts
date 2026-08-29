import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SystemSettings } from "../../features/settings/types";

GlobalRegistrator.register({ url: "https://soundspan.test/admin" });
after(() => GlobalRegistrator.unregister());

const icon = (name: string) => {
    const MockIcon = (props: Record<string, unknown> = {}) =>
        React.createElement("svg", { ...props, "data-icon": name });
    MockIcon.displayName = `MockIcon${name}`;
    return MockIcon;
};

mock.module("lucide-react", {
    namedExports: {
        Play: icon("play"),
        Pause: icon("pause"),
        Shuffle: icon("shuffle"),
        Download: icon("download"),
        ListMusic: icon("list-music"),
        Plus: icon("plus"),
        Share2: icon("share2"),
        Loader2: icon("loader2"),
        Search: icon("search"),
        Heart: icon("heart"),
        Check: icon("check"),
        Send: icon("send"),
        Trash2: icon("trash2"),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("sonner", {
    namedExports: { toast: { error: () => undefined } },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

mock.module("@/components/ui/ReleaseSelectionModal", {
    namedExports: { ReleaseSelectionModal: () => null },
});

mock.module("@/components/ui/ShareLinkModal", {
    namedExports: { ShareLinkModal: () => null },
});

test("an admin can enable a default-off deletion policy and reveal local album deletion", async () => {
    const [{ LibrarySafetySection }, { AlbumActionBar }] = await Promise.all([
        import("../../features/settings/components/sections/LibrarySafetySection"),
        import("../../features/album/components/AlbumActionBar"),
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function PolicyFlow() {
        const [deletionEnabled, setDeletionEnabled] = useState(false);
        const settings = {
            libraryDeletionEnabled: deletionEnabled,
        } as SystemSettings;

        return React.createElement(
            React.Fragment,
            null,
            React.createElement(LibrarySafetySection, {
                settings,
                onUpdate: (updates) =>
                    setDeletionEnabled(
                        updates.libraryDeletionEnabled ?? deletionEnabled,
                    ),
            }),
            React.createElement(AlbumActionBar, {
                album: {
                    id: "local-album",
                    title: "Local Album",
                    artist: { id: "artist", name: "Artist" },
                    owned: true,
                },
                source: "library",
                colors: null,
                onPlayAll: () => undefined,
                onAddAllToQueue: () => undefined,
                onShuffle: () => undefined,
                onDownloadAlbum: () => undefined,
                onAddToPlaylist: () => undefined,
                isPendingDownload: false,
                canDeleteFromLibrary: deletionEnabled,
                onDeleteAlbum: () => undefined,
            }),
        );
    }

    try {
        await React.act(async () =>
            root.render(React.createElement(PolicyFlow)),
        );

        assert.match(container.textContent ?? "", /Server Library Safety/);
        const policyToggle = container.querySelector<HTMLInputElement>(
            "#library-deletion-enabled",
        );
        assert.ok(policyToggle);
        assert.equal(policyToggle.checked, false);
        assert.equal(
            container.querySelector(
                '[aria-label="Delete album from server library"]',
            ),
            null,
        );

        await React.act(async () => policyToggle.click());

        assert.equal(policyToggle.checked, true);
        assert.ok(
            container.querySelector(
                '[aria-label="Delete album from server library"]',
            ),
        );
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});
