/** Bounded installed-Chrome harness: native IndexedDB, controlled transport and clock. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.resolve("package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const bundle = await build({
    stdin: {
        contents: `
import { createPlayCreateCoordinator } from "./lib/playCreateCoordinator";
import { createPlayCreateJournalStorage } from "./lib/playCreateJournalStorage";
import { readPlayCreateGrant, makePlayCreateKey, readPlayCreateKey } from "./lib/playCreateJournal";
globalThis.makeFixture = async (name, options = {}) => {
    const f = {
        name, mono: 1000, base: 1800000000000, online: true, auth: 2, net: 3,
        owner: "alice", login: "A".repeat(32), epoch: 4,
        policy: { newCreationsEnabled: true, replaySupported: true, allowedSources: ["youtube", "vk", "yandex"] },
        calls: [], commits: new Map(), timers: new Map(), nonceCounter: 0,
        freshReads: 0, transport: "ok", closed: false,
        ...options,
    };
    f.binding = () => ({ownerId: f.owner, loginNonce: f.login, authGeneration: f.auth, networkGeneration: f.net});
    f.now = () => f.base + f.mono - 1000;
    f.grant = () => readPlayCreateGrant({
        version: 1, createPath: "/api/plays/idempotent", ownerHistoryEpoch: f.epoch,
        serverNowMs: f.now(), replayWindowSeconds: 86400, futureSkewSeconds: 300,
        capabilityTtlSeconds: 300, ...f.policy,
    }, f.binding(), f.mono);
    const scope = {ownerId:f.owner, loginNonce:f.login, historyEpoch:f.epoch};
    f.store = createPlayCreateJournalStorage({ databaseName: name, isCurrent: value =>
        f.owner === value.ownerId && f.login === value.loginNonce && f.epoch === value.historyEpoch });
    f.lease = await f.store.activateLease(scope, "L".repeat(32));
    f.nonce = () => (++f.nonceCounter).toString(36).padStart(32,"N");
    f.api = {
        createPlayIdempotent: async (key, payload, options) => {
            f.calls.push({kind:"create",key,payload,binding:options.binding});
            if(f.createGate) await f.createGate;
            if (f.transport === "503") throw Object.assign(new Error("safe"), {status:503,retryAfterMs:37000,responseReceipt:{receivedMonotonicMs:f.mono}});
            if (f.transport === "401" || f.transport === "404" || f.transport === "409") throw Object.assign(new Error("safe"), {status:Number(f.transport)});
            if (f.transport === "network") throw new Error("safe");
            if (!f.commits.has(key)) f.commits.set(key, "play-" + (f.commits.size+1));
            if (f.transport === "lost") { f.transport="ok"; throw new Error("lost ACK after commit"); }
            const parsed = readPlayCreateKey(key);
            return {id:f.commits.get(key),playCreation:{version:1,clientPlaybackId:key,disposition:"created",replayExpiresAt:new Date(parsed.expiresAtMs).toISOString()}};
        },
        updatePlayEngagementIdempotent: async (id,input,options) => {
            f.calls.push({kind:"patch",id,input,binding:options.binding});
            if(f.patchGate) await f.patchGate;
            if(f.patchTransport) throw Object.assign(new Error("safe"),{status:f.patchTransport});
            return {success:true};
        },
    };
    f.actor = () => createPlayCreateCoordinator({
        storage:f.store, lease:f.lease, binding:f.binding(), initialGrant:options.noGrant ? null : f.grant(),
        getBinding:f.binding, isOnline:() => f.online, nowMonotonic:() => f.mono,
        readFreshGrant:async () => { f.freshReads++; return f.noFresh ? null : f.grant(); },
        api:f.api, nonce:f.nonce,
        schedule:(run,delay) => { const token = {}; f.timers.set(token,{run,due:f.mono+delay,delay}); return () => f.timers.delete(token); },
    });
    f.coordinator = f.actor();
    f.payload = () => ({youtubeVideoId:"video-1",title:"Song",artist:"Artist",album:"Album",duration:180});
    f.advance = async delta => {
        f.mono += delta;
        const due = [...f.timers].filter(([,value]) => value.due <= f.mono);
        for(const [token,value] of due) {f.timers.delete(token);value.run();}
        await f.coordinator.flush();
    };
    f.rows = () => f.store.list(f.lease);
    f.finish = async () => { f.coordinator.close(); await f.store.close(); };
    globalThis.f = f;
    return true;
};
globalThis.completed = {listenedSeconds:180,completionRatio:1,outcome:"completed"};
globalThis.failed = {listenedSeconds:4,completionRatio:4/180,outcome:"failed"};
`,
        resolveDir: process.cwd(),
        loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    logLevel: "silent",
    define: {
        "process.env.NODE_ENV": '"test"',
        "process.env.NEXT_PUBLIC_LOG_LEVEL": '"silent"',
    },
});
const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
        "Content-Type",
        request.url === "/module.js" ? "application/javascript" : "text/html",
    );
    response.end(
        request.url === "/module.js"
            ? bundle.outputFiles[0].text
            : '<!doctype html><script src="/module.js"></script>',
    );
});
let browser, context;
let passed = 0,
    failedCount = 0;
const pageErrors = [];
try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ channel: "chrome", headless: true });
    context = await browser.newContext();
    const origin = `http://127.0.0.1:${server.address().port}`;
    const check = async (name, run) => {
        const page = await context.newPage();
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.setDefaultTimeout(8000);
        let deadline;
        try {
            await page.goto(origin);
            await page.evaluate(
                (name) => makeFixture(name),
                "coordinator-" + passed + "-" + failedCount,
            );
            await Promise.race([
                run(page),
                new Promise((_resolve, reject) => {
                    deadline = setTimeout(
                        () => reject(new Error("coordinator fixture deadline")),
                        10000,
                    );
                }),
            ]);
            passed++;
            console.log("PASS " + name);
        } catch (error) {
            failedCount++;
            console.error("FAIL " + name, error);
        } finally {
            clearTimeout(deadline);
            await page.evaluate(() => globalThis.f?.finish()).catch(() => {});
            await page.close();
        }
    };
    await check(
        "commit observers wait for validated server ACK rather than local journal persistence",
        async (page) => {
            const before = await page.evaluate(async () => {
                f.observed = [];
                f.patchGate = new Promise((resolve) => {
                    f.releasePatch = resolve;
                });
                const ticket = f.coordinator.begin(f.payload());
                ticket.observeEngagementCommits((input) =>
                    f.observed.push(input),
                );
                await ticket.persisted;
                await ticket.created;
                const stored = await ticket.noteEngagement(completed, true);
                return { stored, observed: f.observed.length };
            });
            assert.equal(before.stored, true);
            assert.equal(before.observed, 0);
            const after = await page.evaluate(async () => {
                f.releasePatch();
                await f.coordinator.flush();
                return {
                    observed: f.observed,
                    patches: f.calls.filter((call) => call.kind === "patch")
                        .length,
                };
            });
            assert.deepEqual(after.observed, [
                {
                    listenedSeconds: 180,
                    completionRatio: 1,
                    outcome: "completed",
                },
            ]);
            assert.equal(after.patches, 1);
        },
    );
    await check(
        "begin is synchronous, stores immutable DTO before wire and delivers final before delayed create ACK",
        async (page) => {
            const result = await page.evaluate(async () => {
                let release;
                f.createGate = new Promise((resolve) => (release = resolve));
                const payload = f.payload(),
                    ticket = f.coordinator.begin(payload);
                payload.title = "Mutated";
                await ticket.persisted;
                await ticket.noteEngagement(completed, true);
                const before = await f.rows();
                release();
                await f.coordinator.flush();
                return {
                    mode: ticket.mode,
                    key: ticket.key,
                    created: await ticket.created,
                    before,
                    calls: f.calls,
                    rows: await f.rows(),
                };
            });
            assert.equal(result.mode, "keyed");
            assert.ok(result.key);
            assert.equal(result.created.id, "play-1");
            assert.equal(result.before[0].totals.outcome, "completed");
            assert.equal(
                result.calls[0].payload.wireJson.includes("Mutated"),
                false,
            );
            assert.equal(
                result.calls.filter((c) => c.kind === "create").length,
                1,
            );
            assert.equal(
                result.calls.find((c) => c.kind === "patch").input.outcome,
                "completed",
            );
            assert.deepEqual(result.rows, []);
        },
    );
    await check(
        "lost ACK reuses frozen key after reload and creates one fixture Play",
        async (page) => {
            const result = await page.evaluate(async () => {
                f.transport = "lost";
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await t.noteEngagement(completed, true);
                await f.coordinator.flush();
                const pending = await f.rows();
                f.coordinator.close();
                f.coordinator = f.actor();
                f.mono += 5000;
                await f.coordinator.flush();
                return {
                    pending,
                    calls: f.calls,
                    commits: f.commits.size,
                    rows: await f.rows(),
                };
            });
            assert.equal(result.pending[0].state, "unknown");
            assert.equal(result.commits, 1);
            const creates = result.calls.filter((c) => c.kind === "create");
            assert.equal(creates.length, 2);
            assert.equal(creates[0].key, creates[1].key);
            assert.equal(
                creates[0].payload.wireJson,
                creates[1].payload.wireJson,
            );
            assert.equal(
                result.calls.find((c) => c.kind === "patch").input.outcome,
                "completed",
            );
            assert.deepEqual(result.rows, []);
        },
    );
    await check(
        "three durable create reservations bound retries and never select a replacement key",
        async (page) => {
            const result = await page.evaluate(async () => {
                f.transport = "network";
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                for (let i = 0; i < 5; i++) await f.advance(30000);
                return {
                    calls: f.calls,
                    rows: await f.rows(),
                    timers: f.timers.size,
                };
            });
            assert.equal(result.calls.length, 3);
            assert.equal(new Set(result.calls.map((c) => c.key)).size, 1);
            assert.equal(result.rows[0].state, "terminal");
        },
    );
    await check(
        "known final PATCH survives fully disabled creation policy",
        async (page) => {
            const result = await page.evaluate(async () => {
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                await t.created;
                f.coordinator.close();
                f.policy = {
                    newCreationsEnabled: false,
                    replaySupported: false,
                    allowedSources: [],
                };
                f.coordinator = f.actor();
                await f.store.mergeEngagement(f.lease, t.key, completed, true);
                await f.coordinator.flush();
                return {
                    newTicket: f.coordinator.begin(f.payload()),
                    calls: f.calls,
                    rows: await f.rows(),
                };
            });
            assert.equal(result.newTicket, null);
            assert.equal(
                result.calls.filter((c) => c.kind === "create").length,
                1,
            );
            assert.equal(
                result.calls.filter((c) => c.kind === "patch").length,
                1,
            );
            assert.deepEqual(result.rows, []);
        },
    );
    await check(
        "no observations remain neutral and failed final is not converted to skipped",
        async (page) => {
            const result = await page.evaluate(async () => {
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                const empty = await f.rows();
                const patchesBefore = f.calls.filter(
                    (c) => c.kind === "patch",
                ).length;
                await t.noteEngagement(failed, true);
                await f.coordinator.flush();
                return {
                    empty,
                    patchesBefore,
                    calls: f.calls,
                    rows: await f.rows(),
                };
            });
            assert.equal(result.empty[0].totals, null);
            assert.equal(result.patchesBefore, 0);
            assert.equal(
                result.calls.find((c) => c.kind === "patch").input.outcome,
                "failed",
            );
            assert.deepEqual(result.rows, []);
        },
    );
    await check(
        "progress during PATCH ACK retains latest final revision",
        async (page) => {
            const result = await page.evaluate(async () => {
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                let release;
                f.patchGate = new Promise((resolve) => (release = resolve));
                await t.noteEngagement(
                    {
                        listenedSeconds: 40,
                        completionRatio: 0.3,
                        outcome: "meaningful",
                    },
                    false,
                );
                while (!f.calls.some((c) => c.kind === "patch"))
                    await new Promise((resolve) => setTimeout(resolve, 0));
                await t.noteEngagement(completed, true);
                release();
                await f.coordinator.flush();
                return {
                    patches: f.calls.filter((c) => c.kind === "patch"),
                    rows: await f.rows(),
                };
            });
            assert.equal(result.patches.length, 2);
            assert.equal(result.patches[0].input.outcome, "meaningful");
            assert.equal(result.patches[1].input.outcome, "completed");
            assert.deepEqual(result.rows, []);
        },
    );
    await check(
        "offline final persists and new network generation requires fresh grant",
        async (page) => {
            const result = await page.evaluate(async () => {
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                f.online = false;
                f.net++;
                f.coordinator.wake();
                await t.noteEngagement(completed, true);
                await f.coordinator.flush();
                const before = f.calls.length,
                    offline = await f.rows(),
                    timerCount = f.timers.size;
                f.online = true;
                f.net++;
                await f.coordinator.flush();
                return {
                    before,
                    offline,
                    timerCount,
                    calls: f.calls,
                    reads: f.freshReads,
                    rows: await f.rows(),
                };
            });
            assert.equal(result.before, 1);
            assert.equal(result.offline[0].final, true);
            assert.equal(result.timerCount, 0);
            assert.ok(result.reads >= 1);
            assert.equal(result.calls[1].binding.networkGeneration, 5);
            assert.deepEqual(result.rows, []);
        },
    );
    await check(
        "owner replacement and history revoke fence delayed ACKs",
        async (page) => {
            const result = await page.evaluate(async () => {
                let release;
                f.createGate = new Promise((resolve) => (release = resolve));
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await t.noteEngagement(completed, true);
                while (!f.calls.length)
                    await new Promise((resolve) => setTimeout(resolve, 0));
                const revoked = f.coordinator.revoke();
                release();
                await revoked;
                await f.coordinator.flush();
                return {
                    calls: f.calls,
                    rows: await f.rows(),
                    timers: f.timers.size,
                    newTicket: f.coordinator.begin(f.payload()),
                };
            });
            assert.equal(result.calls.length, 1);
            assert.deepEqual(result.rows, null);
            assert.equal(result.timers, 0);
            assert.equal(result.newTicket, null);
        },
    );
    await check(
        "shared Retry-After survives reload and holds unrelated creates",
        async (page) => {
            const result = await page.evaluate(async () => {
                f.transport = "503";
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                const snapshot = await f.store.snapshot(f.lease);
                f.coordinator.close();
                f.transport = "ok";
                f.coordinator = f.actor();
                const other = f.coordinator.begin(f.payload());
                await other.persisted;
                await f.coordinator.flush();
                const before = f.calls.length;
                await f.advance(36999);
                const early = f.calls.length;
                await f.advance(1);
                return { snapshot, before, early, calls: f.calls };
            });
            assert.equal(result.snapshot.sharedHoldoffUntilMs, 1800000037000);
            assert.equal(result.before, 1);
            assert.equal(result.early, 1);
            assert.equal(result.calls.length, 3);
        },
    );
    await check(
        "expired grant consumes no wire after slow reservation and unknown claim remains durable",
        async (page) => {
            const result = await page.evaluate(async () => {
                const reserve = f.store.reserveCreate.bind(f.store);
                f.store.reserveCreate = async (...args) => {
                    const row = await reserve(...args);
                    f.mono += 300000;
                    return row;
                };
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                return {
                    calls: f.calls,
                    rows: await f.rows(),
                    timers: f.timers.size,
                };
            });
            assert.equal(result.calls.length, 0);
            assert.equal(result.rows[0].state, "unknown");
            assert.equal(result.rows[0].createAttempts, 1);
        },
    );
    await check(
        "missing fresh grant has no self-generated permission polling",
        async (page) => {
            const result = await page.evaluate(async () => {
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                f.coordinator.close();
                f.noFresh = true;
                f.mono += 300000;
                f.coordinator = f.actor();
                f.policy = {
                    newCreationsEnabled: false,
                    replaySupported: false,
                    allowedSources: [],
                };
                // Construct a deliberately expired receipt, then deny the one refresh.
                f.mono += 300000;
                const before = f.calls.length;
                await f.coordinator.flush();
                await f.coordinator.flush();
                return {
                    before,
                    calls: f.calls.length,
                    timers: f.timers.size,
                    reads: f.freshReads,
                };
            });
            assert.equal(result.calls, result.before);
            assert.equal(result.timers, 0);
            assert.ok(result.reads <= 2, JSON.stringify(result));
        },
    );
    await check(
        "explicit terminal HTTP statuses do not turn into timer auth loops",
        async (page) => {
            const result = await page.evaluate(async () => {
                f.transport = "401";
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                for (let i = 0; i < 3; i++) await f.advance(30000);
                return { calls: f.calls, rows: await f.rows() };
            });
            assert.equal(result.calls.length, 1);
            assert.equal(result.rows[0].state, "terminal");
        },
    );
    await check(
        "close during an awaited storage snapshot cannot start a fresh identity request",
        async (page) => {
            const result = await page.evaluate(async () => {
                const ticket = f.coordinator.begin(f.payload());
                await ticket.persisted;
                await f.coordinator.flush();
                f.coordinator.close();
                f.mono += 300000;
                f.noFresh = true;
                f.coordinator = f.actor();
                f.mono += 300000;
                const snapshot = f.store.snapshot.bind(f.store);
                let release, entered;
                const gate = new Promise((resolve) => (release = resolve)),
                    arrived = new Promise((resolve) => (entered = resolve));
                f.store.snapshot = async (...args) => {
                    const result = await snapshot(...args);
                    entered();
                    await gate;
                    return result;
                };
                const before = f.freshReads,
                    pending = f.coordinator.flush();
                await arrived;
                f.coordinator.close();
                release();
                await pending;
                return { before, after: f.freshReads };
            });
            assert.equal(result.after, result.before);
        },
    );
    await check(
        "READY respects producer rollback while UNKNOWN replays the original key",
        async (page) => {
            const result = await page.evaluate(async () => {
                const payload = Object.freeze({
                    source: "youtube",
                    wireJson: JSON.stringify(f.payload()),
                });
                const ready =
                    "p1.4." + f.base.toString(36) + "." + "R".repeat(32);
                const unknown =
                    "p1.4." + f.base.toString(36) + "." + "U".repeat(32);
                await f.store.insertReady(f.lease, { key: ready, payload });
                await f.store.insertReady(f.lease, { key: unknown, payload });
                await f.store.reserveCreate(
                    f.lease,
                    unknown,
                    "C".repeat(32),
                    f.now(),
                );
                await f.store.settleFailure(f.lease, unknown, {
                    kind: "create",
                    token: "C".repeat(32),
                    serverNowMs: f.now(),
                    retryAfterUntilMs: f.now(),
                    shared: false,
                    terminal: false,
                });
                f.coordinator.close();
                f.policy = {
                    newCreationsEnabled: false,
                    replaySupported: true,
                    allowedSources: [],
                };
                f.coordinator = f.actor();
                await f.coordinator.flush();
                return { calls: f.calls, rows: await f.rows(), ready, unknown };
            });
            assert.equal(result.calls.length, 1);
            assert.equal(result.calls[0].key, result.unknown);
            assert.equal(
                result.rows.find((row) => row.key === result.ready)
                    .createAttempts,
                0,
            );
        },
    );
    await check(
        "two genuine tabs share a lease and reserve only one create",
        async (page) => {
            const name = await page.evaluate(async () => {
                f.createGate = new Promise(
                    (resolve) => (f.releaseCreate = resolve),
                );
                f.ticket = f.coordinator.begin(f.payload());
                await f.ticket.persisted;
                return f.name;
            });
            await page.waitForFunction(() => f.calls.length === 1);
            const other = await context.newPage();
            other.on("pageerror", (error) => pageErrors.push(error.message));
            try {
                await other.goto(origin);
                await other.evaluate((name) => makeFixture(name), name);
                const second = await other.evaluate(async () => {
                    await f.coordinator.flush();
                    return {
                        calls: f.calls,
                        rows: await f.rows(),
                        timers: f.timers.size,
                    };
                });
                assert.equal(second.calls.length, 0);
                assert.equal(second.rows[0].state, "unknown");
                assert.equal(second.timers, 1);
                await page.evaluate(async () => {
                    f.releaseCreate();
                    await f.coordinator.flush();
                    await f.ticket.created;
                });
                const recovered = await other.evaluate(async () => {
                    await f.coordinator.flush();
                    return { calls: f.calls, rows: await f.rows() };
                });
                assert.equal(recovered.calls.length, 0);
                assert.equal(recovered.rows[0].state, "known");
                assert.equal(recovered.rows[0].totals, null);
            } finally {
                await other.evaluate(() => f.finish()).catch(() => {});
                await other.close();
            }
        },
    );
    await check(
        "an abandoned claim waits 120 seconds and then recovers with the same key",
        async (page) => {
            const result = await page.evaluate(async () => {
                const payload = Object.freeze({
                    source: "youtube",
                    wireJson: JSON.stringify(f.payload()),
                });
                const key =
                    "p1.4." + f.base.toString(36) + "." + "C".repeat(32);
                await f.store.insertReady(f.lease, { key, payload });
                await f.store.reserveCreate(
                    f.lease,
                    key,
                    "Q".repeat(32),
                    f.now(),
                );
                await f.coordinator.flush();
                const start = f.calls.length;
                await f.advance(119999);
                const early = f.calls.length;
                await f.advance(1);
                return {
                    key,
                    start,
                    early,
                    calls: f.calls,
                    rows: await f.rows(),
                };
            });
            assert.equal(result.start, 0);
            assert.equal(result.early, 0);
            assert.equal(result.calls.length, 1);
            assert.equal(result.calls[0].key, result.key);
            assert.equal(result.rows[0].createAttempts, 2);
        },
    );
    await check(
        "ten-minute automatic boundary retires an unsent run without a new key",
        async (page) => {
            const result = await page.evaluate(async () => {
                const payload = Object.freeze({
                    source: "youtube",
                    wireJson: JSON.stringify(f.payload()),
                });
                const expired =
                        "p1.4." + f.base.toString(36) + "." + "E".repeat(32),
                    young =
                        "p1.4." +
                        (f.base + 1).toString(36) +
                        "." +
                        "Y".repeat(32);
                await f.store.insertReady(f.lease, { key: expired, payload });
                await f.store.insertReady(f.lease, { key: young, payload });
                f.mono += 600000;
                await f.coordinator.flush();
                return { calls: f.calls, rows: await f.rows(), expired, young };
            });
            assert.equal(result.calls.length, 1);
            assert.equal(result.calls[0].key, result.young);
            assert.equal(
                result.rows.find((row) => row.key === result.expired).state,
                "terminal",
            );
        },
    );
    await check(
        "24-hour retention prunes a known final without another creation or PATCH",
        async (page) => {
            const result = await page.evaluate(async () => {
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                await t.created;
                f.online = false;
                f.coordinator.wake();
                await t.noteEngagement(completed, true);
                f.mono += 86400000;
                f.online = true;
                f.net++;
                await f.coordinator.flush();
                return {
                    calls: f.calls,
                    rows: await f.rows(),
                    timers: f.timers.size,
                };
            });
            assert.equal(result.calls.length, 1);
            assert.deepEqual(result.rows, []);
            assert.equal(result.timers, 0);
        },
    );
    await check(
        "operation budget stops at ten sends and schedules only one followup",
        async (page) => {
            const result = await page.evaluate(async () => {
                const tickets = Array.from({ length: 11 }, () =>
                    f.coordinator.begin(f.payload()),
                );
                await Promise.all(tickets.map((t) => t.persisted));
                await f.coordinator.flush();
                const first = f.calls.length,
                    timers = f.timers.size;
                await f.advance(100);
                return { first, timers, calls: f.calls.length };
            });
            assert.equal(result.first, 10);
            assert.equal(result.timers, 1);
            assert.equal(result.calls, 11);
        },
    );
    await check(
        "15-second soft budget is checked between operations",
        async (page) => {
            const result = await page.evaluate(async () => {
                const original = f.api.createPlayIdempotent;
                f.api.createPlayIdempotent = async (...args) => {
                    const result = await original(...args);
                    f.mono += 6000;
                    return result;
                };
                const tickets = Array.from({ length: 5 }, () =>
                    f.coordinator.begin(f.payload()),
                );
                await Promise.all(tickets.map((t) => t.persisted));
                await f.coordinator.flush();
                const first = f.calls.length,
                    timers = f.timers.size;
                await f.advance(100);
                return { first, timers, calls: f.calls.length };
            });
            assert.equal(result.first, 3);
            assert.equal(result.timers, 1);
            assert.equal(result.calls, 5);
        },
    );
    await check(
        "capacity keeps 100 selected obligations without evicting unknown work",
        async (page) => {
            const result = await page.evaluate(async () => {
                f.createGate = new Promise(
                    (resolve) => (f.releaseCreate = resolve),
                );
                const tickets = Array.from({ length: 100 }, () =>
                    f.coordinator.begin(f.payload()),
                );
                const beyond = f.coordinator.begin(f.payload());
                await Promise.all(tickets.map((t) => t.persisted));
                const rows = await f.rows();
                f.coordinator.close();
                f.releaseCreate();
                await f.coordinator.flush();
                return {
                    selected: tickets.filter(Boolean).length,
                    beyond,
                    rows: rows.length,
                };
            });
            assert.equal(result.selected, 100);
            assert.equal(result.beyond, null);
            assert.equal(result.rows, 100);
        },
    );
    await check(
        "Retry-After subtracts delayed receipt consumption from its durable deadline",
        async (page) => {
            const result = await page.evaluate(async () => {
                f.api.createPlayIdempotent = async (key) => {
                    f.calls.push({ kind: "create", key });
                    const receivedMonotonicMs = f.mono;
                    f.mono += 10000;
                    throw Object.assign(new Error("safe"), {
                        status: 503,
                        retryAfterMs: 37000,
                        responseReceipt: { receivedMonotonicMs },
                    });
                };
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                return {
                    calls: f.calls,
                    snapshot: await f.store.snapshot(f.lease),
                };
            });
            assert.equal(result.calls.length, 1);
            assert.equal(result.snapshot.sharedHoldoffUntilMs, 1800000037000);
        },
    );
    await check(
        "a final arriving as a coalesced checkpoint settles is still persisted",
        async (page) => {
            const result = await page.evaluate(async () => {
                const ticket = f.coordinator.begin(f.payload());
                await ticket.persisted;
                await f.coordinator.flush();
                await ticket.created;
                f.online = false;
                f.coordinator.wake();
                const merge = f.store.mergeEngagement.bind(f.store);
                let injected = false,
                    late;
                f.store.mergeEngagement = (...args) =>
                    merge(...args).then((stored) => {
                        if (!injected) {
                            injected = true;
                            queueMicrotask(() =>
                                queueMicrotask(() => {
                                    late = ticket.noteEngagement(
                                        completed,
                                        true,
                                    );
                                }),
                            );
                        }
                        return stored;
                    });
                await ticket.noteEngagement(
                    {
                        listenedSeconds: 40,
                        completionRatio: 0.3,
                        outcome: "meaningful",
                    },
                    false,
                );
                await late;
                return { rows: await f.rows() };
            });
            assert.equal(result.rows[0].final, true);
            assert.equal(result.rows[0].totals.outcome, "completed");
        },
    );
    await check(
        "new final committed during the closing snapshot overrides an older expiry wake",
        async (page) => {
            const result = await page.evaluate(async () => {
                const ticket = f.coordinator.begin(f.payload());
                await ticket.persisted;
                await f.coordinator.flush();
                await ticket.created;
                const snapshot = f.store.snapshot.bind(f.store);
                let reads = 0;
                f.store.snapshot = async (...args) => {
                    const stale = await snapshot(...args);
                    reads++;
                    if (reads === 3)
                        await ticket.noteEngagement(completed, true);
                    return stale;
                };
                await f.coordinator.flush();
                const before = f.calls.length,
                    delay = Math.min(
                        ...[...f.timers.values()].map((v) => v.delay),
                    );
                await f.advance(100);
                return { before, delay, calls: f.calls, rows: await f.rows() };
            });
            assert.equal(result.before, 1);
            assert.ok(result.delay <= 100, JSON.stringify(result));
            assert.equal(
                result.calls.filter((c) => c.kind === "patch").length,
                1,
            );
            assert.deepEqual(result.rows, []);
        },
    );
    await check(
        "offline then online during an aborted flight preserves a positive recovery wake",
        async (page) => {
            const result = await page.evaluate(async () => {
                let release;
                f.createGate = new Promise((resolve) => (release = resolve));
                const ticket = f.coordinator.begin(f.payload());
                await ticket.persisted;
                while (!f.calls.length)
                    await new Promise((resolve) => setTimeout(resolve, 0));
                f.online = false;
                f.net++;
                f.coordinator.wake();
                f.online = true;
                f.net++;
                f.coordinator.wake();
                release();
                await f.coordinator.flush();
                const delay = Math.min(
                    ...[...f.timers.values()].map((t) => t.delay),
                );
                return {
                    delay,
                    timers: f.timers.size,
                    calls: f.calls.length,
                    rows: await f.rows(),
                };
            });
            assert.equal(result.calls, 1);
            assert.equal(result.rows[0].state, "unknown");
            assert.equal(result.timers, 1);
            assert.ok(result.delay <= 100);
        },
    );
    await check(
        "a replaced owner cannot accept its old response into the new private lease",
        async (page) => {
            const result = await page.evaluate(async () => {
                let release;
                f.createGate = new Promise((resolve) => (release = resolve));
                const old = f.coordinator,
                    oldTicket = old.begin(f.payload());
                await oldTicket.persisted;
                while (!f.calls.length)
                    await new Promise((resolve) => setTimeout(resolve, 0));
                f.owner = "bob";
                f.login = "B".repeat(32);
                f.auth++;
                f.lease = await f.store.activateLease(
                    {
                        ownerId: f.owner,
                        loginNonce: f.login,
                        historyEpoch: f.epoch,
                    },
                    "M".repeat(32),
                );
                const payload = Object.freeze({
                        source: "youtube",
                        wireJson: JSON.stringify(f.payload()),
                    }),
                    key = "p1.4." + f.base.toString(36) + "." + "B".repeat(32);
                await f.store.insertReady(f.lease, { key, payload });
                release();
                await old.flush();
                old.close();
                return {
                    calls: f.calls,
                    rows: await f.rows(),
                    timers: f.timers.size,
                };
            });
            assert.equal(result.calls.length, 1);
            assert.equal(result.rows.length, 1);
            assert.equal(result.rows[0].ownerId, "bob");
            assert.equal(result.rows[0].state, "ready");
            assert.equal(result.timers, 0);
        },
    );
    await check(
        "persistence failure keeps the selected ticket keyed and does not create a replacement",
        async (page) => {
            const result = await page.evaluate(async () => {
                f.store.insertReady = async () => false;
                const t = f.coordinator.begin(f.payload());
                const stored = await t.persisted;
                const error = await t.created.catch((error) => error.message);
                await f.coordinator.flush();
                return { stored, error, mode: t.mode, calls: f.calls };
            });
            assert.equal(result.stored, false);
            assert.equal(result.mode, "keyed");
            assert.equal(typeof result.error, "string");
            assert.deepEqual(result.calls, []);
        },
    );
    await check(
        "malformed acknowledgement remains unknown with the final input and original key",
        async (page) => {
            const result = await page.evaluate(async () => {
                f.api.createPlayIdempotent = async (key) => {
                    f.calls.push({ kind: "create", key });
                    return {
                        id: "wrong",
                        playCreation: {
                            version: 1,
                            clientPlaybackId: "not-the-key",
                            disposition: "created",
                            replayExpiresAt: "invalid",
                        },
                    };
                };
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await t.noteEngagement(completed, true);
                await f.coordinator.flush();
                return { key: t.key, calls: f.calls, rows: await f.rows() };
            });
            assert.equal(result.calls.length, 1);
            assert.equal(result.rows[0].key, result.key);
            assert.equal(result.rows[0].state, "unknown");
            assert.equal(result.rows[0].playId, null);
            assert.equal(result.rows[0].final, true);
        },
    );
    await check(
        "monotonic rollback and malformed source DTO cannot select a new keyed run",
        async (page) => {
            const result = await page.evaluate(async () => {
                const extra = f.coordinator.begin({
                        ...f.payload(),
                        token: "must-not-persist",
                    }),
                    local = f.coordinator.begin({ trackId: "local" });
                const t = f.coordinator.begin(f.payload());
                await t.persisted;
                await f.coordinator.flush();
                f.mono = 999;
                const rollback = f.coordinator.begin(f.payload());
                f.mono = 1000;
                const reused = f.coordinator.begin(f.payload());
                return { extra, local, rollback, reused, calls: f.calls };
            });
            assert.equal(result.extra, null);
            assert.equal(result.local, null);
            assert.equal(result.rollback, null);
            assert.equal(result.reused, null);
            assert.equal(result.calls.length, 1);
        },
    );
    assert.deepEqual(pageErrors, [], "unhandled browser exceptions/rejections");
    console.log(
        JSON.stringify({
            passed,
            failed: failedCount,
            pageErrors: pageErrors.length,
            storage: "native IndexedDB",
            transport: "controlled fixture, not server/provider",
            engine: "installed Chrome",
        }),
    );
    if (failedCount) process.exitCode = 1;
} finally {
    await context?.close();
    await browser?.close();
    const done = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await done;
}
