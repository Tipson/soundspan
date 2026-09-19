import assert from "node:assert/strict";
import { test } from "node:test";
import { DismissibleLayerHistory } from "../../lib/dismissibleLayerHistory";

function fixture() {
    const entries = [
        { url: "/", state: {} },
        { url: "/library", state: { __NA: true, tree: "library" } },
    ];
    let index = 1;
    let pending = 0;
    const runtime = {
        url: () => entries[index].url,
        state: () => entries[index].state,
        push: (state: Record<string, unknown>, url?: string) => {
            entries.splice(++index);
            entries.push({ url: url ?? entries[index - 1].url, state });
        },
        back: () => {
            pending++;
        },
    };
    const layers = new DismissibleLayerHistory(runtime);
    return {
        layers,
        runtime,
        entries,
        pop: (steps = 1) => {
            index -= steps;
            return layers.onPop();
        },
        flush: () => {
            while (pending) {
                pending--;
                index--;
                layers.onPop();
            }
        },
        navigate: () => {
            entries.splice(++index);
            entries.push({ url: "/search", state: {} });
        },
    };
}

test("Back closes the upper layer before the player without navigating the base page", () => {
    const f = fixture();
    const closed: string[] = [];
    f.layers.add(() => closed.push("player"), 10);
    f.layers.add(() => closed.push("modal"), 100);
    assert.equal(f.pop(), true);
    assert.deepEqual(closed, ["modal"]);
    assert.equal(f.runtime.url(), "/library");
    assert.equal(f.pop(), true);
    assert.deepEqual(closed, ["modal", "player"]);
    assert.equal(f.runtime.url(), "/library");
    assert.equal(f.pop(), false);
    assert.equal(f.runtime.url(), "/");
});

test("Back skipping a guard restores the visible route and closes the player", () => {
    const f = fixture();
    let closed = 0;
    f.layers.add(() => closed++, 10);
    assert.equal(f.pop(2), true);
    assert.equal(closed, 1);
    assert.equal(f.runtime.url(), "/library");
    assert.equal(f.runtime.state().__NA, true);
    assert.equal(f.runtime.state().tree, "library");
    f.flush();
    assert.equal(f.runtime.url(), "/library");
    assert.equal(f.pop(), false);
    assert.equal(f.runtime.url(), "/");
});

test("Back skipping a guard still closes only the upper nested window", () => {
    const f = fixture();
    const closed: string[] = [];
    f.layers.add(() => closed.push("player"), 10);
    f.layers.add(() => closed.push("modal"), 100);
    assert.equal(f.pop(2), true);
    assert.deepEqual(closed, ["modal"]);
    assert.equal(f.runtime.url(), "/library");
    assert.equal(f.pop(), true);
    assert.deepEqual(closed, ["modal", "player"]);
    assert.equal(f.runtime.url(), "/library");
});

test("closing by a button removes the sentinel and preserves Next history state", () => {
    const f = fixture();
    const remove = f.layers.add(() => {}, 10);
    assert.equal(f.runtime.state().__NA, true);
    remove();
    f.flush();
    assert.equal(f.runtime.url(), "/library");
    assert.equal(f.pop(), false);
    assert.equal(f.runtime.url(), "/");
});

test("effect replay or quick reopen does not close a newly opened layer", () => {
    const f = fixture();
    let closed = 0;
    f.layers.add(() => {}, 10)();
    f.layers.add(() => closed++, 10);
    f.flush();
    assert.equal(closed, 0);
    f.pop();
    assert.equal(closed, 1);
    assert.equal(f.runtime.url(), "/library");
});

test("cleanup after a real link navigation does not go back from the destination", () => {
    const f = fixture();
    const remove = f.layers.add(() => {}, 10);
    f.navigate();
    remove();
    f.flush();
    assert.equal(f.runtime.url(), "/search");
    assert.equal(f.pop(), true);
    f.flush();
    assert.equal(f.runtime.url(), "/library");
    assert.equal(f.pop(), false);
    assert.equal(f.runtime.url(), "/");
});

test("Escape dismisses only the top layer even if child effects register first", () => {
    const f = fixture();
    const closed: string[] = [];
    f.layers.add(() => closed.push("modal"), 100);
    f.layers.add(() => closed.push("player"), 10);
    assert.equal(f.layers.dismiss(), true);
    assert.deepEqual(closed, ["modal"]);
    f.layers.dismiss();
    f.flush();
    assert.deepEqual(closed, ["modal", "player"]);
    assert.equal(f.runtime.url(), "/library");
});

test("opening a layer on another route does not strand an older history guard", () => {
    const f = fixture();
    const remove = f.layers.add(() => {}, 10);
    f.navigate();
    remove();
    f.layers.add(() => {}, 10)();
    f.flush();
    assert.equal(f.runtime.url(), "/search");
    assert.equal(f.pop(), true);
    f.flush();
    assert.equal(f.runtime.url(), "/library");
    assert.equal(f.pop(), false);
    assert.equal(f.runtime.url(), "/");
});
