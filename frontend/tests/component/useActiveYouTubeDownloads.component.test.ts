/**
 * Wiring tests for useActiveYouTubeDownloads: the YouTube downloads list is
 * an admin-only backend surface, so the hook must not poll it (enabled:false
 * to react-query) unless the authenticated user is an admin — otherwise
 * every non-admin session would 403-spam /api/youtube/downloads.
 */
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type CapturedQueryOptions = {
    enabled?: boolean;
    refetchInterval?: (query: {
        state: { data: unknown };
    }) => number | false;
};

const state = {
    role: "admin" as string | undefined,
    isAuthenticated: true,
    queryOptions: [] as CapturedQueryOptions[],
};

const reactQueryExports = {
    useQuery: (options: CapturedQueryOptions) => {
        state.queryOptions.push(options);
        return {
            data: [],
            isLoading: false,
            refetch: async () => undefined,
        };
    },
    useMutation: () => ({ mutate: () => undefined }),
    useQueryClient: () => ({
        invalidateQueries: async () => undefined,
    }),
};

mock.module("@tanstack/react-query", { namedExports: reactQueryExports });
// tsx loads the hook's react-query import through the package's CJS build,
// which the bare-specifier mock above does not intercept — register the
// mock against the resolved file as well.
mock.module(
    new URL(
        "../../node_modules/@tanstack/react-query/build/modern/index.cjs",
        import.meta.url
    ).href,
    { namedExports: reactQueryExports }
);

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getYouTubeDownloads: async () => [],
            cancelYouTubeDownload: async () => undefined,
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({
            error: () => undefined,
        }),
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: state.isAuthenticated,
            user: state.role ? { role: state.role } : null,
        }),
    },
});

beforeEach(() => {
    state.role = "admin";
    state.isAuthenticated = true;
    state.queryOptions = [];
});

async function renderHook(options?: { enabled?: boolean }) {
    const { useActiveYouTubeDownloads } = await import(
        "../../hooks/useActiveYouTubeDownloads"
    );
    const Probe = () => {
        useActiveYouTubeDownloads(options);
        return null;
    };
    renderToStaticMarkup(React.createElement(Probe));
    const captured = state.queryOptions.at(-1);
    assert.ok(captured, "useQuery should have been called");
    return captured;
}

test("polls for admins by default", async () => {
    const options = await renderHook();
    assert.equal(options.enabled, true);
});

test("does not poll for non-admin users", async () => {
    state.role = "user";
    const options = await renderHook();
    assert.equal(options.enabled, false);
    assert.equal(options.refetchInterval?.({ state: { data: [] } }), false);
});

test("does not poll when unauthenticated", async () => {
    state.role = undefined;
    state.isAuthenticated = false;
    const options = await renderHook();
    assert.equal(options.enabled, false);
});

test("explicit enabled:false wins even for admins", async () => {
    const options = await renderHook({ enabled: false });
    assert.equal(options.enabled, false);
});
