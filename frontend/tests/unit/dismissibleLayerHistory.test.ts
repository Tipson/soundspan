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
        pending: () => pending,
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

test("navigation waits for the asynchronous guard Back before pushing a destination", () => {
    const f = fixture();
    const events: string[] = [];
    const remove = f.layers.add(() => events.push("close"), 100);
    f.layers.navigateAfterDismiss(() => {
        events.push("navigate");
        f.runtime.push({ __NA: true, tree: "playlist" }, "/playlist/new");
    });
    assert.deepEqual(events, ["close"]);
    assert.equal(f.pending(), 1);
    remove();
    assert.equal(f.pending(), 1, "React cleanup cannot issue a second Back");
    f.flush();
    assert.deepEqual(events, ["close", "navigate"]);
    assert.equal(f.runtime.url(), "/playlist/new");
    assert.deepEqual(f.runtime.state(), { __NA: true, tree: "playlist" });
    assert.equal(f.pop(), false);
    assert.equal(f.runtime.url(), "/library");
    assert.deepEqual(f.runtime.state(), { __NA: true, tree: "library" });
});

test("navigation closes registered nested layers in visual priority order once", () => {
    const f = fixture();
    const events: string[] = [];
    const parent = f.layers.add(() => events.push("parent"), 10);
    const modal = f.layers.add(() => events.push("modal"), 100);
    const menu = f.layers.add(() => events.push("menu"), 200);
    f.layers.navigateAfterDismiss(() => events.push("navigate"));
    assert.deepEqual(events, ["menu", "modal", "parent"]);
    menu();
    modal();
    parent();
    f.flush();
    assert.deepEqual(events, ["menu", "modal", "parent", "navigate"]);
    assert.equal(f.pending(), 0);
});

test("the latest navigation intent reuses an already pending guard Back", () => {
    const f = fixture();
    const events: string[] = [];
    f.layers.add(() => events.push("close"), 100);
    f.layers.navigateAfterDismiss(() => events.push("stale"));
    f.layers.navigateAfterDismiss(() => events.push("latest"));
    assert.equal(f.pending(), 1);
    f.flush();
    assert.deepEqual(events, ["close", "latest"]);
});

test("navigation requested after button cleanup waits for the ongoing Back", () => {
    const f = fixture();
    let navigations = 0;
    f.layers.add(() => {}, 100)();
    f.layers.navigateAfterDismiss(() => navigations++);
    assert.equal(navigations, 0);
    assert.equal(f.pending(), 1);
    f.flush();
    assert.equal(navigations, 1);
});

test("opening a new layer cancels the queued navigation and preserves that layer", () => {
    const f = fixture();
    const events: string[] = [];
    f.layers.add(() => events.push("old"), 100);
    f.layers.navigateAfterDismiss(() => events.push("stale"));
    f.layers.add(() => events.push("new"), 100);
    f.flush();
    assert.deepEqual(events, ["old"]);
    assert.equal(f.pop(), true);
    assert.deepEqual(events, ["old", "new"]);
    assert.equal(f.runtime.url(), "/library");
});

test("an unrelated route traversal cancels navigation instead of redirecting it", () => {
    const f = fixture();
    let navigations = 0;
    f.layers.add(() => {}, 100);
    f.layers.navigateAfterDismiss(() => navigations++);
    assert.equal(f.pop(2), false);
    assert.equal(f.runtime.url(), "/");
    assert.equal(navigations, 0);
});

test("an intervening route push cancels the queued intent even when Back lands on its old guard", () => {
    const f = fixture();
    let navigations = 0;
    f.layers.add(() => {}, 100);
    f.layers.navigateAfterDismiss(() => navigations++);
    f.navigate();
    f.flush();
    assert.equal(navigations, 0);
    assert.equal(f.runtime.url(), "/library");
    assert.equal(f.pop(), false);
    assert.equal(f.runtime.url(), "/");
});

test("navigation without a layer runs immediately and does not add a history entry", () => {
    const f = fixture();
    let navigations = 0;
    f.layers.navigateAfterDismiss(() => navigations++);
    assert.equal(navigations, 1);
    assert.equal(f.pending(), 0);
    assert.equal(f.entries.length, 2);
});

