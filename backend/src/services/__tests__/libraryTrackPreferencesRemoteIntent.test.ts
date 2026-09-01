const mockPrisma = {
    dislikedEntity: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    likedRemoteTrack: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    remotePreferenceIntent: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    trackTidal: {
        findUnique: jest.fn(),
    },
    trackYtMusic: {
        findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));

import {
    applyRemoteTrackPreferenceSignal,
    cancelRemoteTrackPreferenceIntent,
    loadRemoteTrackPreference,
    parseRemoteTrackPreferenceReference,
    reserveRemoteTrackPreferenceIntent,
    type RemoteTrackPreferenceReference,
} from "../libraryTrackPreferences";

const USER_ID = "intent-user";
const REFERENCE: RemoteTrackPreferenceReference = {
    provider: "youtube",
    externalId: "intent-video",
};
const REMOTE_TRACK_ID = "yt:intent-video";
const YOUTUBE_ROW_ID = "yt-intent-row";

describe("remote YouTube preference identity validation", () => {
    it.each([
        ["a real YouTube id", "dQw4w9WgXcQ"],
        ["an existing synthetic contract id", "quick-1"],
        ["the bounded compatibility maximum", "A_-".repeat(21) + "Z"],
    ])("accepts %s", (_scenario, externalId) => {
        expect(parseRemoteTrackPreferenceReference(`yt:${externalId}`)).toEqual(
            {
                provider: "youtube",
                externalId,
            },
        );
    });
});

type IntentRow = {
    token: string;
    requestedAt: Date;
} | null;

function installPreferenceStore({
    initialLikedAt = null,
    initialDislikedAt = null,
}: {
    initialLikedAt?: Date | null;
    initialDislikedAt?: Date | null;
} = {}) {
    let likedAt = initialLikedAt;
    let dislikedAt = initialDislikedAt;
    let intent: IntentRow = null;

    mockPrisma.trackYtMusic.findUnique.mockResolvedValue({
        id: YOUTUBE_ROW_ID,
    });
    mockPrisma.likedRemoteTrack.findUnique.mockImplementation(async () =>
        likedAt ? { likedAt } : null,
    );
    mockPrisma.likedRemoteTrack.upsert.mockImplementation(
        async ({ create, update }: any) => {
            likedAt = update.likedAt ?? create.likedAt;
            return {};
        },
    );
    mockPrisma.likedRemoteTrack.deleteMany.mockImplementation(async () => {
        const count = likedAt ? 1 : 0;
        likedAt = null;
        return { count };
    });
    mockPrisma.dislikedEntity.findUnique.mockImplementation(async () =>
        dislikedAt ? { dislikedAt } : null,
    );
    mockPrisma.dislikedEntity.upsert.mockImplementation(
        async ({ create, update }: any) => {
            dislikedAt = update.dislikedAt ?? create.dislikedAt;
            return {};
        },
    );
    mockPrisma.dislikedEntity.deleteMany.mockImplementation(async () => {
        const count = dislikedAt ? 1 : 0;
        dislikedAt = null;
        return { count };
    });
    mockPrisma.remotePreferenceIntent.upsert.mockImplementation(
        async ({ create, update }: any) => {
            intent = {
                token: update.token ?? create.token,
                requestedAt: update.requestedAt ?? create.requestedAt,
            };
            return intent;
        },
    );
    mockPrisma.remotePreferenceIntent.updateMany.mockImplementation(
        async ({ where }: any) => ({
            count:
                intent &&
                where.userId === USER_ID &&
                where.remoteTrackId === REMOTE_TRACK_ID &&
                where.token === intent.token
                    ? 1
                    : 0,
        }),
    );
    mockPrisma.remotePreferenceIntent.deleteMany.mockImplementation(
        async ({ where }: any) => {
            const matches =
                intent &&
                where.userId === USER_ID &&
                where.remoteTrackId === REMOTE_TRACK_ID &&
                where.token === intent.token;
            if (matches) intent = null;
            return { count: matches ? 1 : 0 };
        },
    );

    return {
        snapshot: () => ({ likedAt, dislikedAt, intent }),
    };
}

