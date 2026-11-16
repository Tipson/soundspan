import type { PrismaClient } from "@prisma/client";
import { createPlayScrobbleDispatcher } from "../playScrobbleDispatch";
import { ScrobbleBeforeHandoffError } from "../../services/playScrobbleSubmission";

/** In-memory persistence exercises transport decisions; real PG tests cover locks/atomicity separately. */
function fixture() {
    let now = new Date(1_800_000_000_000);
    const connection = {
        id: "connection",
        userId: "owner",
        service: "listenbrainz",
        authEpoch: 0,
        enabled: true,
        encryptedCredential: "cipher",
    };
    const row: any = {
        id: "a".repeat(64),
        userId: "owner",
        state: "PENDING",
        availableAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
        claimToken: null,
        claimExpiresAt: null,
        connectionId: connection.id,
        connection,
        playId: "play",
        play: { userId: "owner" },
        authEpoch: 0,
        userTokenVersion: 0,
        attemptCount: 0,
        listenedAt: now,
        service: connection.service,
        metadata: { artist: "Artist", title: "Track" },
    };
    const matches = (where: any) =>
        Object.entries(where).every(([key, value]) =>
            key === "connectionId"
                ? row.connectionId === value
                : key === "authEpoch"
                  ? row.authEpoch === value
                  : row[key] === value,
        );
    const database: any = {
        $transaction: (work: (transaction: any) => Promise<unknown>) =>
            work(database),
        $queryRaw: jest.fn(async () => [
            { id: "owner", epoch: 0, prunedThrough: null, tokenVersion: 0 },
        ]),
        playScrobbleDispatch: {
            findFirst: async ({ where }: any) =>
                matches(where) ? { ...row } : null,
            updateMany: async ({ where, data }: any) => {
                if (!matches(where)) return { count: 0 };
                Object.assign(row, data, {
                    attemptCount: data.attemptCount?.increment
                        ? row.attemptCount + data.attemptCount.increment
                        : row.attemptCount,
                });
                return { count: 1 };
            },
        },
        scrobbleConnection: {
            findFirst: async ({ where }: any) =>
                Object.entries(where).every(
                    ([key, value]) => (connection as any)[key] === value,
                )
                    ? { ...connection }
                    : null,
            updateMany: async () => {
                connection.enabled = false;
                connection.authEpoch++;
                return { count: 1 };
            },
        },
    };
    const submit = jest.fn().mockResolvedValue("submitted");
    const decryptCredential = jest.fn().mockReturnValue("synthetic");
    const record = jest.fn();
    const process = createPlayScrobbleDispatcher(database as PrismaClient, {
        clock: () => now,
        submit,
        decryptCredential,
        resolveLastFmCredentials: async () => ({
            apiKey: "synthetic",
            sharedSecret: "synthetic",
        }),
        record,
    });
    return {
        row,
        connection,
        database,
        submit,
        decryptCredential,
        record,
        process,
        wake: { version: 1, dispatchId: row.id, userId: row.userId },
        advance: (ms: number) => {
            now = new Date(now.getTime() + ms);
        },
    };
}

test("strict wakeups and owner absence never contact a provider", async () => {
    const f = fixture();
    expect(await f.process({ ...f.wake, token: "invalid-field" })).toBe(
        "ignored",
    );
    f.database.$queryRaw.mockResolvedValue([]);
    expect(await f.process(f.wake)).toBe("ignored");
    expect(f.submit).not.toHaveBeenCalled();
});

test("an accepted ACK commits one terminal outcome; a duplicate cannot hand off again", async () => {
    const f = fixture();
    expect(await f.process(f.wake)).toBe("SUBMITTED");
    expect(await f.process(f.wake)).toBe("ignored");
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.row).toMatchObject({
        state: "SUBMITTED",
        claimToken: null,
        attemptCount: 1,
    });
    expect(f.record).toHaveBeenCalledWith(
        "listenbrainz",
        "SUBMITTED",
        "ack_submitted",
    );
});

test.each(["ambiguous", "rejected", "invalid_auth"] as const)(
    "%s is terminal and is not automatically retried",
    async (ack) => {
        const f = fixture();
        f.submit.mockResolvedValue(ack);
        await f.process(f.wake);
        await f.process(f.wake);
        expect(f.row.state).toBe(
            ack === "ambiguous"
                ? "AMBIGUOUS"
                : ack === "rejected"
                  ? "REJECTED"
                  : "INVALID_AUTH",
        );
        expect(f.submit).toHaveBeenCalledTimes(1);
        if (ack === "invalid_auth")
            expect(f.connection).toMatchObject({
                enabled: false,
                authEpoch: 1,
            });
    },
);

test("only a proved pre-handoff configuration failure gets a bounded retry", async () => {
    const f = fixture();
    f.submit.mockRejectedValue(
        new ScrobbleBeforeHandoffError("configuration_unavailable"),
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
        await f.process(f.wake);
        expect(f.row.attemptCount).toBe(attempt);
        f.advance(60_000);
    }
    expect(f.row.state).toBe("FAILED_NOT_SENT");
    await f.process(f.wake);
    expect(f.submit).toHaveBeenCalledTimes(3);
    const unknown = fixture();
    unknown.submit.mockRejectedValue(
        new Error("socket reset after possible accept"),
    );
    expect(await unknown.process(unknown.wake)).toBe("AMBIGUOUS");
});

test("expired, missing and revoked targets are terminal without handoff", async () => {
    for (const kind of ["expired", "missing", "revoked", "metadata"] as const) {
        const f = fixture();
        if (kind === "expired") f.advance(86_400_001);
        if (kind === "missing") f.row.play = null;
        if (kind === "revoked") f.connection.authEpoch++;
        if (kind === "metadata")
            f.row.metadata = { credential: "never-allowed" };
        await f.process(f.wake);
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.row.state).toBe(
            kind === "missing"
                ? "NO_TARGET"
                : kind === "metadata"
                  ? "REJECTED"
                  : "CANCELLED",
        );
    }
});

test("revocation or expired lease during preparation prevents the HTTP call", async () => {
    for (const expired of [false, true]) {
        const f = fixture();
        f.decryptCredential.mockImplementation(() => {
            if (expired) f.advance(30_001);
            else f.connection.authEpoch++;
            return "synthetic";
        });
        await f.process(f.wake);
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.row.state).toBe("AMBIGUOUS");
    }
    const f = fixture();
    f.decryptCredential.mockImplementation(() => {
        throw new Error("no server decryption configuration");
    });
    expect(await f.process(f.wake)).toBe("PENDING");
    expect(f.submit).not.toHaveBeenCalled();
});
