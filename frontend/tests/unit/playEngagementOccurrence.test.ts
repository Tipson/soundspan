import assert from "node:assert/strict";
import test from "node:test";
import { createPlayEngagementOccurrenceResolver } from "../../components/player/hooks/playEngagementOccurrence";

const first = {
    recordingKey: "youtube:song",
    rowKey: "youtube:song\u0000playlist-item:one",
    localOccurrence: 1,
    currentIndex: 4,
    collaborative: false,
};
test("solo queue index remapping retains one logical run", () => {
    const resolver = createPlayEngagementOccurrenceResolver();
    const a = resolver.observe(first);
    assert.deepEqual(resolver.observe({ ...first, currentIndex: 3 }), a);
    assert.deepEqual(resolver.observe({ ...first, currentIndex: 0 }), a);
});
test("a true committed adjacent duplicate stays distinct after an earlier index remap", () => {
    const resolver = createPlayEngagementOccurrenceResolver();
    const a = resolver.observe({ ...first, rowKey: first.recordingKey });
    assert.equal(
        resolver.observe({
            ...first,
            rowKey: first.recordingKey,
            currentIndex: 0,
        }).key,
        a.key,
    );
    const b = resolver.observe({
        ...first,
        rowKey: first.recordingKey,
        localOccurrence: 2,
        currentIndex: 1,
    });
    assert.notEqual(b.key, a.key);
    assert.equal(b.journal, true);
});
test("same object/source/index with a new committed counter is a distinct selection", () => {
    const resolver = createPlayEngagementOccurrenceResolver();
    assert.notEqual(
        resolver.observe(first).key,
        resolver.observe({ ...first, localOccurrence: 2 }).key,
    );
});
test("source and playlist row changes remain distinct without relying on display metadata", () => {
    const resolver = createPlayEngagementOccurrenceResolver();
    const a = resolver.observe(first);
    const b = resolver.observe({
        ...first,
        rowKey: "youtube:song\u0000playlist-item:two",
    });
    const c = resolver.observe({
        ...first,
        recordingKey: "youtube:other",
        rowKey: "youtube:other",
    });
    assert.notEqual(a.key, b.key);
    assert.notEqual(b.key, c.key);
});
test("same-source join and leave retain the prior run key and selected solo cohort", () => {
    const resolver = createPlayEngagementOccurrenceResolver();
    const a = resolver.observe(first);
    assert.deepEqual(
        resolver.observe({
            ...first,
            rowKey: first.recordingKey,
            currentIndex: 0,
            collaborative: true,
        }),
        a,
    );
    assert.deepEqual(resolver.observe({ ...first, currentIndex: 9 }), a);
});
test("new group occurrences keep legacy index semantics and remain legacy after leaving", () => {
    const resolver = createPlayEngagementOccurrenceResolver();
    const a = resolver.observe({ ...first, collaborative: true });
    const b = resolver.observe({
        ...first,
        collaborative: true,
        currentIndex: 5,
    });
    assert.equal(a.journal, false);
    assert.equal(b.journal, false);
    assert.notEqual(a.key, b.key);
    assert.deepEqual(resolver.observe({ ...first, currentIndex: 0 }), b);
    assert.equal(
        resolver.observe({ ...first, currentIndex: 0, localOccurrence: 2 })
            .journal,
        true,
    );
});
test("completion retires the old key so a repeated same-song run adopts the current cohort", () => {
    const resolver = createPlayEngagementOccurrenceResolver();
    const a = resolver.observe(first);
    resolver.observe({ ...first, collaborative: true });
    resolver.finish();
    const b = resolver.observe({ ...first, collaborative: true });
    assert.notEqual(a.key, b.key);
    assert.equal(b.journal, false);
});
test("an empty media/type context retires its key and cannot authorize a journal", () => {
    const resolver = createPlayEngagementOccurrenceResolver();
    const a = resolver.observe(first);
    assert.deepEqual(
        resolver.observe({ ...first, recordingKey: null, rowKey: null }),
        { key: null, journal: false },
    );
    assert.notEqual(resolver.observe(first).key, a.key);
});
test("invalid counter data cannot become an occurrence or revive an earlier run", () => {
    for (const localOccurrence of [NaN, -1, 1.5, Infinity]) {
        const resolver = createPlayEngagementOccurrenceResolver();
        resolver.observe(first);
        assert.deepEqual(resolver.observe({ ...first, localOccurrence }), {
            key: null,
            journal: false,
        });
    }
});
