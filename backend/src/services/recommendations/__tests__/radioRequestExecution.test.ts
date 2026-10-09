import {
    createRadioRequestExecution,
    RadioRequestError,
} from "../radioRequestExecution";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("one total monotonic budget is retained across stages and wall clock changes", async () => {
    const execution = createRadioRequestExecution();
    expect(execution.remainingMs()).toBe(13_000);
    await jest.advanceTimersByTimeAsync(8_000);
    jest.setSystemTime(new Date("2000-01-01T00:00:00Z"));
    expect(execution.remainingMs()).toBe(5_000);
    const work = execution.run(() => new Promise(() => {}));
    const caught = work.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await caught).toMatchObject({ code: "RADIO_REQUEST_TIMEOUT" });
    expect(() => execution.check()).toThrow(RadioRequestError);
    execution.dispose();
    expect(jest.getTimerCount()).toBe(0);
});

test("already aborted input does no work and never exposes caller's abort reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private-token-in-url"));
    const execution = createRadioRequestExecution(controller.signal);
    const work = jest.fn(async () => "value");
    await expect(execution.run(work)).rejects.toMatchObject({
        code: "RADIO_REQUEST_CANCELLED",
        message: "Radio request cancelled",
    });
    expect(work).not.toHaveBeenCalled();
    execution.dispose();
    expect(jest.getTimerCount()).toBe(0);
});

test("late provider rejection is observed without creating a second unhandled error", async () => {
    const controller = new AbortController();
    const execution = createRadioRequestExecution(controller.signal);
    let reject!: (value: Error) => void;
    const work = execution.run(
        () =>
            new Promise((_, fail) => {
                reject = fail;
            }),
    );
    const caught = work.catch((error: unknown) => error);
    await Promise.resolve();
    controller.abort();
    expect(await caught).toMatchObject({ code: "RADIO_REQUEST_CANCELLED" });
    reject(new Error("late provider error"));
    await Promise.resolve();
    execution.dispose();
    expect(jest.getTimerCount()).toBe(0);
});

test("successful parallel phases use one timer and dispose the external listener", async () => {
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, "removeEventListener");
    const execution = createRadioRequestExecution(controller.signal);
    expect(
        await Promise.all(
            Array.from({ length: 100 }, (_, i) => execution.run(async () => i)),
        ),
    ).toHaveLength(100);
    expect(jest.getTimerCount()).toBe(1);
    execution.dispose();
    execution.dispose();
    expect(jest.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
});

test("successful calls preserve original ordinary source errors", async () => {
    const execution = createRadioRequestExecution();
    const error = new Error("source unavailable");
    await expect(
        execution.run(async () => {
            throw error;
        }),
    ).rejects.toBe(error);
    execution.dispose();
});

test.each([12_999, 13_000, 13_001])(
    "source rejection at monotonic %s uses the deadline even before its timer runs",
    async (elapsed) => {
        const clock = jest.spyOn(performance, "now").mockReturnValue(0);
        const execution = createRadioRequestExecution();
        const providerError = new Error("source unavailable");
        try {
            const work = execution.run(async () => {
                clock.mockReturnValue(elapsed);
                throw providerError;
            });
            if (elapsed < 13_000)
                await expect(work).rejects.toBe(providerError);
            else
                await expect(work).rejects.toMatchObject({
                    code: "RADIO_REQUEST_TIMEOUT",
                    message: "Radio request timed out",
                });
        } finally {
            execution.dispose();
            clock.mockRestore();
        }
        expect(jest.getTimerCount()).toBe(0);
    },
);