describe("remote track preference latest-intent ordering", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockPrisma.$transaction.mockImplementation(
            async (operation: (tx: typeof mockPrisma) => Promise<unknown>) =>
                operation(mockPrisma),
        );
    });

    it.each([
        {
            scenario: "equal request timestamps",
            olderRequestedAt: new Date("2026-01-17T12:00:00.000Z"),
            newerRequestedAt: new Date("2026-01-17T12:00:00.000Z"),
        },
        {
            scenario: "wall-clock rollback",
            olderRequestedAt: new Date("2026-01-17T12:00:01.000Z"),
            newerRequestedAt: new Date("2026-01-17T12:00:00.000Z"),
        },
    ])(
        "returns the winning newer dislike after $scenario",
        async ({ olderRequestedAt, newerRequestedAt }) => {
            const store = installPreferenceStore();
            const olderToken = await reserveRemoteTrackPreferenceIntent({
                userId: USER_ID,
                reference: REFERENCE,
                requestedAt: olderRequestedAt,
            });
            const newerToken = await reserveRemoteTrackPreferenceIntent({
                userId: USER_ID,
                reference: REFERENCE,
                requestedAt: newerRequestedAt,
            });

            const newerResult = await applyRemoteTrackPreferenceSignal({
                userId: USER_ID,
                reference: REFERENCE,
                signal: "thumbs_down",
                now: newerRequestedAt,
                intentToken: newerToken,
            });
            mockPrisma.likedRemoteTrack.upsert.mockClear();
            mockPrisma.dislikedEntity.deleteMany.mockClear();
            const staleResult = await applyRemoteTrackPreferenceSignal({
                userId: USER_ID,
                reference: REFERENCE,
                signal: "thumbs_up",
                now: olderRequestedAt,
                intentToken: olderToken,
                likedTarget: {
                    provider: "youtube",
                    trackYtMusicId: YOUTUBE_ROW_ID,
                },
            });

            expect(newerResult.signal).toBe("thumbs_down");
            expect(staleResult.signal).toBe("thumbs_down");
            expect(staleResult.dislikedAt).toEqual(newerRequestedAt);
            expect(store.snapshot()).toEqual({
                likedAt: null,
                dislikedAt: newerRequestedAt,
                intent: expect.objectContaining({ token: newerToken }),
            });
            expect(mockPrisma.likedRemoteTrack.upsert).not.toHaveBeenCalled();
            expect(mockPrisma.dislikedEntity.deleteMany).not.toHaveBeenCalled();
        },
    );

    it("keeps a later clear when an older like resumes", async () => {
        const originalLike = new Date("2026-01-17T11:00:00.000Z");
        const store = installPreferenceStore({ initialLikedAt: originalLike });
        const requestedAt = new Date("2026-01-17T12:00:00.000Z");
        const olderToken = await reserveRemoteTrackPreferenceIntent({
            userId: USER_ID,
            reference: REFERENCE,
            requestedAt,
        });
        const clearToken = await reserveRemoteTrackPreferenceIntent({
            userId: USER_ID,
            reference: REFERENCE,
            requestedAt,
        });

        const clearResult = await applyRemoteTrackPreferenceSignal({
            userId: USER_ID,
            reference: REFERENCE,
            signal: "clear",
            now: requestedAt,
            intentToken: clearToken,
        });
        const staleResult = await applyRemoteTrackPreferenceSignal({
            userId: USER_ID,
            reference: REFERENCE,
            signal: "thumbs_up",
            now: requestedAt,
            intentToken: olderToken,
            likedTarget: {
                provider: "youtube",
                trackYtMusicId: YOUTUBE_ROW_ID,
            },
        });

        expect(clearResult.signal).toBe("clear");
        expect(staleResult.signal).toBe("clear");
        expect(store.snapshot()).toEqual({
            likedAt: null,
            dislikedAt: null,
            intent: expect.objectContaining({ token: clearToken }),
        });
    });

    it("does not revive an older intent after the latest failed request is cleaned up", async () => {
        const store = installPreferenceStore();
        const requestedAt = new Date("2026-01-17T12:00:00.000Z");
        const olderToken = await reserveRemoteTrackPreferenceIntent({
            userId: USER_ID,
            reference: REFERENCE,
            requestedAt,
        });
        const failedLatestToken = await reserveRemoteTrackPreferenceIntent({
            userId: USER_ID,
            reference: REFERENCE,
            requestedAt,
        });

        await cancelRemoteTrackPreferenceIntent({
            userId: USER_ID,
            reference: REFERENCE,
            intentToken: failedLatestToken,
        });
        const staleResult = await applyRemoteTrackPreferenceSignal({
            userId: USER_ID,
            reference: REFERENCE,
            signal: "thumbs_up",
            now: requestedAt,
            intentToken: olderToken,
            likedTarget: {
                provider: "youtube",
                trackYtMusicId: YOUTUBE_ROW_ID,
            },
        });

        expect(staleResult.signal).toBe("clear");
        expect(store.snapshot()).toEqual({
            likedAt: null,
            dislikedAt: null,
            intent: null,
        });
        expect(mockPrisma.likedRemoteTrack.upsert).not.toHaveBeenCalled();
    });

    it("does not let stale cleanup delete a newer request token", async () => {
        const store = installPreferenceStore();
        const requestedAt = new Date("2026-01-17T12:00:00.000Z");
        const staleToken = await reserveRemoteTrackPreferenceIntent({
            userId: USER_ID,
            reference: REFERENCE,
            requestedAt,
        });
        const currentToken = await reserveRemoteTrackPreferenceIntent({
            userId: USER_ID,
            reference: REFERENCE,
            requestedAt,
        });

        await cancelRemoteTrackPreferenceIntent({
            userId: USER_ID,
            reference: REFERENCE,
            intentToken: staleToken,
        });
        const result = await applyRemoteTrackPreferenceSignal({
            userId: USER_ID,
            reference: REFERENCE,
            signal: "thumbs_down",
            now: requestedAt,
            intentToken: currentToken,
        });

        expect(result.signal).toBe("thumbs_down");
        expect(store.snapshot().intent).toEqual(
            expect.objectContaining({ token: currentToken }),
        );
    });

    it("loads like and dislike state from one repeatable-read snapshot", async () => {
        const likedAt = new Date("2026-01-17T11:00:00.000Z");
        installPreferenceStore({ initialLikedAt: likedAt });
        const snapshotClient = {
            ...mockPrisma,
            trackYtMusic: {
                findUnique: jest.fn(async () => ({ id: YOUTUBE_ROW_ID })),
            },
            likedRemoteTrack: {
                ...mockPrisma.likedRemoteTrack,
                findUnique: jest.fn(async () => ({ likedAt })),
            },
            dislikedEntity: {
                ...mockPrisma.dislikedEntity,
                findUnique: jest.fn(async () => null),
            },
        };
        mockPrisma.$transaction.mockImplementationOnce(
            async (
                operation: (tx: typeof snapshotClient) => Promise<unknown>,
                options: { isolationLevel?: string },
            ) => {
                expect(options.isolationLevel).toBe("RepeatableRead");
                return operation(snapshotClient);
            },
        );

        const result = await loadRemoteTrackPreference(USER_ID, REFERENCE);

        expect(result.signal).toBe("thumbs_up");
        expect(result.likedAt).toEqual(likedAt);
        expect(result.dislikedAt).toBeNull();
    });
});
