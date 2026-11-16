import {
    prisma,
    getHandler,
    createRes,
    mockTrackFindUnique,
    mockLikedTrackFindUnique,
    mockLikedTrackUpsert,
    mockLikedTrackDeleteMany,
    mockDislikedEntityFindUnique,
    mockDislikedEntityUpsert,
    mockDislikedEntityDeleteMany,
    mockPrismaTransaction,
} from "./libraryRuntime.helpers";

describe("local preference atomic acknowledgements", () => {
    const post = getHandler("post", "/tracks/:id/preference");
    const get = getHandler("get", "/tracks/:id/preference");
    let liked: Date | null;
    let disliked: Date | null;
    let tail: Promise<unknown>;
    const req = (signal: string) =>
        ({
            params: { id: "track-1" },
            user: { id: "user-1" },
            body: { signal },
        }) as any;
    const interleave = async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    beforeEach(() => {
        jest.resetAllMocks();
        liked = null;
        disliked = null;
        tail = Promise.resolve();
        mockTrackFindUnique.mockResolvedValue({ id: "track-1" });
        mockLikedTrackFindUnique.mockImplementation(async () =>
            liked ? { likedAt: liked } : null,
        );
        mockDislikedEntityFindUnique.mockImplementation(async () =>
            disliked ? { dislikedAt: disliked } : null,
        );
        mockLikedTrackUpsert.mockImplementation(async ({ create }) => {
            liked = create.likedAt;
            await interleave();
            return create;
        });
        mockDislikedEntityUpsert.mockImplementation(async ({ create }) => {
            disliked = create.dislikedAt;
            await interleave();
            return create;
        });
        mockLikedTrackDeleteMany.mockImplementation(async () => {
            const count = Number(liked !== null);
            liked = null;
            return { count };
        });
        mockDislikedEntityDeleteMany.mockImplementation(async () => {
            const count = Number(disliked !== null);
            disliked = null;
            return { count };
        });
        // A committed/rolled-back callback models serial transaction admission;
        // the separate PostgreSQL gate checks actual database isolation.
        mockPrismaTransaction.mockImplementation((callback: any) => {
            const result = tail.then(async () => {
                const before = { liked, disliked };
                try {
                    return await callback(prisma);
                } catch (error) {
                    ({ liked, disliked } = before);
                    throw error;
                }
            });
            tail = result.catch(() => undefined);
            return result;
        });
    });

    it("overlapping opposite requests cannot erase both persisted signals", async () => {
        const up = createRes();
        const down = createRes();
        await Promise.all([
            post(req("thumbs_up"), up),
            post(req("thumbs_down"), down),
        ]);
        const read = createRes();
        await get(req("clear"), read);
        expect(read.body.signal).toBe("thumbs_down");
        expect(liked).toBeNull();
        expect(disliked).toBeInstanceOf(Date);
        expect(up.body).toEqual(
            expect.objectContaining({
                signal: "thumbs_up",
                queuePolicy: expect.objectContaining({ effect: "allow" }),
            }),
        );
        expect(down.body).toEqual(
            expect.objectContaining({
                signal: read.body.signal,
                queuePolicy: expect.objectContaining({ effect: "exclude" }),
            }),
        );
    });

    it("a failed opposite-row deletion rolls back the first write without an ACK", async () => {
        disliked = new Date("2026-11-16T00:00:00Z");
        const original = disliked;
        const failure = new Error("Controlled second statement failure");
        mockDislikedEntityDeleteMany.mockRejectedValueOnce(failure);
        const res = createRes();
        await expect(post(req("thumbs_up"), res)).rejects.toBe(failure);
        expect(liked).toBeNull();
        expect(disliked).toBe(original);
        expect(res.body).toBeUndefined();
    });

    it("serialization conflicts stop after the existing three attempts without an ACK", async () => {
        const conflict = Object.assign(
            new Error("Controlled serialization abort"),
            {
                code: "P2034",
            },
        );
        mockPrismaTransaction.mockRejectedValue(conflict);
        const res = createRes();
        await expect(post(req("thumbs_down"), res)).rejects.toBe(conflict);
        expect(mockPrismaTransaction).toHaveBeenCalledTimes(3);
        expect(res.body).toBeUndefined();
        expect(liked).toBeNull();
        expect(disliked).toBeNull();
    });
});
