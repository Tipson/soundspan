import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSavedEntitySearchPage } from "../../features/search/savedEntitySearch";
import { getSavedMusicEntityHref } from "../../features/library/savedMusicEntity";

const request = { query: "Кино", type: "album" as const, offset: 0, limit: 50 };
const item = (source = "ytmusic", entityId = "MPREb_fixture") => ({
    id: `saved-${entityId}`,
    entityType: "album",
    source,
    entityId,
    title: "Сохранённый альбом",
    subtitle: "Кино",
    imageUrl: null,
});
const response = (items: unknown[], total = items.length) => ({
    items,
    total,
    search: { query: request.query, offset: 0, limit: 50 },
});

test("saved search preserves exact supported browse identities and distinct sources", () => {
    const parsed = parseSavedEntitySearchPage(
        response([
            item(),
            item("library", "same-id"),
            item("discovery", "same-id"),
            item(),
        ]),
        request,
    );
    assert.deepEqual(
        parsed.items.map((x) => [x.source, x.entityId]),
        [
            ["ytmusic", "MPREb_fixture"],
            ["library", "same-id"],
            ["discovery", "same-id"],
        ],
    );
    assert.equal(
        getSavedMusicEntityHref(parsed.items[0]),
        "/explore/yt-playlist/MPREb_fixture?type=album",
    );
    assert.equal(parsed.nextOffset, undefined);
});

test("legacy or mismatched query/page receipts never admit an unfiltered saved collection", () => {
    const good = response([item()]);
    for (const value of [
        { items: [item()], total: 1 },
        { ...good, search: { ...good.search, query: "Другой" } },
        { ...good, search: { ...good.search, offset: 50 } },
        { ...good, search: { ...good.search, limit: 100 } },
    ])
        assert.throws(() => parseSavedEntitySearchPage(value, request));
});

test("raw paging advances past unsupported or malformed rows without routing them as local", () => {
    const parsed = parseSavedEntitySearchPage(
        response(
            Array.from({ length: 50 }, (_, i) => item("vk", String(i))),
            51,
        ),
        request,
    );
    assert.deepEqual(parsed.items, []);
    assert.equal(parsed.nextOffset, 50);
    assert.equal(parsed.partial, true);
    const next = parseSavedEntitySearchPage(
        {
            items: [item()],
            total: 51,
            search: { query: "Кино", offset: 50, limit: 50 },
        },
        { ...request, offset: 50 },
    );
    assert.equal(next.items.length, 1);
    assert.equal(next.nextOffset, undefined);
});

test("valid matches survive bad rows but wrong kinds and unsafe artwork are rejected", () => {
    const parsed = parseSavedEntitySearchPage(
        response([
            null,
            item(),
            { ...item("library", "wrong-kind"), entityType: "artist" },
            { ...item("library", "bad-art"), imageUrl: "javascript:alert(1)" },
        ]),
        request,
    );
    assert.deepEqual(
        parsed.items.map((x) => x.entityId),
        ["MPREb_fixture"],
    );
    assert.equal(parsed.partial, true);
});

test("invalid counts and impossible empty raw windows cannot create a paging loop", () => {
    for (const value of [
        response([], 10),
        response([], -1),
        response([], 1.5),
        response([item()], Number.MAX_SAFE_INTEGER + 1),
    ]) {
        assert.throws(() => parseSavedEntitySearchPage(value, request));
    }
    const parsed = parseSavedEntitySearchPage(response([]), request);
    assert.equal(parsed.nextOffset, undefined);
});

test("a server offset ceiling retains matches and discloses a partial result", () => {
    const parsed = parseSavedEntitySearchPage(
        {
            items: [item()],
            total: 100002,
            search: { query: "Кино", offset: 100000, limit: 50 },
        },
        { ...request, offset: 100000 },
    );
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.nextOffset, undefined);
    assert.equal(parsed.partial, true);
});

test("valid multiline display metadata is retained without weakening opaque identity checks", () => {
    const row = { ...item(), title: "Первая\nчасть", subtitle: "Кино\t2010" };
    assert.equal(
        parseSavedEntitySearchPage(response([row]), request).items[0]?.title,
        row.title,
    );
    assert.deepEqual(
        parseSavedEntitySearchPage(
            response([{ ...row, entityId: "bad\nid" }]),
            request,
        ).items,
        [],
    );
});
