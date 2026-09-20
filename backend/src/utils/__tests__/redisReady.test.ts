import { EventEmitter } from "node:events";
import { waitForRedisReady } from "../redisReady";

describe("bounded Redis readiness", () => {
    it("waits once and removes temporary listeners before processor registration", async () => {
        const client = Object.assign(new EventEmitter(), {
            status: "connecting",
        });
        const baseline = () => {};
        client.on("error", baseline);
        const ready = waitForRedisReady(client, 100);
        expect(client.listenerCount("ready")).toBe(1);
        client.emit("error", new Error("transient"));
        client.status = "ready";
        client.emit("ready");
        await ready;
        expect(client.listenerCount("ready")).toBe(0);
        expect(client.listenerCount("end")).toBe(0);
        expect(client.listeners("error")).toEqual([baseline]);
    });
    it("does not attach listeners to an already ready connection", async () => {
        const client = Object.assign(new EventEmitter(), { status: "ready" });
        await waitForRedisReady(client, 100);
        expect(client.eventNames()).toEqual([]);
    });
    it("rejects an ended connection and cleans listeners on timeout", async () => {
        const ended = Object.assign(new EventEmitter(), { status: "end" });
        await expect(waitForRedisReady(ended, 10)).rejects.toThrow("ended");
        jest.useFakeTimers();
        try {
            const client = Object.assign(new EventEmitter(), {
                status: "connecting",
            });
            const pending = expect(
                waitForRedisReady(client, 10),
            ).rejects.toThrow("timed out");
            await jest.advanceTimersByTimeAsync(11);
            await pending;
            expect(client.eventNames()).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });
});
