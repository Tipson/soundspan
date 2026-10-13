import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";

GlobalRegistrator.register({ url: "https://soundspan.test/settings" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ user: { id: "qa-user", username: "QA" } }),
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getProfilePictureUrl: () => "/api/social/profile-picture/qa-user",
        },
    },
});
after(() => GlobalRegistrator.unregister());

test("profile preview uses a cache query without changing the user image path", async () => {
    const { createRoot } = await import("react-dom/client");
    const { ProfilePictureUpload } =
        await import("../../features/settings/components/ui/ProfilePictureUpload");
    const container = document.createElement("div");
    const root = createRoot(container);
    await React.act(async () =>
        root.render(
            React.createElement(ProfilePictureUpload, {
                hasProfilePicture: true,
            }),
        ),
    );
    const image = container.querySelector<HTMLImageElement>(
        'img[alt="Фото профиля"]',
    );
    assert.ok(image);
    const url = new URL(image.src);
    assert.equal(url.pathname, "/api/social/profile-picture/qa-user");
    assert.equal(url.searchParams.get("_k"), "0");
    await React.act(async () => root.unmount());
});
