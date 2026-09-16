import assert from "node:assert/strict";
import { after, test } from "node:test";
import React, { useEffect, useState } from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { NaturalTrackAdvanceOptions } from "../../components/player/commitNaturalTrackAdvance";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

const eligible = {
    isNative: true,
    isHidden: true,
    isPrepared: true,
    isListenTogether: false,
    viaWatchdog: false,
};

for (const scenario of [
    {
        name: "prepared hidden native end",
        conditions: eligible,
        immediate: true,
    },
    {
        name: "foreground end",
        conditions: { ...eligible, isHidden: false },
        immediate: false,
    },
    {
        name: "unprepared source",
        conditions: { ...eligible, isPrepared: false },
        immediate: false,
    },
    {
        name: "another engine",
        conditions: { ...eligible, isNative: false },
        immediate: false,
    },
    {
        name: "synchronized group",
        conditions: { ...eligible, isListenTogether: true },
        immediate: false,
    },
    {
        name: "watchdog recovery",
        conditions: { ...eligible, viaWatchdog: true },
        immediate: false,
    },
]) {
    test(`${scenario.name} commits playback effects at the appropriate boundary`, async (t) => {
        const { createRoot } = await import("react-dom/client");
        const { commitNaturalTrackAdvance } =
            await import("../../components/player/commitNaturalTrackAdvance");
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        const audio = document.createElement("audio");
        const loadedTracks: number[] = [];
        const earlyStarts: string[] = [];
        t.after(async () => {
            await React.act(async () => root.unmount());
            container.remove();
        });

        function Player() {
            const [track, setTrack] = useState(0);
            useEffect(() => {
                loadedTracks.push(track);
            }, [track]);
            useEffect(() => {
                const onEnded = () => {
                    const options: NaturalTrackAdvanceOptions = {
                        ...scenario.conditions,
                        advance: () => setTrack((previous) => previous + 1),
                        startPreparedPlayback: () =>
                            earlyStarts.push(container.textContent ?? ""),
                    };
                    commitNaturalTrackAdvance(options);
                };
                audio.addEventListener("ended", onEnded);
                return () => audio.removeEventListener("ended", onEnded);
            }, []);
            return React.createElement("span", null, `Track ${track}`);
        }

        await React.act(async () => root.render(React.createElement(Player)));
        await React.act(async () => {
            audio.dispatchEvent(new Event("ended"));
            assert.equal(
                container.textContent,
                scenario.immediate ? "Track 1" : "Track 0",
            );
            assert.deepEqual(loadedTracks, scenario.immediate ? [0, 1] : [0]);
            assert.deepEqual(
                earlyStarts,
                scenario.immediate ? ["Track 0"] : [],
                "audio starts before the next React render and its effects",
            );
        });
        assert.equal(container.textContent, "Track 1");
        assert.deepEqual(
            loadedTracks,
            [0, 1],
            "one end event loads exactly one next occurrence",
        );
    });
}
