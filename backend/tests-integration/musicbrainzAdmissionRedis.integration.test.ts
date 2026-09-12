import { redisClient } from "../src/utils/redis";
import { runMusicBrainzRequest } from "../src/services/musicbrainzRequestGate";

const describeWithRedis = process.env.INTEGRATION_REDIS_URL
    ? describe
    : describe.skip;
const key = "soundspan:musicbrainz:dispatch:v1";

describeWithRedis("MusicBrainz shared Redis admission", () => {
    beforeAll(async () => {
        await redisClient.connect();
    });
    beforeEach(async () => {
        await redisClient.del(key);
    });
    afterAll(async () => {
        await redisClient.del(key);
        await redisClient.quit();
    });

    it("atomically separates competing HTTP dispatches on the real Redis server", async () => {
        const starts: number[] = [];
        const dispatch = () =>
            runMusicBrainzRequest(async () => {
                starts.push(Date.now());
                return "ok";
            });
        expect(await Promise.all([dispatch(), dispatch()])).toEqual([
            "ok",
            "ok",
        ]);
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
        expect(await redisClient.pTTL(key)).toBeGreaterThan(0);
    });

    it("retains provider cooldown across subsequent callers and does not extend it on every rejection", async () => {
        const error = {
            response: { status: 503, headers: { "retry-after": "30" } },
        };
        await expect(
            runMusicBrainzRequest(async () => {
                throw error;
            }),
        ).rejects.toBe(error);
        const before = await redisClient.pTTL(key);
        expect(before).toBeGreaterThan(29000);
        let requests = 0;
        await expect(
            runMusicBrainzRequest(async () => {
                requests++;
            }),
        ).rejects.toThrow("deferred");
        expect(requests).toBe(0);
        expect(await redisClient.pTTL(key)).toBeLessThanOrEqual(before);
    });
});
