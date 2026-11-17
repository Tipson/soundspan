interface SnapshotRow {
    artistId: string;
    rgMbid: string;
    position: number;
}

const prisma = {
    $transaction: jest.fn(),
    album: {
        findMany: jest.fn(async () => []),
        createMany: jest.fn(async () => ({ count: 0 })),
    },
    artist: { update: jest.fn() },
    artistCatalogReleaseGroup: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
    },
};

jest.mock("../../../utils/db", () => ({ prisma }));
jest.mock("../../../config", () => ({
    config: { catalogPersistence: { enabled: true } },
}));
jest.mock("../../../metrics", () => ({ recordCatalogWrite: jest.fn() }));

import { persistCatalogReleaseGroups } from "../catalogPersistence";

/** Prisma operations are lazy until awaited, including the array transaction API. */
function deferredOperation<T>(operation: () => T): PromiseLike<T> {
    return {
        then: (resolve, reject) =>
            Promise.resolve().then(operation).then(resolve, reject),
    };
}

it("replaces concurrent disjoint snapshots for one artist instead of merging their release groups", async () => {
    let rows: SnapshotRow[] = [
        { artistId: "artist", rgMbid: "previous", position: 0 },
    ];
    let lockTail = Promise.resolve();
    const deleteMany = ({ where }: { where: { artistId: string } }) =>
        deferredOperation(() => {
            rows = rows.filter((row) => row.artistId !== where.artistId);
            return { count: 1 };
        });
    const createMany = ({ data }: { data: SnapshotRow[] }) =>
        deferredOperation(() => {
            rows.push(...data);
            return { count: data.length };
        });
    prisma.artistCatalogReleaseGroup.deleteMany.mockImplementation(deleteMany);
    prisma.artistCatalogReleaseGroup.createMany.mockImplementation(createMany);
    prisma.artist.update.mockImplementation(() =>
        deferredOperation(() => undefined),
    );
    prisma.$transaction.mockImplementation(async (operations) => {
        let releaseLock: (() => void) | undefined;
        const tx = {
            ...prisma,
            $queryRaw: async (
                _query: TemplateStringsArray,
                artistId: string,
            ) => {
                expect(artistId).toBe("artist");
                const previous = lockTail;
                lockTail = new Promise<void>((resolve) => {
                    releaseLock = resolve;
                });
                await previous;
                return [{ id: artistId }];
            },
        };
        try {
            if (typeof operations === "function") return await operations(tx);
            const results = [];
            for (const operation of operations) results.push(await operation);
            return results;
        } finally {
            releaseLock?.();
        }
    });

    await Promise.all([
        persistCatalogReleaseGroups({
            artistId: "artist",
            releaseGroups: [
                { id: "a-1", title: "A1" },
                { id: "a-2", title: "A2" },
            ],
        }),
        persistCatalogReleaseGroups({
            artistId: "artist",
            releaseGroups: [
                { id: "b-1", title: "B1" },
                { id: "b-2", title: "B2" },
            ],
        }),
    ]);

    const identities = rows.map((row) => row.rgMbid);
    expect([
        ["a-1", "a-2"],
        ["b-1", "b-2"],
    ]).toContainEqual(identities);
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
});
