import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("empty search welcomes the listener into one unified music catalog", async () => {
    const { EmptyState } =
        await import("../../features/search/components/EmptyState");
    const html = renderToStaticMarkup(
        React.createElement(EmptyState, {
            hasSearched: false,
            isLoading: false,
        }),
    );

    assert.match(html, /data-search-welcome="true"/);
    assert.match(html, /Find anything you want to hear/);
    assert.match(html, /tracks, artists, and albums/i);
});

test("empty search stays out of the way after a query starts", async () => {
    const { EmptyState } =
        await import("../../features/search/components/EmptyState");

    assert.equal(
        renderToStaticMarkup(
            React.createElement(EmptyState, {
                hasSearched: true,
                isLoading: false,
            }),
        ),
        "",
    );
});
