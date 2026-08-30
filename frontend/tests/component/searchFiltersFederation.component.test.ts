import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("SearchFilters renders the supported result views as query-preserving links", async () => {
    const { SearchFilters } =
        await import("../../features/search/components/SearchFilters");
    const html = renderToStaticMarkup(
        React.createElement(SearchFilters, {
            activeView: "tracks",
            query: "massive attack",
            hasSearched: true,
        }),
    );

    assert.match(html, /aria-label="Search result type"/);
    assert.match(html, /href="\/search\?q=massive%20attack">All<\/a>/);
    assert.match(
        html,
        /aria-current="page"[^>]*href="\/search\?q=massive%20attack&amp;view=tracks"[^>]*>Tracks<\/a>/,
    );
    assert.match(
        html,
        /href="\/search\?q=massive%20attack&amp;view=artists"[^>]*>Artists<\/a>/,
    );
    assert.match(
        html,
        /href="\/search\?q=massive%20attack&amp;view=albums"[^>]*>Albums<\/a>/,
    );
    assert.doesNotMatch(
        html,
        />My Library<|>Discover<|>Peers<|>Soulseek<|>Playlists<|>Genres</,
    );
});

test("SearchFilters stays hidden until a search query is active", async () => {
    const { SearchFilters } =
        await import("../../features/search/components/SearchFilters");
    const html = renderToStaticMarkup(
        React.createElement(SearchFilters, {
            activeView: "all",
            query: "",
            hasSearched: false,
        }),
    );
    assert.equal(html, "");
});