test("a layer opened by a close callback cancels the old navigation without closing the new layer", () => {
    const f = fixture();
    const events: string[] = [];
    f.layers.add(() => {
        events.push("old");
        f.layers.add(() => events.push("new"), 100);
    }, 100);
    f.layers.navigateAfterDismiss(() => events.push("stale"));
    assert.deepEqual(events, ["old"]);
    assert.equal(f.pending(), 0);
    assert.equal(f.pop(), true);
    assert.deepEqual(events, ["old", "new"]);
});

test("a newer navigation requested by a close callback runs only once after Back", () => {
    const f = fixture();
    const events: string[] = [];
    f.layers.add(() => {
        events.push("close");
        f.layers.navigateAfterDismiss(() => events.push("latest"));
    }, 100);
    f.layers.navigateAfterDismiss(() => events.push("stale"));
    assert.deepEqual(events, ["close"]);
    assert.equal(f.pending(), 1);
    f.flush();
    assert.deepEqual(events, ["close", "latest"]);
    assert.equal(f.layers.onPop(), false);
    assert.deepEqual(events, ["close", "latest"]);
});

test("deferred URL cleanup preserves lower layers until their manual Back consumes the guard", () => {
    const f = fixture();
    const events: string[] = [];
    f.layers.add(() => events.push("parent"), 10);
    f.layers.add(() => events.push("modal"), 100);
    f.layers.dismiss();
    f.layers.navigateWhenLayersDismissed(() => {
        assert.deepEqual(f.runtime.state(), { __NA: true, tree: "library" });
        events.push("cleanup");
    });
    assert.deepEqual(events, ["modal"]);
    assert.equal(f.pending(), 0);
    assert.equal(f.pop(), true);
    assert.deepEqual(events, ["modal", "parent", "cleanup"]);
    assert.equal(f.pop(), false);
    assert.equal(f.runtime.url(), "/");
});

test("wait-only navigation reuses a pending Back and the latest intent runs once", () => {
    const f = fixture();
    const events: string[] = [];
    f.layers.add(() => {}, 100)();
    f.layers.navigateWhenLayersDismissed(() => events.push("stale"));
    f.layers.navigateWhenLayersDismissed(() => events.push("latest"));
    assert.equal(f.pending(), 1);
    assert.deepEqual(events, []);
    f.flush();
    assert.deepEqual(events, ["latest"]);
    f.layers.onPop();
    assert.deepEqual(events, ["latest"]);
});

test("a new layer cancels wait-only cleanup without being dismissed by that cleanup", () => {
    const f = fixture();
    const events: string[] = [];
    f.layers.add(() => events.push("parent"), 10);
    f.layers.navigateWhenLayersDismissed(() => events.push("stale"));
    f.layers.add(() => events.push("new"), 100);
    assert.deepEqual(events, []);
    f.pop();
    assert.deepEqual(events, ["new"]);
    f.pop();
    assert.deepEqual(events, ["new", "parent"]);
});

test("wait-only cleanup cancels on a different URL and runs immediately without any layer", () => {
    const f = fixture();
    let calls = 0;
    const remove = f.layers.add(() => {}, 10);
    f.layers.navigateWhenLayersDismissed(() => calls++);
    f.navigate();
    remove();
    assert.equal(calls, 0);
    assert.equal(f.runtime.url(), "/search");
    f.layers.navigateWhenLayersDismissed(() => calls++);
    assert.equal(calls, 1);
    assert.equal(f.pending(), 0);
});

test("wait-only intent survives an older pending Back while its remaining layer stays open", () => {
    const f = fixture();
    const events: string[] = [];
    f.layers.add(() => {}, 100)();
    f.layers.add(() => events.push("parent"), 10);
    f.layers.navigateWhenLayersDismissed(() => events.push("cleanup"));
    f.flush();
    assert.deepEqual(events, []);
    assert.equal(f.runtime.url(), "/library");
    assert.equal(f.pop(), true);
    assert.deepEqual(events, ["parent", "cleanup"]);
});
