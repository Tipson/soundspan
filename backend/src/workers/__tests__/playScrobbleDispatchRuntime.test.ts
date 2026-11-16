jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../../utils/encryption", () => ({ decrypt: jest.fn() }));
jest.mock("../../utils/logger", () => ({
    logger: { child: jest.fn().mockReturnValue({ warn: jest.fn() }) },
}));
jest.mock("../../metrics", () => ({
    playScrobbleDispatchMetrics: {
        recordOutcome: jest.fn(),
        recordMaintenance: jest.fn(),
    },
}));
jest.mock("../../services/playAccounting", () => ({
    playAccounting: { pruneExpiredReceipts: jest.fn() },
}));
jest.mock("../../services/scrobbleConnections", () => ({
    resolveLastFmCredentials: jest.fn(),
}));
jest.mock("../../services/playScrobbleSubmission", () => ({
    createScrobbleDispatchSubmitter: jest.fn(),
}));
jest.mock("../playScrobbleDispatch", () => ({
    createPlayScrobbleDispatcher: jest.fn(),
}));
jest.mock("../playScrobbleDispatchMaintenance", () => ({
    createPlayScrobbleMaintenance: jest.fn(),
    createPlayScrobbleMaintenanceLoop: jest.fn(),
}));
jest.mock("../playScrobbleDispatchWakeup", () => ({
    createRuntimePlayScrobbleWakeupProducer: jest.fn(),
}));

function fixture() {
    jest.resetModules();
    const dispatch = jest.fn().mockResolvedValue("ignored");
    const maintenance = {
        start: jest.fn(),
        stop: jest.fn().mockResolvedValue(undefined),
    };
    const producer = {
        enqueue: jest.fn().mockResolvedValue(true),
        close: jest.fn().mockResolvedValue(undefined),
    };
    const dispatchFactory = require("../playScrobbleDispatch")
        .createPlayScrobbleDispatcher as jest.Mock;
    const factories = require("../playScrobbleDispatchMaintenance");
    const producerFactory = require("../playScrobbleDispatchWakeup")
        .createRuntimePlayScrobbleWakeupProducer as jest.Mock;
    dispatchFactory.mockReturnValue(dispatch);
    factories.createPlayScrobbleMaintenance.mockReturnValue(jest.fn());
    factories.createPlayScrobbleMaintenanceLoop.mockReturnValue(maintenance);
    producerFactory.mockReturnValue(producer);
    const runtime = require("../playScrobbleDispatchRuntime");
    const dependencies =
        factories.createPlayScrobbleMaintenance.mock.calls[0][1];
    const failed = factories.createPlayScrobbleMaintenanceLoop.mock.calls[0][1];
    const warn =
        require("../../utils/logger").logger.child.mock.results[0].value.warn;
    return {
        runtime,
        dispatch,
        maintenance,
        producer,
        producerFactory,
        dependencies,
        failed,
        warn,
    };
}

test("the runtime leaves malformed job handling with the strict dispatcher", async () => {
    const f = fixture();
    const data = { version: "unsupported", arbitrary: "untrusted" };
    expect(await f.runtime.processPlayScrobbleDispatch({ data })).toBe(
        "ignored",
    );
    expect(f.dispatch).toHaveBeenCalledWith(data);
});

test("startup reuses one producer; stopped intake cannot enqueue through a closed connection", async () => {
    const f = fixture();
    const wake = { version: 1, dispatchId: "a".repeat(64), userId: "owner" };
    expect(() => f.dependencies.enqueue(wake)).toThrow(
        "dispatch_wakeup_unavailable",
    );
    f.runtime.startPlayScrobbleDispatchMaintenance();
    f.runtime.startPlayScrobbleDispatchMaintenance();
    expect(f.producerFactory).toHaveBeenCalledTimes(1);
    await expect(f.dependencies.enqueue(wake)).resolves.toBe(true);
    expect(f.producer.enqueue).toHaveBeenCalledWith(wake);
    await f.runtime.stopPlayScrobbleDispatchMaintenance();
    expect(() => f.dependencies.enqueue(wake)).toThrow(
        "dispatch_wakeup_unavailable",
    );
    expect(f.producer.close).toHaveBeenCalledTimes(1);
});

test("shutdown waits for the current maintenance batch before closing its wakeup producer", async () => {
    const f = fixture();
    let release!: () => void;
    f.maintenance.stop.mockImplementation(
        () =>
            new Promise<void>((resolve) => {
                release = resolve;
            }),
    );
    f.runtime.startPlayScrobbleDispatchMaintenance();
    const stopping = f.runtime.stopPlayScrobbleDispatchMaintenance();
    await Promise.resolve();
    expect(f.producer.close).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(f.producer.close).toHaveBeenCalledTimes(1);
});

test("receipt retention preserves the owner/batch boundary and maintenance failure logging is finite", async () => {
    const f = fixture();
    const accounting = require("../../services/playAccounting").playAccounting;
    accounting.pruneExpiredReceipts.mockResolvedValue(7);
    await expect(f.dependencies.pruneReceipts("owner", 12)).resolves.toBe(7);
    expect(accounting.pruneExpiredReceipts).toHaveBeenCalledWith("owner", 12);
    expect(() =>
        f.failed(new Error("private transport failure")),
    ).not.toThrow();
    expect(f.warn).toHaveBeenCalledWith(
        "Durable dispatch maintenance pass failed",
    );
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain(
        "private transport failure",
    );
    await expect(
        f.runtime.stopPlayScrobbleDispatchMaintenance(),
    ).resolves.toBeUndefined();
    expect(f.producer.close).not.toHaveBeenCalled();
});
