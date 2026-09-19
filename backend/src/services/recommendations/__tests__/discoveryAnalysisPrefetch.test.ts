import { DiscoveryAnalysisPrefetch } from "../discoveryAnalysisPrefetch";
import type { RecommendationCandidate } from "../types";

const candidates = Array.from(
    { length: 30 },
    (_, index) => ({ id: `track-${index}` }) as RecommendationCandidate,
);
function harness() {
    const dependencies = {
        loadUsers: jest.fn().mockResolvedValue(["a", "b", "c", "d", "e"]),
        canContinue: jest.fn().mockResolvedValue(true),
        visit: jest.fn().mockResolvedValue(true),
        loadCandidates: jest
            .fn()
            .mockResolvedValue({ candidates, nextCursor: 3 }),
        admit: jest.fn().mockResolvedValue(undefined),
        advance: jest.fn().mockResolvedValue(undefined),
        failed: jest.fn(),
    };
    return {
        dependencies,
        prefetch: new DiscoveryAnalysisPrefetch(dependencies),
    };
}

it("prepares at most four accounts and twelve discovery candidates each in serial order", async () => {
    const { dependencies, prefetch } = harness();
    expect(await prefetch.run(new AbortController().signal)).toBe(4);
    expect(
        dependencies.admit.mock.calls.map(([userId, tracks]) => [
            userId,
            tracks.length,
        ]),
    ).toEqual([
        ["a", 12],
        ["b", 12],
        ["c", 12],
        ["d", 12],
    ]);
    expect(dependencies.advance).toHaveBeenLastCalledWith("d", 3);
});

it("does not admit a late result or advance a cursor after shutdown", async () => {
    const { dependencies, prefetch } = harness();
    const controller = new AbortController();
    dependencies.loadCandidates.mockImplementation(async () => {
        controller.abort();
        return { candidates, nextCursor: 3 };
    });
    expect(await prefetch.run(controller.signal)).toBe(0);
    expect(dependencies.admit).not.toHaveBeenCalled();
    expect(dependencies.advance).not.toHaveBeenCalled();
});

it("stops at budget/backlog pressure and before any work when already cancelled", async () => {
    const { dependencies, prefetch } = harness();
    dependencies.canContinue.mockResolvedValue(false);
    expect(await prefetch.run(new AbortController().signal)).toBe(0);
    expect(dependencies.loadCandidates).not.toHaveBeenCalled();
    dependencies.loadUsers.mockClear();
    const controller = new AbortController();
    controller.abort();
    expect(await prefetch.run(controller.signal)).toBe(0);
    expect(dependencies.loadUsers).not.toHaveBeenCalled();
});

it("isolates one failed account and never overlaps candidate loads", async () => {
    const { dependencies, prefetch } = harness();
    dependencies.loadCandidates.mockRejectedValueOnce(
        new Error("upstream unavailable"),
    );
    expect(await prefetch.run(new AbortController().signal)).toBe(3);
    expect(dependencies.failed).toHaveBeenCalledTimes(1);
    expect(dependencies.admit.mock.calls[0][0]).toBe("b");
});

it("rotates past every attempted account even when the whole batch fails", async () => {
    const { dependencies, prefetch } = harness();
    dependencies.loadCandidates.mockRejectedValue(new Error("provider down"));
    expect(await prefetch.run(new AbortController().signal)).toBe(0);
    expect(dependencies.visit.mock.calls).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(dependencies.advance).not.toHaveBeenCalled();
});

it("does not start provider work after losing ownership while recording a visit", async () => {
    const { dependencies, prefetch } = harness();
    dependencies.visit.mockResolvedValue(false);
    expect(await prefetch.run(new AbortController().signal)).toBe(0);
    expect(dependencies.loadCandidates).not.toHaveBeenCalled();
});

it("does not start provider work when cancellation arrives during a visit", async () => {
    const { dependencies, prefetch } = harness();
    const controller = new AbortController();
    dependencies.visit.mockImplementation(async () => {
        controller.abort();
        return true;
    });
    expect(await prefetch.run(controller.signal)).toBe(0);
    expect(dependencies.loadCandidates).not.toHaveBeenCalled();
});
