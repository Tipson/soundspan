import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) => {
        capturedImageProps = props;
        return React.createElement("span", {
            "data-testid": "next-image",
            "data-src": String(props.src),
        });
    },
});

let capturedImageProps: Record<string, unknown> | null = null;

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    document.body.replaceChildren();
    capturedImageProps = null;
});

test("CachedImage replaces a failed thumbnail and retries when src changes", async () => {
    const { CachedImage } = await import("../../components/ui/CachedImage");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(CachedImage, {
                src: "/api/library/cover-art?url=broken",
                alt: "Broken cover",
                width: 40,
                height: 40,
            }),
        );
    });

    assert.ok(container.querySelector('[data-testid="next-image"]'));
    assert.ok(capturedImageProps);
    const onError = capturedImageProps.onError;
    assert.equal(typeof onError, "function");

    await React.act(async () => {
        (onError as (event: unknown) => void)({ currentTarget: null });
    });
    assert.equal(container.querySelector('[data-testid="next-image"]'), null);
    assert.equal(
        container.querySelector('[role="img"]')?.getAttribute("aria-label"),
        "Artwork unavailable for Broken cover",
    );

    await React.act(async () => {
        root.render(
            React.createElement(CachedImage, {
                src: "/api/library/cover-art?url=recovered",
                alt: "Recovered cover",
                width: 40,
                height: 40,
            }),
        );
    });
    assert.equal(
        container
            .querySelector('[data-testid="next-image"]')
            ?.getAttribute("data-src"),
        "/api/library/cover-art?url=recovered",
    );

    await React.act(async () => root.unmount());
    container.remove();
});

test("CachedImage replaces a failed thumbnail with the provided fallback", async () => {
    const { CachedImage } = await import("../../components/ui/CachedImage");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(CachedImage, {
                src: "/api/library/cover-art?url=broken",
                alt: "Broken cover",
                width: 40,
                height: 40,
                fallback: React.createElement(
                    "span",
                    { role: "img", "aria-label": "Artwork unavailable" },
                    "No artwork",
                ),
            }),
        );
    });

    assert.ok(capturedImageProps);
    const onError = capturedImageProps.onError;
    assert.equal(typeof onError, "function");
    await React.act(async () => {
        (onError as (event: unknown) => void)({ currentTarget: null });
    });

    assert.equal(
        container.querySelector('[role="img"]')?.getAttribute("aria-label"),
        "Artwork unavailable",
    );

    await React.act(async () => root.unmount());
    container.remove();
});
