const submit = jest.fn();
const record = jest.fn();
const updateMany = jest.fn();
const findMany = jest.fn();
const add = jest.fn();
const disableCurrent = jest.fn();
jest.mock("../../../services/scrobbleConnections", () => ({
    disableInvalidScrobblerIfCurrent: (...args: unknown[]) =>
        disableCurrent(...args),
}));

jest.mock("../../../services/scrobbleSubmission", () => ({
    submitScrobbleJob: submit,
    InvalidScrobbleAuthError: class InvalidScrobbleAuthError extends Error {
        constructor(
            public readonly encryptedCredential?: string,
            public readonly connectionId?: string,
            public readonly authEpoch?: number,
        ) {
            super();
        }
    },
}));
jest.mock("../../../metrics", () => ({ recordScrobbleOutcome: record }));
jest.mock("../../../utils/db", () => ({
    prisma: { scrobbleConnection: { updateMany, findMany } },
}));
jest.mock("../../../workers/queues", () => ({
    scrobbleQueue: { add },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));

import { processScrobble } from "../scrobbleProcessor";
import { InvalidScrobbleAuthError } from "../../../services/scrobbleSubmission";
import { forwardScrobble } from "../../../services/scrobbleForwarder";

const job = (attemptsMade: number, attempts = 3) =>
    ({
        data: {
            service: "lastfm",
            userId: "user-1",
            kind: "scrobble",
            listenedAtSeconds: 1_700_000_000,
            track: { artist: "Artist", title: "Track" },
        },
        attemptsMade,
        opts: { attempts },
    }) as never;

describe("processScrobble", () => {
    it("preserves the generation fence for an in-flight failure with unchanged ciphertext", async () => {
        submit.mockRejectedValue(
            new InvalidScrobbleAuthError(
                "same-cipher",
                "connection-original",
                7,
            ),
        );
        await processScrobble(job(0));
        expect(disableCurrent).toHaveBeenCalledWith(
            "user-1",
            "lastfm",
            "same-cipher",
            { connectionId: "connection-original", authEpoch: 7 },
        );
    });
    it("uses the owner/authorization fence for a failed legacy credential", async () => {
        disableCurrent.mockResolvedValue(true);
        submit.mockRejectedValue(new InvalidScrobbleAuthError("cipher-old"));
        await expect(processScrobble(job(0))).resolves.toBe("invalid_auth");
        expect(disableCurrent).toHaveBeenCalledWith(
            "user-1",
            "lastfm",
            "cipher-old",
        );
    });
    beforeEach(() => {
        jest.clearAllMocks();
        disableCurrent.mockReset().mockResolvedValue(true);
        updateMany.mockResolvedValue({ count: 1 });
        add.mockResolvedValue({ id: "job-1" });
    });

    it("records a retry and rethrows before attempts are exhausted", async () => {
        submit.mockRejectedValue(new Error("temporary"));

        await expect(processScrobble(job(0))).rejects.toThrow("temporary");
        expect(record).toHaveBeenCalledWith("lastfm", "retried");
    });

    it("drops a transient failure after the final attempt", async () => {
        submit.mockRejectedValue(new Error("still unavailable"));

        await expect(processScrobble(job(2))).resolves.toEqual("dropped");
        expect(record).toHaveBeenCalledWith("lastfm", "dropped");
    });

    it("disables invalid authentication and excludes it from later forwarding", async () => {
        let enabled = true;
        disableCurrent.mockImplementation(async () => {
            enabled = false;
            return true;
        });
        findMany.mockImplementation(async () =>
            enabled ? [{ service: "lastfm" }] : [],
        );
        submit.mockRejectedValue(new InvalidScrobbleAuthError("cipher-old"));

        await expect(processScrobble(job(0))).resolves.toEqual("invalid_auth");
        expect(disableCurrent).toHaveBeenCalledWith(
            "user-1",
            "lastfm",
            "cipher-old",
        );
        expect(record).toHaveBeenCalledWith("lastfm", "invalid_auth");

        await forwardScrobble({
            userId: "user-1",
            mediaType: "music",
            kind: "scrobble",
            listenedAt: new Date(1_700_000_000_000),
            track: { artist: "Artist", title: "Track" },
        });

        expect(add).not.toHaveBeenCalled();
    });

    it("never disables a reauthenticated credential from a stale in-flight job", async () => {
        // The failed submission used the OLD credential; the disable must
        // compare-and-swap on that exact ciphertext, so a row holding a new
        // credential is left untouched (updateMany matches zero rows).
        disableCurrent.mockResolvedValue(false);
        submit.mockRejectedValue(new InvalidScrobbleAuthError("cipher-old"));

        await expect(processScrobble(job(0))).resolves.toEqual("invalid_auth");
        expect(disableCurrent).toHaveBeenCalledWith(
            "user-1",
            "lastfm",
            "cipher-old",
        );
    });

    it("skips the disable entirely when no credential was in play", async () => {
        submit.mockRejectedValue(new InvalidScrobbleAuthError());

        await expect(processScrobble(job(0))).resolves.toEqual("invalid_auth");
        expect(disableCurrent).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
    });
});
