import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({ discovery: false, loading: false }),
    },
});

test("disabled weekly discovery remains a bounded product state", async () => {
    const { default: DiscoverWeeklyPage } =
        await import("../../app/discover/page");
    const html = renderToStaticMarkup(React.createElement(DiscoverWeeklyPage));

    assert.match(html, /data-utility-page="discover"/);
    assert.match(html, /data-page-header="editorial"/);
    assert.match(html, /Открытия недели/);
    assert.match(html, /Функция недоступна/);
    assert.match(html, /max-w-7xl/);
});
