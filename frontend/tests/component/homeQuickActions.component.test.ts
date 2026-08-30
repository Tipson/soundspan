import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = () => React.createElement("i");

mock.module("lucide-react", {
    namedExports: {
        ArrowDownToLine: Icon,
        Clock3: Icon,
        Heart: Icon,
        Search: Icon,
    },
});

test("home quick actions expose the four everyday music routes", async () => {
    const { HomeQuickActions } =
        await import("../../features/home/components/HomeQuickActions");
    const html = renderToStaticMarkup(React.createElement(HomeQuickActions));

    assert.match(html, /Your shortcuts/);
    assert.match(html, /aria-label="Your shortcuts"/);
    assert.match(html, /href="\/playlist\/my-liked"[^>]*>[\s\S]*Liked songs/);
    assert.match(html, /href="\/my-history"[^>]*>[\s\S]*Listening history/);
    assert.match(html, /href="\/import"[^>]*>[\s\S]*Import playlists/);
    assert.match(html, /href="\/search"[^>]*>[\s\S]*Search music/);
});
