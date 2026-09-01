import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Activity: Icon,
        AlertTriangle: Icon,
        ArrowDownToLine: Icon,
        ArrowLeftRight: Icon,
        ArrowUpFromLine: Icon,
        Check: Icon,
        Clipboard: Icon,
        KeyRound: Icon,
        Link: Icon,
        Loader2: Icon,
        Network: Icon,
        Plus: Icon,
        RefreshCw: Icon,
        RotateCw: Icon,
        Server: Icon,
        Trash2: Icon,
        Unlink: Icon,
        X: Icon,
    },
});

const noop = () => undefined;

test("federation peer list renders its empty state", async () => {
    const { FederationPeersList } =
        await import("../../features/settings/components/sections/FederationSection");
    const html = renderToStaticMarkup(
        React.createElement(FederationPeersList, {
            peers: [],
            busyPeerId: null,
            onSync: noop,
            onRotate: noop,
            onRevoke: noop,
            onDelete: noop,
        }),
    );
    assert.match(html, /Нет связанных серверов/);
});

test("federation peer list renders active, offline, and revoked status chips", async () => {
    const { FederationPeersList } =
        await import("../../features/settings/components/sections/FederationSection");
    const basePeer = {
        direction: "CONSUMER" as const,
        baseUrl: "https://peer.example",
        scopes: ["library:read" as const, "stream:read" as const],
        inboundStatus: null,
        showDedupedCopies: false,
        maxConcurrentStreams: null,
        maxStreamKbps: null,
        lastSeenAt: "2026-08-15T12:00:00.000Z",
        lastSyncSuccessAt: null,
        lastSyncDurationMs: null,
        lastErrorAt: null,
        lastError: null,
        lastSyncCursor: null,
        catalogEpoch: null,
        createdAt: "2026-08-15T12:00:00.000Z",
        updatedAt: "2026-08-15T12:00:00.000Z",
    };
    const html = renderToStaticMarkup(
        React.createElement(FederationPeersList, {
            peers: [
                {
                    ...basePeer,
                    id: "active",
                    name: "Alpha",
                    outboundStatus: "ACTIVE" as const,
                },
                {
                    ...basePeer,
                    id: "offline",
                    name: "Beta",
                    outboundStatus: "OFFLINE" as const,
                },
                {
                    ...basePeer,
                    id: "revoked",
                    name: "Gamma",
                    outboundStatus: "REVOKED" as const,
                },
                {
                    ...basePeer,
                    id: "mutual",
                    name: "Delta",
                    direction: "BOTH" as const,
                    inboundStatus: "ACTIVE" as const,
                    outboundStatus: "OFFLINE" as const,
                },
            ],
            busyPeerId: null,
            onSync: noop,
            onRotate: noop,
            onRevoke: noop,
            onDelete: noop,
        }),
    );
    assert.match(html, /Alpha/);
    assert.match(html, /Активно/);
    assert.match(html, /Не в сети/);
    assert.match(html, /Отозвано/);
    assert.match(html, /library:read/);
    assert.match(html, /Делимся с ними/);
    assert.match(html, /Слушаем с их сервера/);
});

test("peer cards render only their own direction lines", async () => {
    const { FederationPeersList } =
        await import("../../features/settings/components/sections/FederationSection");
    const basePeer = {
        baseUrl: "https://peer.example",
        scopes: ["library:read" as const],
        inboundStatus: null,
        outboundStatus: null,
        showDedupedCopies: false,
        maxConcurrentStreams: null,
        maxStreamKbps: null,
        lastSeenAt: null,
        lastSyncSuccessAt: null,
        lastSyncDurationMs: null,
        lastErrorAt: null,
        lastError: null,
        lastSyncCursor: null,
        catalogEpoch: null,
        createdAt: "2026-08-15T12:00:00.000Z",
        updatedAt: "2026-08-15T12:00:00.000Z",
    };
    const hostHtml = renderToStaticMarkup(
        React.createElement(FederationPeersList, {
            peers: [
                {
                    ...basePeer,
                    id: "host-only",
                    name: "HostOnly",
                    direction: "HOST" as const,
                    inboundStatus: "ACTIVE" as const,
                },
            ],
            busyPeerId: null,
            onSync: noop,
            onRotate: noop,
            onRevoke: noop,
            onDelete: noop,
        }),
    );
    assert.match(hostHtml, /Делимся с ними/);
    assert.doesNotMatch(hostHtml, /Слушаем с их сервера/);

    const consumerHtml = renderToStaticMarkup(
        React.createElement(FederationPeersList, {
            peers: [
                {
                    ...basePeer,
                    id: "consumer-only",
                    name: "ConsumerOnly",
                    direction: "CONSUMER" as const,
                    outboundStatus: "ACTIVE" as const,
                },
            ],
            busyPeerId: null,
            onSync: noop,
            onRotate: noop,
            onRevoke: noop,
            onDelete: noop,
        }),
    );
    assert.match(consumerHtml, /Слушаем с их сервера/);
    assert.doesNotMatch(consumerHtml, /Делимся с ними/);

    const hostNoUrlHtml = renderToStaticMarkup(
        React.createElement(FederationPeersList, {
            peers: [
                {
                    ...basePeer,
                    baseUrl: null,
                    id: "host-no-url",
                    name: "HostNoUrl",
                    direction: "HOST" as const,
                    inboundStatus: "ACTIVE" as const,
                },
            ],
            busyPeerId: null,
            onSync: noop,
            onRotate: noop,
            onRevoke: noop,
            onDelete: noop,
        }),
    );
    assert.match(
        hostNoUrlHtml,
        /Нет удалённого URL — они подключаются к этому серверу/,
    );
});

