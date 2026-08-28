import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MutationObserver } from "@tanstack/react-query";
import { WithAuth } from "../../lib/api/auth";
import { ApiClientCore } from "../../lib/api/core";
import {
    readCachedAuthUser,
    writeCachedAuthUser,
} from "../../lib/auth-offline-session";
import { getQueryClient } from "../../lib/query-client";

GlobalRegistrator.register();

class TestAuthClient extends WithAuth(ApiClientCore) {}

const originalFetch = globalThis.fetch;

beforeEach(() => {
    localStorage.clear();
    getQueryClient().clear();
});

after(() => {
    if (originalFetch) {
        globalThis.fetch = originalFetch;
    } else {
        Reflect.deleteProperty(globalThis, "fetch");
    }
    GlobalRegistrator.unregister();
});

function mockJsonResponse(
    testContext: TestContext,
    responseBody: unknown,
): ReturnType<TestContext["mock"]["method"]> {
    return testContext.mock.method(globalThis, "fetch", async () =>
        Response.json(responseBody),
    );
}

const loginResponse = {
    token: "access-token",
    refreshToken: "refresh-token",
    user: {
        id: "user-1",
        username: "listener",
        displayName: "Listener",
        role: "user",
    },
};

function seedAccountAState(
    client: TestAuthClient,
    queryClient = getQueryClient(),
): void {
    client.setToken("access-a", "refresh-a");
    writeCachedAuthUser({
        id: "user-a",
        username: "alice",
        role: "user",
        onboardingComplete: true,
    });
    localStorage.setItem("soundspan_playback_owner_id", "user-a");
    localStorage.setItem("soundspan_current_track", '{"id":"track-a"}');
    queryClient.setQueryData(["account-private"], "account-a");
}

test("getAuthConfig reads the public authentication capabilities", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, {
        localLoginEnabled: true,
        oidcEnabled: true,
        oidcProviderName: "Acme ID",
    });
    const client = new TestAuthClient("http://soundspan.test");

    const result = await client.getAuthConfig();

    assert.deepEqual(result, {
        localLoginEnabled: true,
        oidcEnabled: true,
        oidcProviderName: "Acme ID",
    });
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(
        String(fetchMock.mock.calls[0].arguments[0]),
        "http://soundspan.test/api/auth/config",
    );
});

test("startOidcLink requests a JSON navigation response", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, {
        redirectUrl: "https://idp.example/authorize?state=state-1",
    });
    const client = new TestAuthClient("http://soundspan.test");

    const result = await client.startOidcLink();

    assert.equal(
        result.redirectUrl,
        "https://idp.example/authorize?state=state-1",
    );
    const request = fetchMock.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(request.method, "POST");
    assert.equal(request.body, JSON.stringify({ responseMode: "json" }));
});

test("identity and app-password methods use the authenticated auth routes", async (testContext) => {
    const responses = [
        { identities: [] },
        { message: "Identity unlinked" },
        { appPasswords: [] },
        {
            appPassword: {
                id: "app-1",
                displayName: "Phone",
                createdAt: "2026-08-15T12:00:00.000Z",
                lastUsedAt: null,
                secret: "ssap_secret",
            },
        },
        { message: "App password revoked" },
    ];
    const fetchMock = testContext.mock.method(globalThis, "fetch", async () =>
        Response.json(responses.shift()),
    );
    const client = new TestAuthClient("http://soundspan.test");

    await client.getExternalIdentities();
    await client.unlinkExternalIdentity("identity/1");
    await client.listAppPasswords();
    const created = await client.createAppPassword("Phone");
    await client.revokeAppPassword("app/1");

    assert.equal(created.appPassword.secret, "ssap_secret");
    assert.deepEqual(
        fetchMock.mock.calls.map((call) => String(call.arguments[0])),
        [
            "http://soundspan.test/api/auth/identities",
            "http://soundspan.test/api/auth/identities/identity%2F1",
            "http://soundspan.test/api/auth/app-passwords",
            "http://soundspan.test/api/auth/app-passwords",
            "http://soundspan.test/api/auth/app-passwords/app%2F1",
        ],
    );
    const createRequest = fetchMock.mock.calls[3].arguments[1] as RequestInit;
    assert.equal(createRequest.method, "POST");
    assert.equal(createRequest.body, JSON.stringify({ displayName: "Phone" }));
});

