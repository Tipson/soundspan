import { reorderLockedPlaylistItems } from "../playlistMutationLock";

describe("reorderLockedPlaylistItems", () => {
    it("can swap duplicate track occurrences without a transient unique conflict", async () => {
        const items = [
            { id: "item-first", trackId: "track-repeat", sort: 0 },
            { id: "item-second", trackId: "track-repeat", sort: 1 },
        ];
        const updateItem = jest.fn(
            async ({
                where,
                data,
            }: {
                where: { id: string };
                data: { sort: number };
            }) => {
                const item = items.find(
                    (candidate) => candidate.id === where.id,
                );
                if (!item) throw new Error("missing playlist item");
                const conflicts = items.some(
                    (candidate) =>
                        candidate.id !== item.id &&
                        candidate.trackId === item.trackId &&
                        candidate.sort === data.sort,
                );
                if (conflicts) throw new Error("duplicate position reference");
                item.sort = data.sort;
                return item;
            },
        );
        const tx = {
            $queryRaw: jest
                .fn()
                .mockResolvedValue([
                    { id: "playlist-1", userId: "user-1", mixId: null },
                ]),
            playlistItem: {
                aggregate: jest.fn().mockResolvedValue({ _max: { sort: 1 } }),
                findMany: jest.fn(),
                update: updateItem,
            },
            playlist: {
                update: jest.fn().mockResolvedValue({}),
            },
        };

        await reorderLockedPlaylistItems(
            tx as never,
            "playlist-1",
            "user-1",
            ["item-second", "item-first"],
            true,
        );

        expect(items).toEqual([
            { id: "item-first", trackId: "track-repeat", sort: 1 },
            { id: "item-second", trackId: "track-repeat", sort: 0 },
        ]);
        expect(updateItem).toHaveBeenCalledTimes(4);
    });
});
