import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls: string[] = [];
const redirectSignal = new Error("redirected");

mock.module("next/navigation", {
    namedExports: {
        redirect: (href: string) => {
            calls.push(href);
            throw redirectSignal;
        },
    },
});

test("legacy Explore entry redirects to the unified Home screen", async () => {
    calls.length = 0;
    const ExplorePage = (await import("../../app/explore/page")).default;

    assert.throws(() => ExplorePage(), redirectSignal);
    assert.deepEqual(calls, ["/"]);
});