test("exchangeOidcCode stores both login tokens", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, loginResponse);
    const client = new TestAuthClient("http://soundspan.test");

    const user = await client.exchangeOidcCode("exchange-code");

    assert.deepEqual(user, loginResponse.user);
    assert.equal(localStorage.getItem("auth_token"), "access-token");
    assert.equal(localStorage.getItem("refresh_token"), "refresh-token");
    const request = fetchMock.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(request.method, "POST");
    assert.equal(request.credentials, "include");
    assert.equal(request.body, JSON.stringify({ code: "exchange-code" }));
});

test("confirmOidcLink stores tokens after credential confirmation", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, loginResponse);
    const client = new TestAuthClient("http://soundspan.test");

    const result = await client.confirmOidcLink({
        linkToken: "link-token",
        password: "correct horse battery staple",
        twoFactorToken: "123456",
    });

    assert.deepEqual(result, loginResponse.user);
    assert.equal(localStorage.getItem("auth_token"), "access-token");
    assert.equal(localStorage.getItem("refresh_token"), "refresh-token");
    const request = fetchMock.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(request.credentials, "include");
    assert.equal(
        request.body,
        JSON.stringify({
            linkToken: "link-token",
            password: "correct horse battery staple",
            twoFactorToken: "123456",
        }),
    );
});

test("confirmOidcLink returns a 2FA challenge without storing tokens", async (testContext) => {
    mockJsonResponse(testContext, {
        requires2FA: true,
        message: "2FA token required",
    });
    const client = new TestAuthClient("http://soundspan.test");

    const result = await client.confirmOidcLink({
        linkToken: "link-token",
        password: "correct horse battery staple",
    });

    assert.deepEqual(result, {
        requires2FA: true,
        message: "2FA token required",
    });
    assert.equal(localStorage.getItem("auth_token"), null);
    assert.equal(localStorage.getItem("refresh_token"), null);
});

test("redeemOidcInvite stores tokens after successful provisioning", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, loginResponse);
    const client = new TestAuthClient("http://soundspan.test");

    const user = await client.redeemOidcInvite({
        inviteToken: "invite-token",
        inviteCode: "INVITE42",
    });

    assert.deepEqual(user, loginResponse.user);
    assert.equal(localStorage.getItem("auth_token"), "access-token");
    assert.equal(localStorage.getItem("refresh_token"), "refresh-token");
    const request = fetchMock.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(request.credentials, "include");
    assert.equal(
        request.body,
        JSON.stringify({
            inviteToken: "invite-token",
            inviteCode: "INVITE42",
        }),
    );
});

test("credential-producing auth flows clear account A state before storing account B", async (testContext) => {
    mockJsonResponse(testContext, loginResponse);
    const queryClient = getQueryClient();
    const client = new TestAuthClient("http://soundspan.test");
    seedAccountAState(client);

    await client.exchangeOidcCode("exchange-code");

    assert.equal(client.getToken(), "access-token");
    assert.equal(readCachedAuthUser(), null);
    assert.equal(localStorage.getItem("soundspan_playback_owner_id"), null);
    assert.equal(localStorage.getItem("soundspan_current_track"), null);
    assert.equal(queryClient.getQueryData(["account-private"]), undefined);
});

test("account replacement retires a pending account A mutation before its callbacks can repopulate account B cache", async (testContext) => {
    mockJsonResponse(testContext, loginResponse);
    const queryClient = getQueryClient();
    const client = new TestAuthClient("http://soundspan.test");
    seedAccountAState(client);

    let resolveMutation!: (value: string) => void;
    const mutationObserver = new MutationObserver<string, Error, void>(
        queryClient,
        {
            mutationFn: () =>
                new Promise<string>((resolve) => {
                    resolveMutation = resolve;
                }),
            onSuccess: (value) => {
                queryClient.setQueryData(["account-private"], value);
            },
            onError: () => {
                queryClient.setQueryData(["account-private"], "rollback-a");
            },
        },
    );
    const pendingMutation = mutationObserver.mutate();
    await Promise.resolve();

    await client.exchangeOidcCode("exchange-code");
    resolveMutation("late-account-a");

    await assert.rejects(pendingMutation);
    assert.equal(queryClient.getQueryData(["account-private"]), undefined);
    mutationObserver.reset();
});

