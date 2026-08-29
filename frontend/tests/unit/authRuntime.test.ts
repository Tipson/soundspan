import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    MutationObserver,
    useQueryClient,
    type QueryClient,
} from "@tanstack/react-query";
import {
    applyOrderedOptimisticTrackPreferenceMutation,
    buildOptimisticTrackPreferenceResponse,
    completeOrderedTrackPreferenceMutation,
    type TrackPreferenceOptimisticQueryClient,
} from "../../hooks/trackPreferenceOptimistic";
import { revokeAuthenticatedRuntime } from "../../lib/auth-runtime";
import { getAuthRuntimeLease } from "../../lib/auth-runtime-generation";
import { getQueryClient, QueryProvider } from "../../lib/query-client";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
    localStorage.clear();
    revokeAuthenticatedRuntime({ notifyAuthProvider: false });
});

after(async () => {
    getQueryClient().clear();
    await GlobalRegistrator.unregister();
});

test("runtime revocation isolates late account A writes while fresh account B mutations still work", async () => {
    const accountAQueryClient = getQueryClient();
    const accountAPreferenceClient =
        accountAQueryClient as unknown as TrackPreferenceOptimisticQueryClient;
    const trackId = "yt:shared-track";
    const canonicalQueryKey = ["track-preference", trackId] as const;
    accountAQueryClient.setQueryData(
        canonicalQueryKey,
        buildOptimisticTrackPreferenceResponse(trackId, "clear"),
    );
    const accountA = applyOrderedOptimisticTrackPreferenceMutation(
        accountAPreferenceClient,
        trackId,
        "thumbs_up",
    );
    const failedAccountA = applyOrderedOptimisticTrackPreferenceMutation(
        accountAPreferenceClient,
        trackId,
        "thumbs_down",
    );

    revokeAuthenticatedRuntime({ notifyAuthProvider: false });
    const accountBQueryClient = getQueryClient();
    const accountBPreferenceClient =
        accountBQueryClient as unknown as TrackPreferenceOptimisticQueryClient;
    assert.notEqual(accountBQueryClient, accountAQueryClient);
    accountBQueryClient.setQueryData(
        canonicalQueryKey,
        buildOptimisticTrackPreferenceResponse(trackId, "clear"),
    );
    const accountB = applyOrderedOptimisticTrackPreferenceMutation(
        accountBPreferenceClient,
        trackId,
        "thumbs_down",
    );

    const lateAccountA = completeOrderedTrackPreferenceMutation(
        accountAPreferenceClient,
        accountA,
        {
            status: "success",
            preference: buildOptimisticTrackPreferenceResponse(
                trackId,
                "thumbs_up",
            ),
        },
    );
    assert.equal(lateAccountA.isLatest, false);
    assert.equal(
        completeOrderedTrackPreferenceMutation(
            accountAPreferenceClient,
            failedAccountA,
            { status: "error" },
        ).isLatest,
        false,
    );

    const failedAccountB = completeOrderedTrackPreferenceMutation(
        accountBPreferenceClient,
        accountB,
        { status: "error" },
    );
    assert.equal(failedAccountB.isLatest, true);
    assert.equal(failedAccountB.rollbackPreference?.signal, "clear");
    assert.notEqual(failedAccountB.rollbackPreference?.signal, "thumbs_up");

    accountBQueryClient.setQueryData(["account-private"], "account-b");
    accountAQueryClient.setQueryData(["account-private"], "late-account-a");
    assert.equal(
        accountBQueryClient.getQueryData(["account-private"]),
        "account-b",
    );

    const accountBMutation = new MutationObserver<string, Error, void>(
        accountBQueryClient,
        {
            mutationFn: async () => "fresh-account-b",
            onSuccess: (value) => {
                accountBQueryClient.setQueryData(["account-private"], value);
            },
        },
    );
    await accountBMutation.mutate();
    assert.equal(
        accountBQueryClient.getQueryData(["account-private"]),
        "fresh-account-b",
    );
    accountBMutation.reset();
});

test("runtime revocation synchronously aborts the retired auth lease", () => {
    const retired = getAuthRuntimeLease();

    revokeAuthenticatedRuntime({ notifyAuthProvider: false });

    const current = getAuthRuntimeLease();
    assert.equal(retired.signal.aborted, true);
    assert.equal(current.signal.aborted, false);
    assert.notEqual(current.generation, retired.generation);
});

test("QueryProvider publishes the fresh account B client after runtime rotation", async () => {
    const { createRoot } = await import("react-dom/client");
    const observedClients: QueryClient[] = [];

    function Probe() {
        observedClients.push(useQueryClient());
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await React.act(async () => {
            root.render(
                React.createElement(
                    QueryProvider,
                    null,
                    React.createElement(Probe),
                ),
            );
        });
        const accountAQueryClient = observedClients.at(-1);
        assert.ok(accountAQueryClient);

        await React.act(async () => {
            revokeAuthenticatedRuntime({ notifyAuthProvider: false });
        });

        const accountBQueryClient = observedClients.at(-1);
        assert.ok(accountBQueryClient);
        assert.notEqual(accountBQueryClient, accountAQueryClient);
        assert.equal(accountBQueryClient, getQueryClient());
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});
