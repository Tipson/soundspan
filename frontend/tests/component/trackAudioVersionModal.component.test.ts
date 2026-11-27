import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import React from "react";
import type { TrackAudioTarget } from "../../lib/audio/trackAudioVersions";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
after(() => GlobalRegistrator.unregister());

const first = "7ced2bb5-2299-43f9-b036-587cd5b50f27";
const second = "19b2ace6-d28a-4d70-9cb5-44fce755a86e";
const uploads: File[] = [];
const publications: string[] = [];

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getTrackAudioVersions: async () => ({
                draftId: first,
                publishedId: null,
            }),
            uploadTrackAudio: async (_target: TrackAudioTarget, file: File) => {
                uploads.push(file);
                return { draftId: second, publishedId: null };
            },
            publishTrackAudio: async (
                _target: TrackAudioTarget,
                id: string,
            ) => {
                publications.push(id);
                return { draftId: null, publishedId: id };
            },
        },
    },
});

test("a newly picked MP3 must be staged or discarded before publishing an older draft", async (t) => {
    const { createRoot } = await import("react-dom/client");
    const { TrackAudioVersionModal } =
        await import("../../components/ui/TrackAudioVersionModal");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });

    await React.act(async () => {
        root.render(
            React.createElement(TrackAudioVersionModal, {
                target: { source: "library", trackId: "track-1" },
                trackName: "Трек",
                onClose: () => undefined,
            }),
        );
    });

    const button = (label: string) => {
        const result = Array.from(document.querySelectorAll("button")).find(
            (element) => element.textContent === label,
        );
        assert.ok(result, label);
        return result;
    };
    const input =
        document.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(input);
    const file = new File(["sample"], "full.mp3", { type: "audio/mpeg" });
    const choose = () =>
        React.act(async () => {
            Object.defineProperty(input, "files", {
                configurable: true,
                value: [file],
            });
            input.dispatchEvent(new Event("change", { bubbles: true }));
        });

    assert.equal(button("Опубликовать для всех").disabled, false);
    await choose();
    assert.equal(button("Опубликовать для всех").disabled, true);
    await React.act(async () => button("Сбросить выбор файла").click());
    assert.equal(button("Опубликовать для всех").disabled, false);
    await choose();
    await React.act(async () => button("Загрузить черновик").click());
    assert.deepEqual(uploads, [file]);
    assert.deepEqual(publications, []);
    assert.equal(button("Опубликовать для всех").disabled, false);
    const draft = document.querySelector('[aria-label="Прослушать черновик"]');
    assert.equal(
        draft?.getAttribute("src"),
        `/api/track-audio/versions/${second}/stream`,
    );
    await React.act(async () => button("Опубликовать для всех").click());
    assert.deepEqual(publications, [second]);
});