test("account replacement suppresses a late account A mutation rollback", async (testContext) => {
    mockJsonResponse(testContext, loginResponse);
    const queryClient = getQueryClient();
    const client = new TestAuthClient("http://soundspan.test");
    seedAccountAState(client);

    let rejectMutation!: (reason: Error) => void;
    const mutationObserver = new MutationObserver<string, Error, void>(
        queryClient,
        {
            mutationFn: () =>
                new Promise<string>((_resolve, reject) => {
                    rejectMutation = reject;
                }),
            onError: () => {
                queryClient.setQueryData(["account-private"], "rollback-a");
            },
        },
    );
    const pendingMutation = mutationObserver.mutate();
    await Promise.resolve();

    await client.exchangeOidcCode("exchange-code");
    rejectMutation(new Error("late account A failure"));

    await assert.rejects(pendingMutation);
    assert.equal(queryClient.getQueryData(["account-private"]), undefined);
    mutationObserver.reset();
});

test("account replacement isolates account B from post-await optimistic writes by account A", async (testContext) => {
    mockJsonResponse(testContext, loginResponse);
    const accountAQueryClient = getQueryClient();
    const client = new TestAuthClient("http://soundspan.test");
    seedAccountAState(client);

    let releaseOptimisticWrite!: () => void;
    const optimisticWriteBlocked = new Promise<void>((resolve) => {
        releaseOptimisticWrite = resolve;
    });
    const mutationObserver = new MutationObserver<string, Error, void>(
        accountAQueryClient,
        {
            mutationFn: async () => "account-a-result",
            onMutate: async () => {
                await optimisticWriteBlocked;
                accountAQueryClient.setQueryData(
                    ["post-await-private"],
                    "late-account-a",
                );
            },
        },
    );
    const pendingMutation = mutationObserver.mutate();
    await Promise.resolve();

    await client.exchangeOidcCode("exchange-code");
    const accountBQueryClient = getQueryClient();
    assert.notEqual(accountBQueryClient, accountAQueryClient);
    accountBQueryClient.setQueryData(["post-await-private"], "account-b");
    releaseOptimisticWrite();

    await assert.rejects(pendingMutation);
    assert.equal(
        accountBQueryClient.getQueryData(["post-await-private"]),
        "account-b",
    );
    mutationObserver.reset();
});

test("account replacement cancels a pending account A query before it can populate account B cache", async (testContext) => {
    mockJsonResponse(testContext, loginResponse);
    const queryClient = getQueryClient();
    const client = new TestAuthClient("http://soundspan.test");
    seedAccountAState(client);

    let resolveQuery!: (value: string) => void;
    const pendingQuery = queryClient.fetchQuery({
        queryKey: ["pending-account-private"],
        queryFn: () =>
            new Promise<string>((resolve) => {
                resolveQuery = resolve;
            }),
    });
    const retiredQuery = assert.rejects(pendingQuery);
    await Promise.resolve();

    await client.exchangeOidcCode("exchange-code");
    resolveQuery("late-account-a");

    await retiredQuery;
    assert.equal(
        queryClient.getQueryData(["pending-account-private"]),
        undefined,
    );
});

test("confirm, invite, and registration credential flows clear account A state", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, loginResponse);
    const flows: Array<(client: TestAuthClient) => Promise<unknown>> = [
        (client) =>
            client.confirmOidcLink({
                linkToken: "link-token",
                password: "password-a",
            }),
        (client) =>
            client.redeemOidcInvite({
                inviteToken: "invite-token",
                inviteCode: "INVITE42",
            }),
        (client) =>
            client.register({
                inviteCode: "INVITE42",
                username: "listener",
                displayName: "Listener",
                password: "password-b",
                confirmPassword: "password-b",
                email: "listener@example.test",
            }),
    ];

    for (const runFlow of flows) {
        localStorage.clear();
        const queryClient = getQueryClient();
        queryClient.clear();
        const client = new TestAuthClient("http://soundspan.test");
        seedAccountAState(client, queryClient);

        await runFlow(client);

        assert.equal(client.getToken(), "access-token");
        assert.equal(readCachedAuthUser(), null);
        assert.equal(localStorage.getItem("soundspan_playback_owner_id"), null);
        assert.equal(localStorage.getItem("soundspan_current_track"), null);
        assert.equal(queryClient.getQueryData(["account-private"]), undefined);
    }
    assert.equal(fetchMock.mock.callCount(), flows.length);
});

