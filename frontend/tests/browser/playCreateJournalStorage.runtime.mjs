/** Run from frontend with Node24; uses installed Chrome and real same-origin IndexedDB. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.resolve("package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const bundle = await build({
    stdin: {
        contents: `import * as journal from "./lib/playCreateJournalStorage"; globalThis.PlayJournal = journal;`,
        resolveDir: process.cwd(),
        loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    logLevel: "silent",
});
const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/module.js") {
        response.setHeader("Content-Type", "application/javascript");
        response.end(bundle.outputFiles[0].text);
    } else {
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><script src="/module.js"></script>');
    }
});
let browser;
let passed = 0;
let failed = 0;
async function check(name, run) {
    try {
        await run();
        passed++;
        console.log(`PASS ${name}`);
    } catch (error) {
        failed++;
        console.error(`FAIL ${name}:`, error);
    }
}
try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    const factory = await page.evaluate(
        () => typeof globalThis.PlayJournal?.createPlayCreateJournalStorage,
    );
    assert.equal(
        factory,
        "function",
        "private atomic journal storage is required",
    );
    const prepare = async (target, databaseName) =>
        target.evaluate((name) => {
            globalThis.scope = {
                ownerId: "alice",
                loginNonce: "A".repeat(32),
                historyEpoch: 4,
            };
            globalThis.authorized = true;
            globalThis.store =
                globalThis.PlayJournal.createPlayCreateJournalStorage({
                    databaseName: name,
                    isCurrent: (value) =>
                        globalThis.authorized &&
                        value.ownerId === globalThis.scope.ownerId &&
                        value.loginNonce === globalThis.scope.loginNonce &&
                        value.historyEpoch === globalThis.scope.historyEpoch,
                });
            globalThis.key = `p1.4.${(1_800_000_000_000).toString(36)}.${"K".repeat(32)}`;
            globalThis.payload = {
                source: "youtube",
                wireJson: JSON.stringify({
                    youtubeVideoId: "video-1",
                    title: "Song",
                    artist: "Artist",
                    album: "Album",
                    duration: 180,
                }),
            };
        }, databaseName);
    await check(
        "verified owner lease survives another same-login tab activation",
        async () => {
            await prepare(page, "play-journal-native-lease");
            const result = await page.evaluate(async () => {
                const first = await store.activateLease(scope, "L".repeat(32));
                const second = await store.activateLease(scope, "M".repeat(32));
                return { first, second };
            });
            assert.ok(result.first, "fresh owner must receive a durable lease");
            assert.deepEqual(result.second, result.first);
        },
    );
    await check(
        "two tabs reserve one create; final before ACK is retained atomically",
        async () => {
            const name = "play-journal-native-race";
            await prepare(page, name);
            const other = await context.newPage();
            try {
                await other.goto(origin);
                await prepare(other, name);
                const lease = await page.evaluate(() =>
                    store.activateLease(scope, "L".repeat(32)),
                );
                assert.ok(lease);
                await other.evaluate(async () => {
                    globalThis.lease = await store.activateLease(
                        scope,
                        "M".repeat(32),
                    );
                });
                await page.evaluate((value) => {
                    globalThis.lease = value;
                }, lease);
                assert.equal(
                    await page.evaluate(() =>
                        store.insertReady(lease, { key, payload }),
                    ),
                    true,
                );
                const reservations = await Promise.all([
                    page.evaluate(() =>
                        store.reserveCreate(
                            lease,
                            key,
                            "X".repeat(32),
                            1_800_000_000_000,
                        ),
                    ),
                    other.evaluate(() =>
                        store.reserveCreate(
                            lease,
                            key,
                            "Y".repeat(32),
                            1_800_000_000_000,
                        ),
                    ),
                ]);
                assert.equal(reservations.filter(Boolean).length, 1);
                const claim = reservations.find(Boolean);
                assert.equal(
                    await page.evaluate(() =>
                        store.mergeEngagement(
                            lease,
                            key,
                            {
                                listenedSeconds: 95,
                                completionRatio: 0.6,
                                outcome: "meaningful",
                            },
                            true,
                        ),
                    ),
                    true,
                );
                assert.equal(
                    await page.evaluate(
                        ({ token }) =>
                            store.acknowledgeCreate(
                                lease,
                                key,
                                token,
                                "play-1",
                            ),
                        { token: claim.createClaim.token },
                    ),
                    true,
                );
                const rows = await other.evaluate(() => store.list(lease));
                assert.equal(rows.length, 1);
                assert.equal(rows[0].state, "known");
                assert.equal(rows[0].playId, "play-1");
                assert.equal(rows[0].final, true);
                assert.deepEqual(rows[0].totals, {
                    listenedSeconds: 95,
                    completionRatio: 0.6,
                    outcome: "meaningful",
                });
                assert.equal(rows[0].engagementRevision, 1);
                assert.equal(rows[0].ackRevision, 0);
            } finally {
                await other.close();
            }
        },
    );
    await check(
        "PATCH ACK retains non-final row and cannot delete a later final revision",
        async () => {
            await prepare(page, "play-journal-native-patch");
            const result = await page.evaluate(async () => {
                const lease = await store.activateLease(scope, "L".repeat(32));
                if (!lease) return null;
                await store.insertReady(lease, { key, payload });
                await store.reserveCreate(
                    lease,
                    key,
                    "C".repeat(32),
                    1_800_000_000_000,
                );
                await store.acknowledgeCreate(
                    lease,
                    key,
                    "C".repeat(32),
                    "play-1",
                );
                await store.mergeEngagement(
                    lease,
                    key,
                    {
                        listenedSeconds: 10,
                        completionRatio: 0.1,
                        outcome: "skipped",
                    },
                    false,
                );
                const first = await store.reservePatch(
                    lease,
                    key,
                    "P".repeat(32),
                    1_800_000_000_000,
                );
                await store.acknowledgePatch(
                    lease,
                    key,
                    first.patchClaim.token,
                );
                const retained = await store.list(lease);
                await store.mergeEngagement(
                    lease,
                    key,
                    {
                        listenedSeconds: 20,
                        completionRatio: 0.2,
                        outcome: "skipped",
                    },
                    false,
                );
                const second = await store.reservePatch(
                    lease,
                    key,
                    "Q".repeat(32),
                    1_800_000_000_000,
                );
                await store.mergeEngagement(
                    lease,
                    key,
                    {
                        listenedSeconds: 180,
                        completionRatio: 1,
                        outcome: "completed",
                    },
                    true,
                );
                await store.acknowledgePatch(
                    lease,
                    key,
                    second.patchClaim.token,
                );
                const late = await store.list(lease);
                const third = await store.reservePatch(
                    lease,
                    key,
                    "R".repeat(32),
                    1_800_000_000_000,
                );
                await store.acknowledgePatch(
                    lease,
                    key,
                    third.patchClaim.token,
                );
                return { retained, late, final: await store.list(lease) };
            });
            assert.ok(result);
            assert.equal(result.retained.length, 1);
            assert.equal(result.retained[0].ackRevision, 1);
            assert.equal(result.late.length, 1);
            assert.equal(result.late[0].ackRevision, 2);
            assert.equal(result.late[0].engagementRevision, 3);
            assert.deepEqual(result.final, []);
        },
    );
    await check(
        "history revoke fences stale activation and same-user relogin cannot adopt its rows",
        async () => {
            await prepare(page, "play-journal-native-revoke");
            const result = await page.evaluate(async () => {
                const old = await store.activateLease(scope, "L".repeat(32));
                if (!old) return null;
                await store.insertReady(old, { key, payload });
                await store.reserveCreate(
                    old,
                    key,
                    "C".repeat(32),
                    1_800_000_000_000,
                );
                await store.retireLease(old);
                const staleActivation = await store.activateLease(
                    scope,
                    "M".repeat(32),
                );
                scope = { ...scope, historyEpoch: 5 };
                const fresh = await store.activateLease(scope, "N".repeat(32));
                const oldAck = await store.acknowledgeCreate(
                    old,
                    key,
                    "C".repeat(32),
                    "old-play",
                );
                scope = { ...scope, loginNonce: "B".repeat(32) };
                const relogin = await store.activateLease(
                    scope,
                    "O".repeat(32),
                );
                await store.retireLease(old);
                return {
                    staleActivation,
                    fresh,
                    oldAck,
                    relogin,
                    rows: await store.list(relogin),
                };
            });
            assert.ok(result);
            assert.equal(result.staleActivation, null);
            assert.ok(result.fresh);
            assert.equal(result.oldAck, false);
            assert.ok(result.relogin);
            assert.deepEqual(result.rows, []);
        },
    );
    await check(
        "restart keeps the exact unknown DTO; claims expire without exceeding three reservations",
        async () => {
            const name = "play-journal-native-restart";
            await prepare(page, name);
            const result = await page.evaluate(async () => {
                const lease = await store.activateLease(scope, "L".repeat(32));
                await store.insertReady(lease, { key, payload });
                const first = await store.reserveCreate(
                    lease,
                    key,
                    "C".repeat(32),
                    1_800_000_000_000,
                );
                await store.close();
                store = PlayJournal.createPlayCreateJournalStorage({
                    databaseName: "play-journal-native-restart",
                    isCurrent: () => authorized,
                });
                const restored = await store.activateLease(
                    scope,
                    "M".repeat(32),
                );
                const tooSoon = await store.reserveCreate(
                    restored,
                    key,
                    "D".repeat(32),
                    1_800_000_000_001,
                );
                const second = await store.reserveCreate(
                    restored,
                    key,
                    "D".repeat(32),
                    1_800_000_120_000,
                );
                const oldAck = await store.acknowledgeCreate(
                    restored,
                    key,
                    "C".repeat(32),
                    "late",
                );
                const third = await store.reserveCreate(
                    restored,
                    key,
                    "E".repeat(32),
                    1_800_000_240_000,
                );
                const fourth = await store.reserveCreate(
                    restored,
                    key,
                    "F".repeat(32),
                    1_800_000_360_000,
                );
                return {
                    first,
                    restored,
                    tooSoon,
                    second,
                    oldAck,
                    third,
                    fourth,
                    rows: await store.list(restored),
                };
            });
            assert.equal(result.tooSoon, null);
            assert.equal(result.first.key, result.second.key);
            assert.equal(result.first.wireJson, result.third.wireJson);
            assert.equal(result.second.createAttempts, 2);
            assert.equal(result.third.createAttempts, 3);
            assert.equal(result.oldAck, false);
            assert.equal(result.fourth, null);
            assert.equal(result.rows[0].state, "terminal");
        },
    );
    await check(
        "durable failure holdoff blocks another row and survives a reload",
        async () => {
            await prepare(page, "play-journal-native-holdoff");
            assert.equal(
                await page.evaluate(() => typeof store.settleFailure),
                "function",
                "journal must durably release only the matching failed claim",
            );
            const result = await page.evaluate(async () => {
                const lease = await store.activateLease(scope, "L".repeat(32));
                const key2 = key.slice(0, -32) + "J".repeat(32);
                await store.insertReady(lease, { key, payload });
                await store.insertReady(lease, { key: key2, payload });
                await store.reserveCreate(
                    lease,
                    key,
                    "C".repeat(32),
                    1_800_000_000_000,
                );
                const settled = await store.settleFailure(lease, key, {
                    kind: "create",
                    token: "C".repeat(32),
                    serverNowMs: 1_800_000_000_010,
                    retryAfterUntilMs: 1_800_000_030_000,
                    shared: true,
                    terminal: false,
                });
                await store.close();
                store = PlayJournal.createPlayCreateJournalStorage({
                    databaseName: "play-journal-native-holdoff",
                    isCurrent: () => authorized,
                });
                const restored = await store.activateLease(
                    scope,
                    "M".repeat(32),
                );
                const blocked = await store.reserveCreate(
                    restored,
                    key2,
                    "D".repeat(32),
                    1_800_000_029_999,
                );
                const allowed = await store.reserveCreate(
                    restored,
                    key2,
                    "E".repeat(32),
                    1_800_000_030_000,
                );
                const late = await store.settleFailure(restored, key2, {
                    kind: "create",
                    token: "D".repeat(32),
                    serverNowMs: 1_800_000_030_001,
                    retryAfterUntilMs: 1_800_000_060_000,
                    shared: true,
                    terminal: true,
                });
                return { settled, blocked, allowed, late };
            });
            assert.equal(result.settled, true);
            assert.equal(result.blocked, null);
            assert.ok(result.allowed);
            assert.equal(result.late, false);
        },
    );
    await check(
        "owner revocation before IDB completion writes nothing; inputs are captured before awaits",
        async () => {
            await prepare(page, "play-journal-native-revoked-open");
            const result = await page.evaluate(async () => {
                const alice = { ...scope };
                scope = {
                    ownerId: "bob",
                    loginNonce: "B".repeat(32),
                    historyEpoch: 4,
                };
                await store.activateLease(scope, "B".repeat(32));
                scope = alice;
                const captured = { ...scope };
                const pending = store.activateLease(captured, "L".repeat(32));
                captured.ownerId = "bob";
                captured.loginNonce = "B".repeat(32);
                const lease = await pending;
                const write = store.insertReady(lease, { key, payload });
                authorized = false;
                const denied = await write;
                authorized = true;
                return { lease, denied, rows: await store.list(lease) };
            });
            assert.equal(result.lease.ownerId, "alice");
            assert.equal(result.denied, false);
            assert.deepEqual(result.rows, []);
        },
    );
    await check(
        "100-row bound never evicts a pending run; extra fields and URL-bearing DTOs are rejected",
        async () => {
            await prepare(page, "play-journal-native-capacity");
            const result = await page.evaluate(async () => {
                const lease = await store.activateLease(scope, "L".repeat(32));
                let accepted = 0;
                for (let i = 0; i < 101; i++)
                    if (
                        await store.insertReady(lease, {
                            key:
                                key.slice(0, -32) +
                                i.toString(36).padStart(32, "0"),
                            payload,
                        })
                    )
                        accepted++;
                const other = PlayJournal.createPlayCreateJournalStorage({
                    databaseName: "play-journal-native-projection",
                    isCurrent: () => true,
                });
                const otherLease = await other.activateLease(
                    scope,
                    "M".repeat(32),
                );
                const invalid = await other.insertReady(otherLease, {
                    key,
                    payload: {
                        source: "youtube",
                        wireJson: JSON.stringify({
                            ...JSON.parse(payload.wireJson),
                            mediaUrl: "https://secret.invalid",
                        }),
                    },
                });
                const rows = await store.list(lease);
                await other.close();
                return {
                    accepted,
                    invalid,
                    count: rows.length,
                    first: rows[0].key,
                    last: rows.at(-1).key,
                };
            });
            assert.equal(result.accepted, 100);
            assert.equal(result.count, 100);
            assert.equal(result.invalid, false);
            assert.notEqual(result.first, result.last);
        },
    );
    await check(
        "corrupt or future row formats fail closed and are not erased by activation",
        async () => {
            const name = "play-journal-native-future";
            await prepare(page, name);
            const result = await page.evaluate(async () => {
                const lease = await store.activateLease(scope, "L".repeat(32));
                await store.insertReady(lease, { key, payload });
                await store.close();
                const db = await new Promise((resolve, reject) => {
                    const r = indexedDB.open("play-journal-native-future", 1);
                    r.onsuccess = () => resolve(r.result);
                    r.onerror = () => reject(r.error);
                });
                await new Promise((resolve, reject) => {
                    const tx = db.transaction("rows", "readwrite"),
                        s = tx.objectStore("rows"),
                        r = s.get(key);
                    r.onsuccess = () => s.put({ ...r.result, version: 2 });
                    tx.oncomplete = resolve;
                    tx.onabort = () => reject(tx.error);
                });
                store = PlayJournal.createPlayCreateJournalStorage({
                    databaseName: "play-journal-native-future",
                    isCurrent: () => authorized,
                });
                const rows = await store.list(lease),
                    activation = await store.activateLease(
                        scope,
                        "M".repeat(32),
                    );
                const version = await new Promise((resolve) => {
                    const r = db
                        .transaction("rows")
                        .objectStore("rows")
                        .get(key);
                    r.onsuccess = () => resolve(r.result.version);
                });
                db.close();
                return { rows, activation, version };
            });
            assert.equal(result.rows, null);
            assert.equal(result.activation, null);
            assert.equal(result.version, 2);
        },
    );
    await check(
        "10-minute create budget is separate from 24-hour replay retention; pruning is owner conditional",
        async () => {
            await prepare(page, "play-journal-native-expiry");
            assert.equal(
                await page.evaluate(() => typeof store.pruneExpired),
                "function",
            );
            const result = await page.evaluate(async () => {
                const lease = await store.activateLease(scope, "L".repeat(32));
                await store.insertReady(lease, { key, payload });
                const stopped = await store.reserveCreate(
                    lease,
                    key,
                    "C".repeat(32),
                    1_800_000_600_000,
                );
                const terminal = (await store.list(lease))[0];
                const early = await store.pruneExpired(
                    lease,
                    1_800_086_399_999,
                );
                const expired = await store.pruneExpired(
                    lease,
                    1_800_086_400_000,
                );
                return {
                    stopped,
                    terminal,
                    early,
                    expired,
                    rows: await store.list(lease),
                };
            });
            assert.equal(result.stopped, null);
            assert.equal(result.terminal.state, "terminal");
            assert.equal(result.terminal.createAttempts, 0);
            assert.equal(result.early, 0);
            assert.equal(result.expired, 1);
            assert.deepEqual(result.rows, []);
        },
    );
    await check(
        "a PATCH claim cannot overflow the representable expiry date",
        async () => {
            await prepare(page, "play-journal-native-date-limit");
            const result = await page.evaluate(async () => {
                const lease = await store.activateLease(scope, "L".repeat(32));
                const issued = 8_640_000_000_000_000 - 86_400_000;
                const edge = `p1.4.${issued.toString(36)}.${"E".repeat(32)}`;
                await store.insertReady(lease, { key: edge, payload });
                await store.reserveCreate(lease, edge, "C".repeat(32), issued);
                await store.acknowledgeCreate(
                    lease,
                    edge,
                    "C".repeat(32),
                    "edge-play",
                );
                await store.mergeEngagement(
                    lease,
                    edge,
                    {
                        listenedSeconds: 180,
                        completionRatio: 1,
                        outcome: "completed",
                    },
                    true,
                );
                const claim = await store.reservePatch(
                    lease,
                    edge,
                    "P".repeat(32),
                    8_640_000_000_000_000 - 1,
                );
                const rows = await store.list(lease);
                return { claim, rows };
            });
            assert.equal(
                result.claim.patchClaim.expiresAtServerMs,
                8_640_000_000_000_000,
            );
            assert.equal(result.rows.length, 1);
        },
    );
    await check(
        "closing during a native open settles immediately after the open callback",
        async () => {
            await prepare(page, "play-journal-native-close-setup");
            const result = await page.evaluate(async () => {
                let observe;
                const observed = new Promise((resolve) => {
                    observe = resolve;
                });
                const closing = PlayJournal.createPlayCreateJournalStorage({
                    databaseName: "play-journal-native-close",
                    isCurrent: () => true,
                    indexedDB: {
                        open(...args) {
                            const request = indexedDB.open(...args);
                            request.addEventListener("success", () =>
                                observe(),
                            );
                            return request;
                        },
                    },
                });
                let closed = false;
                const opening = closing.activateLease(scope, "L".repeat(32));
                const completion = closing.close().then(() => {
                    closed = true;
                });
                const settled = Promise.allSettled([opening, completion]);
                await observed;
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (closed) await settled;
                return closed;
            });
            assert.equal(
                result,
                true,
                "native open completion must not leave the abandoned handle waiting for a timeout",
            );
        },
    );
    await check(
        "shared PATCH holdoff stays observable after the initiating row is terminal",
        async () => {
            await prepare(page, "play-journal-native-patch-holdoff");
            assert.equal(
                await page.evaluate(() => typeof store.snapshot),
                "function",
                "coordinator needs the durable shared wake time even when no row exposes it",
            );
            const result = await page.evaluate(async () => {
                const lease = await store.activateLease(scope, "L".repeat(32));
                await store.insertReady(lease, { key, payload });
                await store.reserveCreate(
                    lease,
                    key,
                    "C".repeat(32),
                    1_800_000_000_000,
                );
                await store.acknowledgeCreate(
                    lease,
                    key,
                    "C".repeat(32),
                    "known-play",
                );
                await store.mergeEngagement(
                    lease,
                    key,
                    {
                        listenedSeconds: 180,
                        completionRatio: 1,
                        outcome: "completed",
                    },
                    true,
                );
                await store.reservePatch(
                    lease,
                    key,
                    "P".repeat(32),
                    1_800_000_000_000,
                );
                const retriable = await store.settleFailure(lease, key, {
                    kind: "patch",
                    token: "P".repeat(32),
                    serverNowMs: 1_800_000_000_001,
                    retryAfterUntilMs: 1_800_000_030_000,
                    shared: true,
                    terminal: false,
                });
                const afterRetry = await store.snapshot(lease);
                const blocked = await store.reservePatch(
                    lease,
                    key,
                    "Q".repeat(32),
                    1_800_000_029_999,
                );
                const next = await store.reservePatch(
                    lease,
                    key,
                    "Q".repeat(32),
                    1_800_000_030_000,
                );
                const lateAck = await store.acknowledgePatch(
                    lease,
                    key,
                    "P".repeat(32),
                );
                const terminal = await store.settleFailure(lease, key, {
                    kind: "patch",
                    token: "Q".repeat(32),
                    serverNowMs: 1_800_000_030_001,
                    retryAfterUntilMs: 1_800_000_090_000,
                    shared: true,
                    terminal: true,
                });
                return {
                    retriable,
                    afterRetry,
                    blocked,
                    next,
                    lateAck,
                    terminal,
                    snapshot: await store.snapshot(lease),
                };
            });
            assert.equal(result.retriable, true);
            assert.equal(result.afterRetry.rows[0].playId, "known-play");
            assert.equal(
                result.afterRetry.sharedHoldoffUntilMs,
                1_800_000_030_000,
            );
            assert.equal(result.blocked, null);
            assert.ok(result.next);
            assert.equal(result.lateAck, false);
            assert.equal(result.terminal, true);
            assert.equal(
                result.snapshot.sharedHoldoffUntilMs,
                1_800_000_090_000,
            );
            assert.equal(result.snapshot.rows[0].state, "terminal");
        },
    );
    console.log(
        JSON.stringify({
            passed,
            failed,
            engine: "installed Chrome",
            storage: "native IndexedDB",
            contexts: 1,
        }),
    );
    if (failed) process.exitCode = 1;
} finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
}
