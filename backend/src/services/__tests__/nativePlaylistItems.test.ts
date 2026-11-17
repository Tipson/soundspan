import { formatUnifiedTrackItem } from "../unifiedTrackResponse";

const recording = (provider: "vk" | "yandex") => ({
    provider,
    id: provider === "vk" ? "-123_456" : "123456",
    title: "Сохранённое название",
    artists: ["Исполнитель"],
    duration: 182.5,
    contentVersion: "unknown" as const,
    preview: false as const,
});

function item(provider: "vk" | "yandex") {
    const snapshot = recording(provider);
    return {
        id: "playlist-item-7",
        playlistId: "owner-playlist",
        sort: 7,
        trackId: null,
        trackTidalId: null,
        trackYtMusicId: null,
        track: null,
        trackTidal: null,
        trackYtMusic: null,
        trackMusicSourceId: "namespace-1" as string | null,
        trackMusicSource: {
            provider,
            providerTrackId: snapshot.id,
            verifiedMetadata: { title: "Название из другого контекста" },
        } as {
            provider: string;
            providerTrackId: string;
            verifiedMetadata: unknown;
        } | null,
        musicSourceRecording: snapshot as unknown,
    };
}

describe("native playlist snapshot projection", () => {
    it.each(["vk", "yandex"] as const)(
        "keeps the playlist item and exact %s recording identity separate",
        (provider) => {
            const input = item(provider);
            const result = formatUnifiedTrackItem(input);
            expect(result).toMatchObject({
                id: "playlist-item-7",
                playlistId: "owner-playlist",
                sort: 7,
                provider: { source: provider },
                playback: { isPlayable: true },
                track: {
                    id: `${provider}:${recording(provider).id}`,
                    title: "Сохранённое название",
                    source: provider,
                    musicSourceRecording: recording(provider),
                    provider: {
                        source: provider,
                        providerTrackId: recording(provider).id,
                    },
                },
            });
            expect(JSON.stringify(result)).not.toContain(
                "Название из другого контекста",
            );
        },
    );

    it.each(["vk", "yandex"] as const)(
        "retains the saved %s identity after the namespace reference is removed",
        (provider) => {
            const input = item(provider);
            input.trackMusicSourceId = null;
            input.trackMusicSource = null;
            expect(formatUnifiedTrackItem(input)).toMatchObject({
                id: input.id,
                playback: { isPlayable: true },
                track: { id: `${provider}:${recording(provider).id}` },
            });
        },
    );

    it.each(["vk", "yandex"] as const)(
        "rejects a %s snapshot attached to a different surviving namespace",
        (provider) => {
            const input = item(provider);
            input.trackMusicSource!.providerTrackId = "999";
            expect(formatUnifiedTrackItem(input)).toMatchObject({
                playback: { isPlayable: false },
                track: null,
            });
        },
    );

    it.each(["trackId", "trackTidalId", "trackYtMusicId"] as const)(
        "does not turn a mixed native/%s claim into a playable legacy track",
        (field) => {
            const input = {
                ...item("vk"),
                [field]: "other-recording",
                track: {
                    id: "other-recording",
                    title: "Другая песня",
                    duration: 100,
                    album: {
                        title: "Другой альбом",
                        artist: { name: "Другой" },
                    },
                },
            };
            expect(formatUnifiedTrackItem(input)).toMatchObject({
                playback: { isPlayable: false },
                track: null,
            });
        },
    );

    it("projects only the bounded snapshot fields, without URLs, grants or credentials", () => {
        const input = item("vk");
        input.musicSourceRecording = {
            ...recording("vk"),
            streamUrl: "https://private.invalid/secret-audio",
            grant: "private-grant",
            token: "private-token",
        };
        const result = formatUnifiedTrackItem(input);
        expect(result.track).toMatchObject({
            musicSourceRecording: recording("vk"),
        });
        expect(JSON.stringify(result)).not.toMatch(
            /private\.invalid|private-grant|private-token/,
        );
    });

    it.each([
        { preview: true },
        { duration: 0 },
        { duration: 3601 },
        { artists: [] },
        { id: "not-a-provider-id" },
    ])("keeps malformed saved metadata unavailable: %j", (delta) => {
        const input = item("vk");
        input.musicSourceRecording = { ...recording("vk"), ...delta };
        expect(formatUnifiedTrackItem(input)).toMatchObject({
            playback: { isPlayable: false },
            track: null,
        });
    });
});