test("one-time credential dialog shows the token and irreversible warning", async () => {
    const { OneTimeCredentialDialog } =
        await import("../../features/settings/components/sections/FederationSection");
    const html = renderToStaticMarkup(
        React.createElement(OneTimeCredentialDialog, {
            peerName: "Family server",
            token: "secret-once-token",
            onClose: noop,
        }),
    );
    assert.match(html, /secret-once-token/);
    assert.match(html, /больше не покажем/i);
    assert.match(html, /Скопировать токен/);
});

test("connect builder maps the explicit client-role payload", async () => {
    const { buildLinkPeerInput } =
        await import("../../features/settings/components/sections/federationPairing");

    assert.deepEqual(
        buildLinkPeerInput("Friend", "https://peer.example", "tok"),
        { baseUrl: "https://peer.example", token: "tok", name: "Friend" },
    );
    assert.deepEqual(buildLinkPeerInput("  ", "https://peer.example", "tok"), {
        baseUrl: "https://peer.example",
        token: "tok",
    });
});

test("host scope builder grants presence implicitly and embeddings on demand", async () => {
    const { buildHostScopes } =
        await import("../../features/settings/components/sections/federationPairing");

    assert.deepEqual(buildHostScopes({ embeddings: false }), [
        "library:read",
        "stream:read",
        "social:read",
    ]);
    assert.deepEqual(buildHostScopes({ embeddings: true }), [
        "library:read",
        "stream:read",
        "social:read",
        "embeddings:read",
    ]);
});

test("host credential form keeps presence implicit with an explanatory note", async () => {
    const { HostCredentialForm } =
        await import("../../features/settings/components/sections/federationPairing");
    const html = renderToStaticMarkup(
        React.createElement(HostCredentialForm, {
            onSubmit: async () => undefined,
            busy: false,
        }),
    );
    assert.match(html, /Также делиться эмбеддингами/);
    assert.match(html, /Делиться\s+статусом онлайн/);
    assert.doesNotMatch(html, /checkbox[^>]*>[^<]*online user status/);
});

test("federation error mapper prefers actionable code messages", async () => {
    const { federationErrorMessage } =
        await import("../../features/settings/components/sections/federationPairing");

    const unreachable = Object.assign(new Error("Request failed"), {
        data: { code: "FEDERATION_PEER_UNREACHABLE" },
    });
    assert.match(federationErrorMessage(unreachable), /Не удалось связаться/);

    const unauthorized = Object.assign(new Error("Request failed"), {
        data: { code: "FEDERATION_PEER_UNAUTHORIZED" },
    });
    assert.match(federationErrorMessage(unauthorized), /отозван или заменён/);

    // Pairing codes were removed: their error codes fall through to the
    // raw message instead of a dedicated mapping.
    const retiredCode = Object.assign(new Error("Request failed"), {
        data: { code: "FEDERATION_CODE_EXPIRED" },
    });
    assert.equal(
        federationErrorMessage(retiredCode),
        "Не удалось выполнить запрос федерации",
    );

    assert.equal(
        federationErrorMessage(new Error("plain message")),
        "Не удалось выполнить запрос федерации",
    );
    assert.equal(
        federationErrorMessage(null),
        "Не удалось выполнить запрос федерации",
    );
});

test("explicit pairing panel presents share and connect roles", async () => {
    const { FederationAddPanel } =
        await import("../../features/settings/components/sections/federationPairing");
    const html = renderToStaticMarkup(
        React.createElement(FederationAddPanel, {
            busy: false,
            onHost: async () => undefined,
            onLink: async () => undefined,
        }),
    );
    assert.match(html, /Поделиться моей медиатекой/);
    assert.match(html, /Подключиться к медиатеке/);
    assert.match(html, /Выдать данные доступа/);
    assert.match(html, /Подключить по токену/);
    assert.match(html, /Двусторонний обмен состоит из двух отдельных шагов/);
    assert.doesNotMatch(html, /pairing code/i);
    assert.doesNotMatch(html, /also share this library back/i);
});
