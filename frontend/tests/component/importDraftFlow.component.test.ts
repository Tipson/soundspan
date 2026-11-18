import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { advanceAuthRuntimeGeneration } from "../../lib/auth-runtime-generation";
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const calls = {
    create: [] as any[],
    preview: [] as any[],
    confirm: [] as any[],
    cancel: [] as string[],
    get: [] as string[],
};
const entries = [
    {
        category: "playlists",
        title: "Repeated Song",
        groupId: "p0",
        position: 0,
    },
    {
        category: "playlists",
        title: "Repeated Song",
        groupId: "p0",
        position: 1,
    },
    {
        category: "playlists",
        title: "Unknown original",
        groupId: "p0",
        position: 2,
    },
    { category: "likes", title: "Liked", groupId: null, position: 0 },
    { category: "albums", title: "Saved album", groupId: null, position: 0 },
    { category: "artists", title: "Saved artist", groupId: null, position: 0 },
    {
        category: "dislikes",
        title: "Unproven Spotify negative",
        groupId: null,
        position: 0,
    },
].map((e, index) => ({
    id: "e" + index,
    artist: "Fixture Artist",
    album: null,
    sourceRef: {
        source: "spotify",
        type:
            e.category === "albums"
                ? "album"
                : e.category === "artists"
                  ? "artist"
                  : "track",
        entityId: "exact" + index,
    },
    unresolvedReason: null,
    ...e,
}));
const preview = {
    revision: 1,
    previewRevision: 2,
    mappingDigest: "a".repeat(64),
    rows: entries.map((e, i) => ({
        entryId: e.id,
        confidence: i === 2 ? 0 : 95,
        match:
            i === 4 || i === 5
                ? null
                : {
                      source: i === 2 ? "unresolved" : "local",
                      confidence: i === 2 ? 0 : 95,
                  },
        negativeId: null,
        unresolvedReason:
            i === 2
                ? "match_unavailable"
                : i === 6
                  ? "exact_negative_unavailable"
                  : null,
    })),
};
const base = {
    id: "draft-1",
    userId: "owner-a",
    sourceType: "file-spotify-json",
    playlistName: "Private export",
    draftRevision: 1,
    resolutionAttempt: 1,
    summary: { total: 5, local: 4, youtube: 0, tidal: 0, unresolved: 1 },
    status: "draft",
    draftData: {
        version: 1,
        normalized: {
            version: 1,
            format: "spotify-json",
            name: "Private export",
            sourceHash: "b".repeat(64),
            groups: [{ id: "p0", name: "Original playlist" }],
            entries,
        },
        preview: null,
    },
    confirmedSnapshot: null,
    draftResult: null,
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
let readJob: any,
    failConfirm = false,
    failCancel = false,
    failRead = false,
    heldCreate: Promise<any> | null = null;
mock.module("@/lib/api", {
    namedExports: {
        api: {
            createImportDraft: async (x: any) => {
                calls.create.push(clone(x));
                return heldCreate ? heldCreate : { job: clone(base) };
            },
            updateImportDraft: async (_id: string, x: any) => ({
                job: { ...clone(base), draftRevision: x.revision + 1 },
            }),
            previewImportDraft: async (id: string, revision: number) => {
                calls.preview.push({ id, revision });
                return { job: { ...clone(base), status: "previewing" } };
            },
            getImportDraft: async (id: string) => {
                calls.get.push(id);
                if (failRead) throw Error("not found");
                return { job: clone(readJob) };
            },
            confirmImportDraft: async (id: string, x: any) => {
                calls.confirm.push({ id, input: clone(x) });
                if (failConfirm) {
                    failConfirm = false;
                    throw Error("timeout");
                }
                return {
                    job: {
                        ...clone(readJob),
                        status: "completed",
                        confirmedSnapshot: { ...x, version: 1, confirmedAt: 1 },
                        draftResult: {
                            version: 1,
                            playlistIds: ["playlist-original"],
                            likes: 0,
                            albums: 0,
                            artists: 0,
                            dislikes: 0,
                            unresolved: [
                                {
                                    entryId: "e2",
                                    category: "playlists",
                                    reason: "match_unavailable",
                                },
                            ],
                            skipped: [],
                            invalidationPending: false,
                        },
                    },
                };
            },
            cancelImportJob: async (id: string) => {
                calls.cancel.push(id);
                if (failCancel) throw Error("network");
                return { job: { ...clone(readJob), status: "cancelled" } };
            },
        },
    },
});
after(() => GlobalRegistrator.unregister());
beforeEach(() => {
    for (const key of Object.keys(calls) as Array<keyof typeof calls>)
        calls[key].length = 0;
    readJob = {
        ...clone(base),
        status: "awaiting_confirmation",
        draftData: { ...clone(base.draftData), preview: clone(preview) },
    };
    heldCreate = null;
    failConfirm = false;
    failCancel = false;
    failRead = false;
    document.body.replaceChildren();
});
async function mount(id?: string) {
    const { ImportDraftFlow } =
        await import("../../components/activity/ImportDraftFlow");
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const client = new QueryClient();
    const render = async (nextId?: string) =>
        React.act(async () => {
            root.render(
                React.createElement(
                    QueryClientProvider,
                    { client },
                    React.createElement(ImportDraftFlow, {
                        initialDraftId: nextId,
                        onDraftCreated: () => undefined,
                    }),
                ),
            );
        });
    await render(id);
    return {
        host,
        render,
        close: async () => {
            await React.act(async () => root.unmount());
            host.remove();
        },
    };
}
function button(host: HTMLElement, label: string) {
    const b = [...host.querySelectorAll("button")].find((b) =>
        b.textContent?.includes(label),
    );
    assert.ok(b, "Missing button " + label);
    return b;
}
async function click(b: HTMLElement) {
    await React.act(async () => {
        b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });
}
async function paste(host: HTMLElement, text: string) {
    const input = host.querySelector("textarea");
    assert.ok(input);
    await React.act(async () => {
        Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
        )!.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}
test("file preview preserves original occurrences, confidence, unresolved intent and explicit NONE selection", async () => {
    const h = await mount();
    try {
        await paste(h.host, "Fixture Artist - Repeated Song");
        await click(button(h.host, "Сопоставить"));
        assert.equal(calls.create.length, 1);
        assert.deepEqual(calls.preview, [{ id: "draft-1", revision: 1 }]);
        assert.equal(calls.confirm.length, 0);
        await click(button(h.host, "Обновить состояние"));
        assert.equal(
            h.host.querySelectorAll('[data-import-entry="e0"]').length,
            1,
        );
        assert.equal(
            h.host.querySelectorAll('[data-import-entry="e1"]').length,
            1,
        );
        assert.match(h.host.textContent!, /95%/);
        assert.match(
            h.host.textContent!,
            /точного.*негатив|негативного.*точн/i,
        );
        const checks = [
            ...h.host.querySelectorAll<HTMLInputElement>(
                'input[type="checkbox"]',
            ),
        ];
        assert.equal(checks.length, 5);
        assert.ok(checks.every((c) => !c.checked));
        assert.equal(button(h.host, "Подтвердить").disabled, true);
        await click(checks[0]);
        await click(button(h.host, "Подтвердить"));
        assert.deepEqual(calls.confirm[0].input, {
            revision: 1,
            previewRevision: 2,
            mappingDigest: "a".repeat(64),
            categories: ["playlists"],
        });
        assert.match(h.host.textContent!, /Импорт завершён/);
        assert.match(h.host.textContent!, /Неразрешённые позиции: 1/);
    } finally {
        await h.close();
    }
});
test("uncertain confirmation retry keeps the identical immutable selection", async () => {
    const h = await mount("draft-1");
    try {
        await click(h.host.querySelector('input[type="checkbox"]')!);
        failConfirm = true;
        await click(button(h.host, "Подтвердить"));
        assert.ok(
            [
                ...h.host.querySelectorAll<HTMLInputElement>(
                    'input[type="checkbox"]',
                ),
            ].every((c) => c.disabled),
        );
        await click(button(h.host, "Повторить подтверждение"));
        assert.equal(calls.confirm.length, 2);
        assert.deepEqual(calls.confirm[0], calls.confirm[1]);
        assert.equal(calls.create.length, 0);
    } finally {
        await h.close();
    }
});
test("late owner create cannot preview or reveal private metadata after auth revocation", async () => {
    let release!: (x: any) => void;
    heldCreate = new Promise((r) => (release = r));
    const h = await mount();
    try {
        await paste(h.host, "Private owner title");
        await click(button(h.host, "Сопоставить"));
        await React.act(async () => {
            advanceAuthRuntimeGeneration();
            release({ job: clone(base) });
            await Promise.resolve();
            await Promise.resolve();
        });
        assert.equal(calls.preview.length, 0);
        assert.doesNotMatch(
            h.host.textContent!,
            /Private export|Private owner title/,
        );
        assert.equal(h.host.querySelector("textarea"), null);
    } finally {
        await h.close();
    }
});
test("oversized and invalid UTF8 files are rejected before reads/imports", async () => {
    const h = await mount();
    let reads = 0;
    try {
        const input = h.host.querySelector('input[type="file"]')!;
        const select = async (file: any) =>
            React.act(async () => {
                Object.defineProperty(input, "files", {
                    configurable: true,
                    value: [file],
                });
                input.dispatchEvent(new Event("change", { bubbles: true }));
                await Promise.resolve();
                await Promise.resolve();
            });
        await select({
            name: "large.json",
            size: 524289,
            arrayBuffer: async () => {
                reads++;
                return new ArrayBuffer(0);
            },
        });
        assert.equal(reads, 0);
        assert.match(h.host.textContent!, /512/);
        await select({
            name: "invalid.txt",
            size: 2,
            arrayBuffer: async () => new Uint8Array([255, 254]).buffer,
        });
        assert.match(h.host.textContent!, /UTF-8/);
        assert.equal(calls.create.length, 0);
    } finally {
        await h.close();
    }
});
test("failed cancellation retains the known draft and offers status refresh", async () => {
    const h = await mount("draft-1");
    try {
        failCancel = true;
        await click(button(h.host, "Отменить импорт"));
        assert.match(h.host.textContent!, /Private export/);
        assert.ok(button(h.host, "Обновить состояние"));
        failCancel = false;
        await click(button(h.host, "Отменить импорт"));
        assert.match(h.host.textContent!, /Импорт отменён/);
    } finally {
        await h.close();
    }
});

test("a persisted unpreviewed draft resumes matching without uploading a new job", async () => {
    readJob = clone(base);
    const h = await mount("draft-1");
    try {
        await click(button(h.host, "Сопоставить записи"));
        assert.deepEqual(calls.preview, [{ id: "draft-1", revision: 1 }]);
        assert.equal(calls.create.length, 0);
    } finally {
        await h.close();
    }
});

test("navigating to another unavailable draft cannot leave old confirmation controls", async () => {
    const h = await mount("draft-1");
    try {
        assert.match(h.host.textContent!, /Private export/);
        failRead = true;
        await h.render("other-draft");
        assert.doesNotMatch(
            h.host.textContent!,
            /Private export|Repeated Song/,
        );
        assert.equal(h.host.querySelector('input[type="checkbox"]'), null);
    } finally {
        await h.close();
    }
});
