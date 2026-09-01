import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const shareState = {
    fail: true,
    resource: {
        resourceType: "album" as const,
        resource: {
            id: "album-1",
            title: "Общий альбом с очень длинным названием",
            coverArt: null,
            artist: { id: "artist-1", name: "Исполнитель" },
            tracks: [
                {
                    id: "track-1",
                    title: "Первый трек",
                    duration: 180,
                    trackNo: 1,
                    discNo: 1,
                    album: {
                        title: "Общий альбом",
                        artist: {
                            id: "artist-1",
                            name: "Исполнитель",
                        },
                    },
                },
                {
                    id: "track-2",
                    title: "Второй трек",
                    duration: 200,
                    trackNo: 2,
                    discNo: 1,
                    album: {
                        title: "Общий альбом",
                        artist: {
                            id: "artist-1",
                            name: "Исполнитель",
                        },
                    },
                },
            ],
        },
    },
};

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getSharedResource: async () => {
                if (shareState.fail) {
                    throw new Error("Untranslated backend share error");
                }
                return shareState.resource;
            },
            scanLibrary: async () => {
                throw new Error("Untranslated backend scan error");
            },
        },
    },
});

beforeEach(() => {
    shareState.fail = true;
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ token: "expired-token" }),
        useRouter: () => ({ push: () => undefined }),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", props),
});

after(async () => {
    await GlobalRegistrator.unregister();
});

async function mountPage(Page: React.ComponentType) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(React.createElement(Page));
        await Promise.resolve();
        await Promise.resolve();
    });
    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("публичная общая ссылка показывает безопасную русскую ошибку", async () => {
    const SharePage = (await import("../../app/share/[token]/page")).default;
    const harness = await mountPage(SharePage);
    try {
        assert.match(harness.container.innerHTML, /role="alert"/);
        assert.match(harness.container.textContent ?? "", /Ссылка недоступна/);
        assert.match(
            harness.container.textContent ?? "",
            /Ссылка недействительна, истекла/,
        );
        assert.doesNotMatch(
            harness.container.textContent ?? "",
            /Untranslated backend share error/,
        );
    } finally {
        await harness.unmount();
    }
});

test("общая музыкальная ссылка использует editorial hero, action dock и доступные строки", async () => {
    shareState.fail = false;
    const SharePage = (await import("../../app/share/[token]/page")).default;
    const harness = await mountPage(SharePage);
    try {
        const html = harness.container.innerHTML;
        const hero = html.match(
            /<header[^>]*data-music-detail="hero"[\s\S]*?<\/header>/,
        )?.[0];
        assert.ok(hero);
        assert.match(hero, /Общий альбом с очень длинным названием/);
        assert.match(hero, /data-music-detail="actions"/);
        assert.match(hero, /data-detail-action-tier="primary"/);
        assert.match(hero, /data-detail-action-tier="secondary"/);
        assert.match(html, /data-music-detail="tracks"/);

        const downloadAll = html.match(
            /<a[^>]*download="soundspan-share\.zip"[^>]*>/,
        )?.[0];
        assert.ok(downloadAll);
        assert.match(downloadAll, /min-h-11/);

        const trackButtons = [
            ...html.matchAll(
                /<button[^>]*aria-label="Воспроизвести «(?:Первый|Второй) трек»"[^>]*>/g,
            ),
        ];
        assert.equal(trackButtons.length, 2);
        for (const button of trackButtons) {
            assert.match(button[0], /min-h-11/);
        }
    } finally {
        await harness.unmount();
    }
});

test("первичная синхронизация показывает русское состояние сбоя", async () => {
    const SyncPage = (await import("../../app/sync/page")).default;
    const harness = await mountPage(SyncPage);
    try {
        assert.match(
            harness.container.textContent ?? "",
            /Синхронизация приостановлена/,
        );
        assert.match(
            harness.container.textContent ?? "",
            /Не удалось запустить синхронизацию/,
        );
        assert.match(harness.container.textContent ?? "", /Пропустить/);
        assert.doesNotMatch(
            harness.container.textContent ?? "",
            /Untranslated backend scan error/,
        );
    } finally {
        await harness.unmount();
    }
});
