import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getSharedResource: async () => {
                throw new Error("Untranslated backend share error");
            },
            scanLibrary: async () => {
                throw new Error("Untranslated backend scan error");
            },
        },
    },
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

test("первичная синхронизация показывает русское состояние сбоя", async () => {
    const SyncPage = (await import("../../app/sync/page")).default;
    const harness = await mountPage(SyncPage);
    try {
        assert.match(harness.container.textContent ?? "", /Всё готово/);
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