test("a superseded API response cannot reach an account B success callback", async (testContext) => {
    let resolveResponse!: (response: Response) => void;
    testContext.mock.method(
        globalThis,
        "fetch",
        () =>
            new Promise<Response>((resolve) => {
                resolveResponse = resolve;
            }),
    );
    const client = new TestAuthClient("http://soundspan.test");
    client.setToken("access-a", "refresh-a");
    let successCallbackCalled = false;

    const pendingRequest = client
        .get<{ account: string }>("/account-private")
        .then((response) => {
            successCallbackCalled = true;
            return response;
        });
    await Promise.resolve();

    client.setToken("access-b", "refresh-b");
    resolveResponse(Response.json({ account: "account-a" }));

    await assert.rejects(pendingRequest, {
        name: "SupersededAuthSessionError",
    });
    assert.equal(successCallbackCalled, false);
});

test("an access-only replacement token cannot retain account A refresh credentials", () => {
    const client = new TestAuthClient("http://soundspan.test");
    client.setToken("access-a", "refresh-a");

    // Both the legacy URL-token and onboarding flows install an access-only
    // replacement through this public seam.
    client.setToken("access-b");

    assert.equal(client.getToken(), "access-b");
    assert.equal(client.getRefreshToken(), null);
    assert.equal(localStorage.getItem("refresh_token"), null);
});

test("late OIDC and registration responses cannot overwrite a newer credential", async (testContext) => {
    let resolveResponse!: (response: Response) => void;
    testContext.mock.method(
        globalThis,
        "fetch",
        () =>
            new Promise<Response>((resolve) => {
                resolveResponse = resolve;
            }),
    );
    const flows: Array<(client: TestAuthClient) => Promise<unknown>> = [
        (client) => client.exchangeOidcCode("exchange-code"),
        (client) =>
            client.confirmOidcLink({
                linkToken: "link-token",
                password: "password-a",
            }),
        (client) =>
            client.redeemOidcInvite({
                inviteToken: "invite-token",
                inviteCode: "INVITE42",
            }),
        (client) =>
            client.register({
                inviteCode: "INVITE42",
                username: "listener",
                displayName: "Listener",
                password: "password-b",
                confirmPassword: "password-b",
                email: "listener@example.test",
            }),
    ];

    for (const runFlow of flows) {
        const client = new TestAuthClient("http://soundspan.test");
        client.setToken("access-a", "refresh-a");
        const pendingFlow = runFlow(client);
        await Promise.resolve();

        client.setToken("access-newer", "refresh-newer");
        resolveResponse(Response.json(loginResponse));
        await assert.rejects(pendingFlow, {
            name: "SupersededAuthSessionError",
        });

        assert.equal(client.getToken(), "access-newer");
        assert.equal(localStorage.getItem("auth_token"), "access-newer");
        assert.equal(localStorage.getItem("refresh_token"), "refresh-newer");
    }
});

test("a late logout response cannot clear a replacement session", async (testContext) => {
    let resolveLogout!: (response: Response) => void;
    const fetchMock = testContext.mock.method(
        globalThis,
        "fetch",
        () =>
            new Promise<Response>((resolve) => {
                resolveLogout = resolve;
            }),
    );
    const client = new TestAuthClient("http://soundspan.test");
    client.setToken("access-a", "refresh-a");

    const logout = client.logout();
    await Promise.resolve();
    assert.equal(fetchMock.mock.callCount(), 1);

    client.setToken("access-b", "refresh-b");
    resolveLogout(new Response(null, { status: 204 }));
    await logout;

    assert.equal(client.getToken(), "access-b");
    assert.equal(localStorage.getItem("auth_token"), "access-b");
    assert.equal(localStorage.getItem("refresh_token"), "refresh-b");
});

test("logout still clears the session when no replacement occurs", async (testContext) => {
    mockJsonResponse(testContext, null);
    const client = new TestAuthClient("http://soundspan.test");
    client.setToken("access-a", "refresh-a");

    await client.logout();

    assert.equal(client.getToken(), null);
    assert.equal(localStorage.getItem("auth_token"), null);
    assert.equal(localStorage.getItem("refresh_token"), null);
});

test("a superseded login response is rejected before it can publish user data", async (testContext) => {
    let resolveLogin!: (response: Response) => void;
    testContext.mock.method(
        globalThis,
        "fetch",
        () =>
            new Promise<Response>((resolve) => {
                resolveLogin = resolve;
            }),
    );
    const client = new TestAuthClient("http://soundspan.test");
    client.clearToken();

    const login = client.login("listener", "password");
    await Promise.resolve();
    client.clearToken();
    resolveLogin(Response.json(loginResponse));
    await assert.rejects(login, {
        name: "SupersededAuthSessionError",
    });

    assert.equal(client.getToken(), null);
    assert.equal(localStorage.getItem("auth_token"), null);
    assert.equal(localStorage.getItem("refresh_token"), null);
});
