import { resumeAudiobookProgressWrites } from "../../lib/audiobookProgressWrites";
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { WithAudiobooks } from "../../lib/api/audiobooks";
import type { ApiClientConstructor } from "../../lib/api/core";
import { advanceAuthRuntimeGeneration } from "../../lib/auth-runtime-generation";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());
type FixtureBook = import("../../lib/audio-state-context").Audiobook;
type Progress = { currentTime: number; duration: number; isFinished: boolean };
type FixtureState = {
    currentAudiobook: FixtureBook | null;
    setCurrentAudiobook: React.Dispatch<
        React.SetStateAction<FixtureBook | null>
    >;
    isPlaying: boolean;
    setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
    playbackType: "track" | "audiobook" | "podcast" | null;
    setPlaybackType: React.Dispatch<
        React.SetStateAction<FixtureState["playbackType"]>
    >;
    pause(): void;
    resume(): void;
    playAudiobook: (book: FixtureBook) => void;
    updateCurrentTime(value: number): void;
    seek(): void;
};
const context = React.createContext<FixtureState | null>(null);
function useFixture() {
    const value = React.useContext(context);
    if (!value) throw Error("Missing harness");
    return value;
}
let position = 5;
let errorToasts: string[] = [];
let writes: Array<{ method: string; path: string; body: Progress | null }> = [];
const db: { progress: Progress | null } = { progress: null };
let send: (record: (typeof writes)[number]) => Promise<void> = async (
    record,
) => {
    db.progress = record.method === "DELETE" ? null : record.body;
};
class Base {
    async request(path: string, options: { method: string; body?: string }) {
        const record = {
            path,
            method: options.method,
            body: options.body ? JSON.parse(options.body) : null,
        };
        writes.push(record);
        await send(record);
        return {};
    }
}
class FixtureApi extends WithAudiobooks(
    Base as unknown as ApiClientConstructor,
) {}
const api = new FixtureApi();
mock.module("@/lib/api", { namedExports: { api } });
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: useFixture,
        usePlaybackStatus: useFixture,
        useAudioControls: useFixture,
    },
});
mock.module("@/lib/audio-playback-context", {
    namedExports: { usePlaybackProgress: () => ({ currentTime: position }) },
});
mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                success() {},
                error(message: string) {
                    errorToasts.push(message);
                },
            },
        }),
    },
});
mock.module("@/lib/query-events", {
    namedExports: { dispatchQueryEvent() {} },
});
mock.module("@/lib/logger", {
    namedExports: { frontendLogger: { error() {} } },
});
mock.module("@/lib/audio-engine/audioPlaybackOrchestratorRuntime", {
    namedExports: {
        audioEngine: { getCurrentTime: () => position, getDuration: () => 30 },
    },
});
const book = (id: string) => ({
    id,
    title: id,
    author: "Fixture",
    coverUrl: null,
    duration: 30,
    progress: {
        currentTime: 5,
        progress: 17,
        isFinished: false,
        lastPlayedAt: "2026-10-13T00:00:00Z",
    },
});
function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}
async function mount() {
    const { useAudiobookActions } =
        await import("../../features/audiobook/hooks/useAudiobookActions");
    const { useProgressSaveCallbacks, useProgressPersistence } =
        await import("../../components/player/hooks/useProgressPersistence");
    const { createRoot } = await import("react-dom/client");

    advanceAuthRuntimeGeneration();
    position = 5;
    writes = [];
    errorToasts = [];
    db.progress = null;
    send = async (record) => {
        db.progress = record.method === "DELETE" ? null : record.body;
    };
    const holder = {} as {
        state: FixtureState;
        actions: ReturnType<typeof useAudiobookActions>;
        save: (finished?: boolean) => Promise<void>;
    };
    function Body() {
        const state = useFixture();
        const last = React.useRef(-1),
            interval = React.useRef<NodeJS.Timeout | null>(null);
        const saves = useProgressSaveCallbacks({
            ...state,
            currentPodcast: null,
            isBuffering: false,
            lastProgressSaveRef: last,
        });
        useProgressPersistence({
            ...state,
            ...saves,
            progressSaveIntervalRef: interval,
        });
        const actions = useAudiobookActions(
            state.currentAudiobook?.id ?? "a",
            state.currentAudiobook
                ? {
                      ...state.currentAudiobook,
                      sectionKind: "none",
                      sections: [],
                      sectionsPlayable: false,
                  }
                : null,
            () => {},
        );
        React.useLayoutEffect(() => {
            holder.actions = actions;
            holder.save = saves.saveAudiobookProgress;
            holder.state = state;
        });
        return null;
    }
    function Harness() {
        const [currentAudiobook, setCurrentAudiobook] =
            React.useState<FixtureBook | null>(book("a"));
        const [isPlaying, setPlaying] = React.useState(true);
        const [playbackType, setPlaybackType] =
            React.useState<FixtureState["playbackType"]>("audiobook");
        return React.createElement(
            context.Provider,
            {
                value: {
                    currentAudiobook,
                    setCurrentAudiobook,
                    isPlaying,
                    setPlaying,
                    playbackType,
                    setPlaybackType,
                    pause: () => setPlaying(false),
                    resume: () => {
                        // Central controls contract is independently tested in audioControlsQueueUx.
                        if (currentAudiobook && playbackType === "audiobook")
                            resumeAudiobookProgressWrites(currentAudiobook.id);
                        setPlaying(true);
                    },
                    playAudiobook: (book: FixtureBook) => {
                        resumeAudiobookProgressWrites(book.id);
                        setCurrentAudiobook(book);
                        setPlaybackType("audiobook");
                        setPlaying(true);
                    },
                    updateCurrentTime: (value: number) => {
                        position = value;
                    },
                    seek: () => {},
                },
            },
            React.createElement(Body),
        );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    return {
        holder,
        async unmount() {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}
test("manual finish survives the pause autosave using actual hooks and API request bodies", async () => {
    const h = await mount();
    try {
        await React.act(async () => h.holder.actions.handleMarkAsCompleted());
        assert.equal(db.progress?.isFinished, true);
        assert.equal(db.progress?.currentTime, 30);
        assert.equal(
            h.holder.state.currentAudiobook?.progress?.isFinished,
            true,
        );
    } finally {
        await h.unmount();
    }
});
test("manual reset survives the pause autosave", async () => {
    const h = await mount();
    try {
        await React.act(async () => h.holder.actions.handleResetProgress());
        assert.equal(db.progress, null);
        assert.equal(h.holder.state.currentAudiobook, null);
        assert.equal(h.holder.state.playbackType, null);
        assert.equal(position, 0);
        assert.equal(writes.at(-1)?.method, "DELETE");
    } finally {
        await h.unmount();
    }
});
test("held autosave cannot arrive after and overwrite manual finish", async () => {
    const h = await mount(),
        held = deferred();
    try {
        let first = true;
        send = async (record) => {
            if (first) {
                first = false;
                await held.promise;
            }
            db.progress = record.method === "DELETE" ? null : record.body;
        };
        let auto!: Promise<void>, finish!: Promise<void>;
        await React.act(async () => {
            auto = h.holder.save();
        });
        await React.act(async () => {
            finish = h.holder.actions.handleMarkAsCompleted();
        });
        await React.act(async () => {
            held.resolve();
            await Promise.all([auto, finish]);
        });
        assert.equal(db.progress?.isFinished, true);
        assert.equal(
            h.holder.state.currentAudiobook?.progress?.isFinished,
            true,
        );
    } finally {
        held.resolve();
        await h.unmount();
    }
});
test("held autosave response cannot replace another active book", async () => {
    const h = await mount(),
        held = deferred();
    try {
        send = async () => held.promise;
        let pending!: Promise<void>;
        await React.act(async () => {
            pending = h.holder.save();
        });
        await React.act(async () =>
            h.holder.state.setCurrentAudiobook(book("b")),
        );
        await React.act(async () => {
            held.resolve();
            await pending;
        });
        assert.equal(h.holder.state.currentAudiobook?.id, "b");
    } finally {
        held.resolve();
        await h.unmount();
    }
});

test("held autosave completes before manual reset DELETE", async () => {
    const h = await mount(),
        held = deferred();
    try {
        let first = true;
        send = async (record) => {
            if (first) {
                first = false;
                await held.promise;
            }
            db.progress = record.method === "DELETE" ? null : record.body;
        };
        let auto!: Promise<void>, reset!: Promise<void>;
        await React.act(async () => {
            auto = h.holder.save();
        });
        await React.act(async () => {
            reset = h.holder.actions.handleResetProgress();
        });
        assert.equal(
            writes.length,
            1,
            "manual DELETE waits for the already sent save",
        );
        await React.act(async () => {
            held.resolve();
            await Promise.all([auto, reset]);
        });
        assert.equal(db.progress, null);
        assert.equal(writes.at(-1)?.method, "DELETE");
        assert.equal(h.holder.state.currentAudiobook, null);
    } finally {
        held.resolve();
        await h.unmount();
    }
});
test("finish in flight suppresses the automatic save caused by pause", async () => {
    const h = await mount(),
        held = deferred();
    try {
        send = async (record) => {
            await held.promise;
            db.progress = record.body;
        };
        let finish!: Promise<void>;
        await React.act(async () => {
            finish = h.holder.actions.handleMarkAsCompleted();
        });
        assert.equal(writes.length, 1);
        assert.equal(writes[0].body?.isFinished, true);
        await React.act(async () => {
            await h.holder.save();
        });
        assert.equal(writes.length, 1);
        await React.act(async () => {
            held.resolve();
            await finish;
        });
        assert.equal(db.progress?.isFinished, true);
    } finally {
        held.resolve();
        await h.unmount();
    }
});
test("account revocation prevents a queued manual request from using new credentials", async () => {
    const h = await mount(),
        held = deferred();
    try {
        send = async () => held.promise;
        let auto!: Promise<void>, finish!: Promise<void>;
        await React.act(async () => {
            auto = h.holder.save();
        });
        await React.act(async () => {
            finish = h.holder.actions.handleMarkAsCompleted();
        });
        advanceAuthRuntimeGeneration();
        await React.act(async () => {
            held.resolve();
            await Promise.all([auto, finish]);
        });
        assert.equal(writes.length, 1);
        assert.equal(
            h.holder.state.currentAudiobook?.progress?.isFinished,
            false,
        );
    } finally {
        held.resolve();
        await h.unmount();
    }
});
test("a captured callback is inert after account revocation even before another render", async () => {
    const h = await mount();
    try {
        const save = h.holder.save,
            finish = h.holder.actions.handleMarkAsCompleted;
        advanceAuthRuntimeGeneration();
        await React.act(async () => {
            await save();
            await finish();
        });
        assert.equal(writes.length, 0);
    } finally {
        await h.unmount();
    }
});
test("held finish response cannot replace a newly selected book", async () => {
    const h = await mount(),
        held = deferred();
    try {
        send = async () => held.promise;
        let finish!: Promise<void>;
        await React.act(async () => {
            finish = h.holder.actions.handleMarkAsCompleted();
        });
        await React.act(async () =>
            h.holder.state.setCurrentAudiobook(book("b")),
        );
        await React.act(async () => {
            held.resolve();
            await finish;
        });
        assert.equal(h.holder.state.currentAudiobook?.id, "b");
        assert.equal(
            h.holder.state.currentAudiobook?.progress?.isFinished,
            false,
        );
    } finally {
        held.resolve();
        await h.unmount();
    }
});
test("latest manual reset wins over an already sent finish", async () => {
    const h = await mount(),
        held = deferred();
    try {
        let first = true;
        send = async (record) => {
            if (first) {
                first = false;
                await held.promise;
            }
            db.progress = record.method === "DELETE" ? null : record.body;
        };
        let finish!: Promise<void>, reset!: Promise<void>;
        await React.act(async () => {
            finish = h.holder.actions.handleMarkAsCompleted();
        });
        await React.act(async () => {
            reset = h.holder.actions.handleResetProgress();
        });
        await React.act(async () => {
            held.resolve();
            await Promise.all([finish, reset]);
        });
        assert.equal(db.progress, null);
        assert.equal(writes.at(-1)?.method, "DELETE");
        assert.equal(h.holder.state.currentAudiobook, null);
    } finally {
        held.resolve();
        await h.unmount();
    }
});
test("failed manual completion permits a retry and does not poison the write queue", async () => {
    const h = await mount();
    try {
        send = async () => {
            throw Error("temporary error");
        };
        await React.act(async () => h.holder.actions.handleMarkAsCompleted());
        assert.equal(
            h.holder.state.currentAudiobook?.progress?.isFinished,
            false,
        );
        send = async (record) => {
            db.progress = record.body;
        };
        await React.act(async () => h.holder.actions.handleMarkAsCompleted());
        assert.equal(db.progress?.isFinished, true);
        assert.equal(
            h.holder.state.currentAudiobook?.progress?.isFinished,
            true,
        );
    } finally {
        await h.unmount();
    }
});
test("failed automatic save can retry the identical position", async () => {
    const h = await mount();
    try {
        send = async () => {
            throw Error("temporary error");
        };
        await React.act(async () => h.holder.save());
        send = async (record) => {
            db.progress = record.body;
        };
        await React.act(async () => h.holder.save());
        assert.equal(writes.length, 2);
        assert.equal(db.progress?.currentTime, 5);
    } finally {
        await h.unmount();
    }
});
test("explicit resume starts a new progress session after a manual finish", async () => {
    const h = await mount();
    try {
        await React.act(async () => h.holder.actions.handleMarkAsCompleted());
        assert.equal(db.progress?.isFinished, true);
        await React.act(async () => h.holder.state.resume());
        position = 8;
        await React.act(async () => h.holder.save());
        assert.equal(db.progress?.isFinished, false);
        assert.equal(db.progress?.currentTime, 8);
        assert.equal(
            h.holder.state.currentAudiobook?.progress?.isFinished,
            false,
        );
    } finally {
        await h.unmount();
    }
});
test("reset then explicit replay allows saving progress for the same book", async () => {
    const h = await mount();
    try {
        await React.act(async () => h.holder.actions.handleResetProgress());
        await React.act(async () => {
            h.holder.state.playAudiobook(book("a"));
        });
        position = 2;
        await React.act(async () => h.holder.save());
        assert.equal(db.progress?.currentTime, 2);
        assert.equal(db.progress?.isFinished, false);
    } finally {
        await h.unmount();
    }
});
test("returning to the same book cannot revive a response from its prior activation", async () => {
    const h = await mount(),
        held = deferred();
    try {
        send = async () => held.promise;
        let auto!: Promise<void>;
        await React.act(async () => {
            auto = h.holder.save();
        });
        await React.act(async () =>
            h.holder.state.setCurrentAudiobook(book("b")),
        );
        await React.act(async () =>
            h.holder.state.setCurrentAudiobook({
                ...book("a"),
                title: "new activation",
            }),
        );
        await React.act(async () => {
            held.resolve();
            await auto;
        });
        assert.equal(h.holder.state.currentAudiobook?.title, "new activation");
        assert.equal(h.holder.state.currentAudiobook?.progress?.currentTime, 5);
    } finally {
        held.resolve();
        await h.unmount();
    }
});

test("superseded manual failure does not surface an obsolete error", async () => {
    const h = await mount(),
        held = deferred();
    try {
        let first = true;
        send = async (record) => {
            if (first) {
                first = false;
                await held.promise;
            }
            db.progress = record.body;
        };
        let old!: Promise<void>, latest!: Promise<void>;
        await React.act(async () => {
            old = h.holder.actions.handleMarkAsCompleted();
        });
        await React.act(async () => {
            latest = h.holder.actions.handleMarkAsCompleted();
        });
        await React.act(async () => {
            held.reject(Error("old failure"));
            await Promise.all([old, latest]);
        });
        assert.equal(db.progress?.isFinished, true);
        assert.deepEqual(errorToasts, []);
    } finally {
        held.resolve();
        await h.unmount();
    }
});

test("adversarial: queued selection of B keeps playback type and clock after A reset settles", async (t) => {
    const h = await mount(),
        held = deferred();
    try {
        send = async () => held.promise;
        let pending!: Promise<void>;
        await React.act(async () => {
            pending = h.holder.actions.handleResetProgress();
        });
        await React.act(async () => {
            h.holder.state.setPlaybackType("audiobook");
            h.holder.state.setCurrentAudiobook({
                ...book("b"),
                progress: { ...book("b").progress, currentTime: 11 },
            });
            h.holder.state.setPlaying(true);
            position = 11;
            held.resolve();
            await pending;
        });
        t.diagnostic(
            JSON.stringify({
                book: h.holder.state.currentAudiobook?.id,
                playbackType: h.holder.state.playbackType,
                clock: position,
                isPlaying: h.holder.state.isPlaying,
            }),
        );
        assert.equal(h.holder.state.currentAudiobook?.id, "b");
        assert.equal(h.holder.state.playbackType, "audiobook");
        assert.equal(position, 11);
    } finally {
        held.resolve();
        await h.unmount();
    }
});

test("adversarial: explicit same-book resume queued before Reset response keeps the resumed book", async (t) => {
    const h = await mount(),
        held = deferred();
    try {
        send = async () => held.promise;
        let pending!: Promise<void>;
        await React.act(async () => {
            pending = h.holder.actions.handleResetProgress();
        });
        await React.act(async () => {
            h.holder.state.resume();
            position = 11;
            held.resolve();
            await pending;
        });
        t.diagnostic(
            JSON.stringify({
                book: h.holder.state.currentAudiobook?.id,
                playbackType: h.holder.state.playbackType,
                clock: position,
                isPlaying: h.holder.state.isPlaying,
            }),
        );
        assert.equal(h.holder.state.currentAudiobook?.id, "a");
        assert.equal(h.holder.state.playbackType, "audiobook");
        assert.equal(position, 11);
    } finally {
        held.resolve();
        await h.unmount();
    }
});

test("committing resume cannot revoke a newer completion intent", async () => {
    const h = await mount();
    try {
        await React.act(async () => h.holder.actions.handleMarkAsCompleted());
        await React.act(async () => {
            h.holder.state.resume();
            await h.holder.actions.handleMarkAsCompleted();
        });
        position = 11;
        await React.act(async () => h.holder.save());
        assert.equal(db.progress?.isFinished, true);
    } finally {
        await h.unmount();
    }
});
