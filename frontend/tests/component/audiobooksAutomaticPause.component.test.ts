import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const currentAudiobook = {
    id: "selected-book",
    title: "Selected book",
    author: "Author",
    coverUrl: null,
    duration: 180,
    progress: null,
};
const pauseCalls: unknown[] = [];
let query: { data: unknown; isLoading: boolean; error: Error | null } = {
    data: [],
    isLoading: false,
    error: null,
};
const router = { push: () => undefined };
mock.module("next/navigation", { namedExports: { useRouter: () => router } });
mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ isAuthenticated: true }) },
});
mock.module("@/lib/toast-context", {
    namedExports: { useToast: () => ({ toast: { error() {}, success() {} } }) },
});
mock.module("@/hooks/useQueries", {
    namedExports: { useAudiobooksQuery: () => query },
});
const pause = (options?: unknown) => {
    pauseCalls.push(options);
};
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({ currentAudiobook }),
        useAudioControls: () => ({ pause }),
    },
});
mock.module("@/components/ui/AudiobookCard", {
    namedExports: { AudiobookCard: () => null },
});
mock.module("@/components/ui/Button", {
    namedExports: {
        Button: ({ children }: { children?: React.ReactNode }) =>
            React.createElement("button", null, children),
    },
});
mock.module("@/components/ui/EmptyState", {
    namedExports: { EmptyState: () => null },
});
mock.module("@/components/ui/LoadingScreen", {
    namedExports: { LoadingScreen: () => null },
});
mock.module("@/components/layout/PageHeader", {
    namedExports: { PageHeader: () => null },
});

before(() => {
    GlobalRegistrator.register();
    (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => GlobalRegistrator.unregister());

for (const failure of ["query-error", "configured-false"] as const) {
    test(`audiobooks ${failure} pauses automatically and retains its storage-cleanup effect`, async () => {
        const { createRoot } = await import("react-dom/client");
        const { default: AudiobooksPage } =
            await import("../../app/audiobooks/page");
        localStorage.clear();
        localStorage.setItem(
            "soundspan_current_audiobook",
            JSON.stringify(currentAudiobook),
        );
        localStorage.setItem("soundspan_playback_type", "audiobook");
        query = { data: [], isLoading: false, error: null };
        pauseCalls.length = 0;
        const container = document.createElement("div");
        const root = createRoot(container);
        try {
            await React.act(async () =>
                root.render(React.createElement(AudiobooksPage)),
            );
            assert.deepEqual(pauseCalls, []);
            query =
                failure === "query-error"
                    ? {
                          ...query,
                          error: new Error("configuration unavailable"),
                      }
                    : { ...query, data: { configured: false } };
            await React.act(async () =>
                root.render(React.createElement(AudiobooksPage)),
            );
            assert.deepEqual(pauseCalls, [{ origin: "automatic" }]);
            assert.equal(
                localStorage.getItem("soundspan_current_audiobook"),
                null,
            );
            assert.equal(localStorage.getItem("soundspan_playback_type"), null);
        } finally {
            await React.act(async () => root.unmount());
            container.remove();
            localStorage.clear();
        }
    });
}
