/** A source session belongs to exactly one selection. Late callbacks cannot revive it. */
export function createRecordPlayer(openSource, onChange, count) {
    let generation = 0,
        source = null,
        blocked = false,
        disposed = false;
    const state = { index: 0, status: "paused", playing: false, error: "" };
    const emit = () => onChange({ ...state });
    function invalidate() {
        generation++;
        source?.destroy();
        source = null;
    }
    function fail(error) {
        invalidate();
        state.playing = false;
        state.status = "error";
        state.error = error?.message || "Не удалось загрузить запись.";
        emit();
    }
    async function play() {
        if (blocked || disposed) return;
        state.playing = true;
        state.status = "loading";
        state.error = "";
        emit();
        if (source) {
            try {
                source.play();
            } catch (error) {
                fail(error);
            }
            return;
        }
        const ticket = ++generation;
        try {
            const next = await openSource(state.index, {
                state(value) {
                    if (ticket !== generation || disposed) return;
                    if (blocked) {
                        if (value === "playing" || value === "buffering")
                            source?.pause();
                        return;
                    }
                    if (value === "playing") {
                        state.playing = true;
                        state.status = "playing";
                        state.error = "";
                    } else if (value === "buffering") {
                        if (!state.playing) return;
                        state.status = "loading";
                    } else if (value === "paused" || value === "ended") {
                        if (state.status === "loading" && value === "paused")
                            return;
                        state.playing = false;
                        state.status = "paused";
                    } else if (value === "blocked") {
                        state.playing = false;
                        state.status = "ready";
                        state.error = "Нажми ▶ в окне записи.";
                    }
                    emit();
                },
                error(error) {
                    if (ticket === generation && !disposed) fail(error);
                },
            });
            if (
                ticket !== generation ||
                disposed ||
                blocked ||
                !state.playing
            ) {
                next.destroy();
                return;
            }
            source = next;
            source.play();
        } catch (error) {
            if (ticket === generation && !disposed) fail(error);
        }
    }
    function pause() {
        if (!source) invalidate();
        else source.pause();
        state.playing = false;
        state.status = "paused";
        state.error = "";
        emit();
    }
    function select(index) {
        if (disposed) return;
        const normalized = ((index % count) + count) % count;
        if (normalized === state.index) return;
        const resume = state.playing;
        invalidate();
        state.index = normalized;
        state.playing = false;
        state.status = "paused";
        state.error = "";
        if (resume && !blocked) return play();
        emit();
    }
    return {
        get state() {
            return { ...state };
        },
        toggle() {
            return state.playing ? (pause(), Promise.resolve()) : play();
        },
        pause,
        select,
        step(delta) {
            return select(state.index + delta);
        },
        suspend(value) {
            blocked = value;
            if (value) pause();
        },
        destroy() {
            disposed = true;
            invalidate();
        },
    };
}
