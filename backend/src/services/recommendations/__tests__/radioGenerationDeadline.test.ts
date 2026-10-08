const mockCreate = jest.fn();
const mockTransaction = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: {
        recommendationGeneration: { create: mockCreate },
        $transaction: mockTransaction,
    },
}));
import { recommendationExposureStore } from "../exposureStore";
import { createRadioRequestExecution } from "../radioRequestExecution";

const input = {
    userId: "alice",
    sessionId: "station-a",
    surface: "wave" as const,
    direction: "for-you" as const,
    mood: null,
    cursor: 0,
    algorithm: "baseline-v1",
    served: true,
    degradedSources: [],
    latencyMs: 1,
    recommendations: [],
};
beforeEach(() => {
    jest.useFakeTimers();
    jest.resetAllMocks();
});
afterEach(() => jest.useRealTimers());

test("cancelled request cannot start generation SQL or transaction", async () => {
    const controller = new AbortController();
    const execution = createRadioRequestExecution(controller.signal);
    controller.abort();
    mockCreate.mockResolvedValue({ id: "too-late" });
    const record = { ...input, execution };
    await expect(
        recommendationExposureStore.record(record),
    ).rejects.toMatchObject({ code: "RADIO_REQUEST_CANCELLED" });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    execution.dispose();
});

test("deadline while create is held rolls back instead of committing its late generation", async () => {
    const execution = createRadioRequestExecution();
    await jest.advanceTimersByTimeAsync(8_000);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const committed: string[] = [];
    mockCreate.mockImplementation(async () => {
        await held;
        committed.push("unbounded");
        return { id: "unbounded" };
    });
    const txCreate = jest.fn(async () => {
        await held;
        return { id: "inside-tx" };
    });
    mockTransaction.mockImplementation(async (run) => {
        const value = await run({
            recommendationGeneration: { create: txCreate },
        });
        committed.push(value.id);
        return value;
    });
    const result = recommendationExposureStore
        .record({ ...input, execution })
        .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_000);
    release();
    const outcome = await result;
    expect(outcome).toMatchObject({ error: { code: "RADIO_REQUEST_TIMEOUT" } });
    expect(committed).toEqual([]);
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 5_000,
        timeout: 5_000,
    });
    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    execution.dispose();
});

test("successful scoped write retains one nested owner generation and no execution metadata", async () => {
    const execution = createRadioRequestExecution();
    const txCreate = jest.fn(
        async (_args: { data: Record<string, unknown> }) => ({
            id: "generation",
        }),
    );
    mockTransaction.mockImplementation(async (run) =>
        run({ recommendationGeneration: { create: txCreate } }),
    );
    expect(
        await recommendationExposureStore.record({ ...input, execution }),
    ).toBe("generation");
    expect(txCreate).toHaveBeenCalledWith(
        expect.objectContaining({
            data: expect.objectContaining({
                userId: "alice",
                sessionId: "station-a",
                exposures: { create: [] },
            }),
        }),
    );
    expect(txCreate.mock.calls[0][0].data).not.toHaveProperty("execution");
    expect(mockCreate).not.toHaveBeenCalled();
    execution.dispose();
});

test("ordinary surfaces preserve their existing single atomic nested create", async () => {
    mockCreate.mockResolvedValue({ id: "ordinary" });
    expect(await recommendationExposureStore.record(input)).toBe("ordinary");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockTransaction).not.toHaveBeenCalled();
});
