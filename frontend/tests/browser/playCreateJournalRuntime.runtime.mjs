/** Native browser IDB with controlled transport; compiled client/server acceptance is separate. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const bundle = await build({
    stdin: {
        contents: `import * as runtime from './lib/playCreateJournalRuntime';
        import * as protocol from './lib/playCreateJournal';
        import * as storage from './lib/playCreateJournalStorage';
        globalThis.PlayRuntime={...runtime,...protocol,...storage};`,
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
let browser,
    passed = 0,
    failed = 0;
const pageErrors = [];
try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const setup = async (name) =>
        page.evaluate((databaseName) => {
            const env = (globalThis.env = {
                owner: "alice",
                nonce: "N".repeat(32),
                auth: 2,
                net: 3,
                online: true,
                mounted: true,
                epoch: 4,
                mono: 100,
                time: 1_800_000_000_000,
                reads: 0,
                calls: [],
                timers: [],
                instances: [],
                random: 0,
                disabled: false,
                heldGrant: null,
                heldCreate: null,
            });
            const binding = () => ({
                ownerId: env.owner,
                loginNonce: env.nonce,
                authGeneration: env.auth,
                networkGeneration: env.net,
            });
            const fresh = () =>
                PlayRuntime.readPlayCreateGrant(
                    {
                        version: 1,
                        newCreationsEnabled: !env.disabled,
                        replaySupported: !env.disabled,
                        createPath: "/api/plays/idempotent",
                        ownerHistoryEpoch: env.epoch,
                        serverNowMs: env.time,
                        replayWindowSeconds: 86400,
                        futureSkewSeconds: 300,
                        capabilityTtlSeconds: 300,
                        allowedSources: env.disabled
                            ? []
                            : ["youtube", "vk", "yandex"],
                    },
                    binding(),
                    env.mono,
                );
            env.api = {
                getSessionGeneration: () => env.auth,
                getPlayCreateLoginNonce: () => env.nonce,
                async getPlayCreationGrant() {
                    env.reads++;
                    if (env.heldGrant) await env.heldGrant;
                    return fresh();
                },
                async createPlayIdempotent(key, payload) {
                    env.calls.push({ kind: "create", key, payload });
                    if (env.heldCreate) await env.heldCreate;
                    return {
                        id: "known-" + key,
                        playCreation: {
                            version: 1,
                            clientPlaybackId: key,
                            disposition: "created",
                            replayExpiresAt: new Date(
                                env.time + 86400000,
                            ).toISOString(),
                        },
                    };
                },
                async updatePlayEngagementIdempotent(id, input) {
                    env.calls.push({ kind: "patch", id, input });
                    return { success: true };
                },
            };
            env.make = () => {
                const options = {
                    ownerId: "alice",
                    api: env.api,
                    auth: { isCurrent: () => env.mounted },
                    network: {
                        isOnline: () => env.online,
                        getGeneration: () => env.net,
                    },
                    databaseName,
                    nowMonotonic: () => env.mono,
                    nonce: () => (++env.random).toString(36).padStart(32, "A"),
                    schedule: (run, delay) => {
                        const timer = { run, delay, canceled: false };
                        env.timers.push(timer);
                        return () => {
                            timer.canceled = true;
                        };
                    },
                };
                env.options = options;
                const runtime =
                    PlayRuntime.createPlayCreateJournalRuntime(options);
                env.instances.push(runtime);
                return runtime;
            };
            globalThis.runtime = env.make();
            globalThis.play = {
                youtubeVideoId: "video",
                title: "Song",
                artist: "Artist",
                album: "Album",
                duration: 100,
            };
        }, name);
    const check = async (name, run) => {
        try {
            await setup("journal-runtime-" + passed + "-" + failed);
            await run();
            passed++;
            console.log("PASS " + name);
        } catch (error) {
            failed++;
            console.error("FAIL " + name, error);
        } finally {
            await page.evaluate(async () => {
                for (const instance of env.instances) await instance.close();
            });
        }
    };
    await check(
        "no grant means immediate legacy selection, then verified owner permits a keyed run",
        async () => {
            const result = await page.evaluate(async () => {
                const before = runtime.begin(play);
                await runtime.prepare();
                const ticket = runtime.begin(play);
                if (!ticket) return { before, ticket: null };
                await ticket.persisted;
                await runtime.flush();
                return {
                    before,
                    mode: ticket.mode,
                    created: await ticket.created,
                    calls: env.calls.map((c) => c.kind),
                };
            });
            assert.equal(result.before, null);
            assert.equal(result.mode, "keyed");
            assert.ok(result.created.id);
            assert.deepEqual(result.calls, ["create"]);
        },
    );
    await check(
        "a fresh different owner cannot activate storage or log the mounted queue",
        async () => {
            const result = await page.evaluate(async () => {
                env.owner = "bob";
                await runtime.prepare();
                let rejected = false;
                try {
                    runtime.begin(play);
                } catch {
                    rejected = true;
                }
                return {
                    rejected,
                    databases: await indexedDB.databases(),
                    calls: env.calls,
                };
            });
            assert.equal(result.rejected, true);
            assert.deepEqual(result.calls, []);
            assert.equal(
                result.databases.some((d) =>
                    d.name.includes("journal-runtime-1-0"),
                ),
                false,
            );
        },
    );
    await check(
        "late fresh identity after logout is rejected before storage activation",
        async () => {
            const result = await page.evaluate(async () => {
                let release;
                env.heldGrant = new Promise((resolve) => {
                    release = resolve;
                });
                const preparing = runtime.prepare();
                await Promise.resolve();
                env.mounted = false;
                release();
                await preparing;
                let rejected = false;
                try {
                    runtime.begin(play);
                } catch {
                    rejected = true;
                }
                return { rejected, calls: env.calls };
            });
            assert.equal(result.rejected, true);
            assert.deepEqual(result.calls, []);
        },
    );
    await check(
        "offline preparation makes no identity call and does not schedule permission polling",
        async () => {
            const result = await page.evaluate(async () => {
                env.online = false;
                await runtime.prepare();
                return {
                    selected: runtime.begin(play),
                    reads: env.reads,
                    timers: env.timers.length,
                    calls: env.calls,
                };
            });
            assert.deepEqual(result, {
                selected: null,
                reads: 0,
                timers: 0,
                calls: [],
            });
        },
    );
    await check(
        "close preserves accepted final writes for same-login recovery instead of closing IDB early",
        async () => {
            const result = await page.evaluate(async () => {
                await runtime.prepare();
                const ticket = runtime.begin(play);
                await ticket.persisted;
                await runtime.flush();
                const accepted = ticket.noteEngagement(
                    {
                        listenedSeconds: 9,
                        completionRatio: 0.09,
                        outcome: "failed",
                    },
                    true,
                );
                await runtime.close();
                const stored = await accepted;
                const reopened = env.make();
                env.disabled = true;
                await reopened.prepare();
                await reopened.flush();
                return {
                    stored,
                    calls: env.calls.map((c) => ({
                        kind: c.kind,
                        input: c.input,
                    })),
                };
            });
            assert.equal(result.stored, true);
            assert.deepEqual(
                result.calls.map((c) => c.kind),
                ["create", "patch"],
            );
            assert.deepEqual(result.calls[1].input, {
                listenedSeconds: 9,
                completionRatio: 0.09,
                outcome: "failed",
            });
        },
    );
    await check(
        "same-user logical relogin withdraws both keyed and legacy admission synchronously",
        async () => {
            const result = await page.evaluate(async () => {
                await runtime.prepare();
                env.nonce = "Z".repeat(32);
                let rejected = false;
                try {
                    runtime.begin(play);
                } catch {
                    rejected = true;
                }
                await runtime.prepare();
                return { rejected, calls: env.calls };
            });
            assert.equal(result.rejected, true);
            assert.deepEqual(result.calls, []);
        },
    );
    await check(
        "history-clear barrier blocks new legacy admission and recovers only the new epoch",
        async () => {
            const result = await page.evaluate(async () => {
                await runtime.prepare();
                const ticket = runtime.begin(play);
                await ticket.persisted;
                await runtime.flush();
                const finish = runtime.suspendForHistoryClear();
                let rejected = false;
                try {
                    runtime.begin(play);
                } catch {
                    rejected = true;
                }
                env.epoch++;
                await finish(true);
                await runtime.prepare();
                const next = runtime.begin(play);
                await next.persisted;
                await runtime.flush();
                return {
                    rejected,
                    oldKey: ticket.key,
                    nextKey: next.key,
                    calls: env.calls.map((c) => c.kind),
                };
            });
            assert.equal(result.rejected, true);
            assert.ok(result.oldKey.startsWith("p1.4."));
            assert.ok(result.nextKey.startsWith("p1.5."));
            assert.deepEqual(result.calls, ["create", "create"]);
        },
    );
    await check(
        "failed history clear can resume the same epoch without retiring its pending engagement",
        async () => {
            const result = await page.evaluate(async () => {
                await runtime.prepare();
                const ticket = runtime.begin(play);
                await ticket.persisted;
                await runtime.flush();
                const note = ticket.noteEngagement(
                    {
                        listenedSeconds: 8,
                        completionRatio: 0.08,
                        outcome: "skipped",
                    },
                    true,
                );
                const finish = runtime.suspendForHistoryClear();
                await note;
                await finish(false);
                await runtime.prepare();
                await runtime.flush();
                return env.calls.map((c) => ({ kind: c.kind, id: c.id }));
            });
            assert.deepEqual(
                result.map((c) => c.kind),
                ["create", "patch"],
            );
            assert.ok(result[1].id.startsWith("known-p1.4."));
        },
    );
    await check(
        "a failed history clear preserves the active ticket for a later final checkpoint",
        async () => {
            const result = await page.evaluate(async () => {
                await runtime.prepare();
                const ticket = runtime.begin(play);
                await ticket.persisted;
                await runtime.flush();
                const finish = runtime.suspendForHistoryClear();
                await finish(false);
                const accepted = await ticket.noteEngagement(
                    {
                        listenedSeconds: 7,
                        completionRatio: 0.07,
                        outcome: "failed",
                    },
                    true,
                );
                await runtime.flush();
                return {
                    accepted,
                    calls: env.calls.map((call) => call.kind),
                    id: env.calls.at(-1).id,
                    key: ticket.key,
                };
            });
            assert.equal(result.accepted, true);
            assert.deepEqual(result.calls, ["create", "patch"]);
            assert.equal(result.id, "known-" + result.key);
        },
    );
    await check(
        "mutating constructor options cannot replace the mounted owner",
        async () => {
            const result = await page.evaluate(async () => {
                env.options.ownerId = "bob";
                env.owner = "bob";
                await runtime.prepare();
                let rejected = false;
                try {
                    runtime.begin(play);
                } catch {
                    rejected = true;
                }
                return { rejected, calls: env.calls };
            });
            assert.equal(result.rejected, true);
            assert.deepEqual(result.calls, []);
        },
    );
    await check(
        "epoch replacement stays single-flight while its IndexedDB activation is delayed",
        async () => {
            const result = await page.evaluate(async () => {
                await runtime.prepare();
                const ticket = runtime.begin(play);
                await ticket.persisted;
                await runtime.flush();
                const original =
                    PlayRuntime.PlayCreateJournalStorage.prototype
                        .activateLease;
                let release, observed;
                const held = new Promise((resolve) => {
                    release = resolve;
                });
                const arrived = new Promise((resolve) => {
                    observed = resolve;
                });
                PlayRuntime.PlayCreateJournalStorage.prototype.activateLease =
                    async function (...args) {
                        if (args[0].historyEpoch === 5) {
                            observed();
                            await held;
                        }
                        return original.apply(this, args);
                    };
                try {
                    env.epoch = 5;
                    env.mono += 300001;
                    env.time += 300001;
                    const pending = runtime.flush();
                    await arrived;
                    const simultaneous = runtime.prepare();
                    await Promise.resolve();
                    await Promise.resolve();
                    const readsBeforeRelease = env.reads;
                    release();
                    await pending;
                    await simultaneous;
                    await runtime.flush();
                    return { readsBeforeRelease, reads: env.reads };
                } finally {
                    release();
                    PlayRuntime.PlayCreateJournalStorage.prototype.activateLease =
                        original;
                }
            });
            assert.deepEqual(result, { readsBeforeRelease: 2, reads: 2 });
        },
    );
    for (const phase of ["expired", "network", "failed-clear"]) {
        await check(
            `empty journal refreshes admission after ${phase}`,
            async () => {
                const result = await page.evaluate(async (phase) => {
                    await runtime.prepare();
                    await runtime.flush();
                    if (phase === "expired") {
                        env.mono += 300001;
                        env.time += 300001;
                        await runtime.prepare();
                    } else if (phase === "network") {
                        env.online = false;
                        env.net++;
                        runtime.wake();
                        await runtime.flush();
                        env.online = true;
                        env.net++;
                        runtime.wake();
                    } else {
                        const finish = runtime.suspendForHistoryClear();
                        await finish(false);
                    }
                    await runtime.flush();
                    const ticket = runtime.begin(play);
                    if (ticket) await ticket.persisted;
                    return { reads: env.reads, mode: ticket?.mode ?? null };
                }, phase);
                assert.deepEqual(result, { reads: 2, mode: "keyed" });
            },
        );
    }
    await check(
        "an unsupported refreshed grant does not install an empty-journal polling timer",
        async () => {
            const result = await page.evaluate(async () => {
                await runtime.prepare();
                await runtime.flush();
                env.mono += 300001;
                env.time += 300001;
                env.api.getPlayCreationGrant = async () => {
                    env.reads++;
                    return null;
                };
                runtime.wake();
                await runtime.flush();
                await Promise.resolve();
                await Promise.resolve();
                return {
                    reads: env.reads,
                    ticket: runtime.begin(play),
                    calls: env.calls.length,
                    timers: env.timers.filter((timer) => !timer.canceled)
                        .length,
                };
            });
            assert.deepEqual(result, {
                reads: 2,
                ticket: null,
                calls: 0,
                timers: 0,
            });
        },
    );
    assert.deepEqual(pageErrors, []);
    console.log(
        JSON.stringify({
            passed,
            failed,
            pageErrors,
            storage: "native IndexedDB",
            transport: "controlled API fixture",
        }),
    );
    if (failed) process.exitCode = 1;
} finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
}
