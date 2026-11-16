jest.mock("../../utils/ioredis", () => ({ createIORedisClient: jest.fn() }));
describe("bounded Redis dispatch wakeups", () => {
    test("the real Bull producer bounds an unresponsive local peer and closes while connecting", async () => {
        const net = require("node:net") as typeof import("node:net");
        const Redis = require("ioredis")
            .default as typeof import("ioredis").default;
        const sockets = new Set<import("node:net").Socket>();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            socket.resume();
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const port = (server.address() as import("node:net").AddressInfo).port;
        const create = jest.requireMock(
            "../../utils/ioredis",
        ).createIORedisClient;
        let client!: import("ioredis").default;
        create.mockImplementation((_label: string, options: object) => {
            client = new Redis(`redis://127.0.0.1:${port}`, options);
            client.on("error", () => {});
            return client;
        });
        const {
            createRuntimePlayScrobbleWakeupProducer,
        } = require("../playScrobbleDispatchWakeup");
        const producer = createRuntimePlayScrobbleWakeupProducer();
        try {
            await new Promise<void>((resolve) => client.once("ready", resolve));
            const started = performance.now();
            await expect(
                producer.enqueue({
                    version: 1,
                    dispatchId: "a".repeat(64),
                    userId: "owner",
                }),
            ).rejects.toThrow("Command timed out");
            expect(performance.now() - started).toBeLessThan(3_000);
            expect(create).toHaveBeenCalledTimes(1);
            expect(create.mock.calls[0][1]).toMatchObject({
                commandTimeout: 2_000,
                maxRetriesPerRequest: 0,
                enableOfflineQueue: false,
            });
        } finally {
            await producer.close();
            client.disconnect();
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        create.mockImplementation((_label: string, options: object) => {
            client = new Redis(`redis://127.0.0.1:${port}`, options);
            client.on("error", () => {});
            return client;
        });
        const offline = createRuntimePlayScrobbleWakeupProducer();
        await expect(
            offline.enqueue({
                version: 1,
                dispatchId: "a".repeat(64),
                userId: "owner",
            }),
        ).rejects.toThrow("dispatch_wakeup_unavailable");
        const closing = performance.now();
        await offline.close();
        expect(performance.now() - closing).toBeLessThan(1_000);
    }, 10_000);
    test("offline enqueue fails before add, a single ready add uses attempts=1, and stop awaits close", async () => {
        const {
            createPlayScrobbleWakeupProducer,
        } = require("../playScrobbleDispatchWakeup");
        const client = { status: "connecting", disconnect: jest.fn() };
        let closed!: () => void;
        const queue = {
            add: jest.fn().mockResolvedValue({}),
            close: jest.fn(
                () =>
                    new Promise<void>((resolve) => {
                        closed = resolve;
                    }),
            ),
        };
        const producer = createPlayScrobbleWakeupProducer(queue, client);
        const wake = {
            version: 1,
            dispatchId: "a".repeat(64),
            userId: "owner",
        };
        await expect(producer.enqueue(wake)).rejects.toThrow(
            "dispatch_wakeup_unavailable",
        );
        expect(queue.add).not.toHaveBeenCalled();
        client.status = "ready";
        await producer.enqueue(wake);
        expect(queue.add).toHaveBeenCalledTimes(1);
        expect(queue.add).toHaveBeenCalledWith("dispatch-v1", wake, {
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: 200,
        });
        const close = producer.close();
        expect(client.disconnect).not.toHaveBeenCalled();
        closed();
        await close;
        expect(client.disconnect).toHaveBeenCalledTimes(1);
        await expect(producer.enqueue(wake)).rejects.toThrow(
            "dispatch_wakeup_unavailable",
        );
    });
});
