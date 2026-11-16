import type { PersonalizedHomeFeed } from "@/features/home/types";
import {
    readOrderedWavePage,
    type OrderedWaveCheckpoint,
    type OrderedWavePage,
} from "./orderedWaveSequence";

/** Existing API boundary adapted to one owned Wave request. */
export interface OrderedWaveTransport {
    getOwner(): number;
    capabilities?: () => Promise<unknown>;
    request(path: string): Promise<PersonalizedHomeFeed>;
}
/** Accepted page and whether continuity was explicitly reset. */
export interface OrderedWaveReceipt {
    feed: PersonalizedHomeFeed;
    page?: OrderedWavePage;
    reset: boolean;
}
/** Shared by every internal page attempt of one logical refill. */
export interface OrderedWaveResetBudget {
    remaining: number;
}
/** At most one reset after a rejected cursor; malformed successful data never falls back. */
export async function requestOrderedWaveFeed(
    transport: OrderedWaveTransport,
    path: string,
    checkpoint?: OrderedWaveCheckpoint,
    resetBudget: OrderedWaveResetBudget = { remaining: 1 },
): Promise<OrderedWaveReceipt> {
    const owner = transport.getOwner();
    const check = () => {
        if (transport.getOwner() !== owner)
            throw new Error("Wave request owner changed");
    };
    const capability = async (): Promise<boolean | undefined> => {
        if (!transport.capabilities) return false;
        try {
            const raw = await transport.capabilities();
            check();
            const row =
                raw && typeof raw === "object"
                    ? (raw as { orderedWave?: { version?: unknown } })
                    : null;
            return row?.orderedWave?.version === 1;
        } catch {
            check();
            return undefined;
        }
    };
    let enabled = checkpoint !== undefined;
    if (!enabled && transport.capabilities)
        enabled = (await capability()) === true;
    check();
    const makePath = (
        ordered: boolean,
        continuation: OrderedWaveCheckpoint | undefined,
        reset: boolean,
    ) => {
        const [pathname, query = ""] = path.split("?");
        const params = new URLSearchParams(query);
        for (const key of [
            "waveSequenceVersion",
            "waveSequenceCursor",
            "waveSequenceTail",
        ])
            params.delete(key);
        if (ordered) {
            params.set("waveSequenceVersion", "1");
            if (continuation) {
                params.set("waveSequenceCursor", continuation.nextCursor);
                params.set(
                    "waveSequenceTail",
                    JSON.stringify(continuation.tail),
                );
            } else params.set("cursor", "0");
        } else if (reset) params.set("cursor", "0");
        return `${pathname}?${params}`;
    };
    const receive = async (
        ordered: boolean,
        continuation: OrderedWaveCheckpoint | undefined,
        reset: boolean,
    ): Promise<OrderedWaveReceipt> => {
        check();
        const feed = await transport.request(
            makePath(ordered, continuation, reset),
        );
        check();
        const page = readOrderedWavePage(feed);
        if (ordered && !page) {
            if ((await capability()) !== false)
                throw new Error("Ordered Wave response is missing");
            return { feed, reset: true };
        }
        if (!ordered && page)
            throw new Error("Unrequested ordered Wave response");
        if (
            page &&
            continuation &&
            (page.sequenceId !== continuation.sequenceId ||
                page.startPosition !== continuation.nextPosition)
        )
            throw new Error("Ordered Wave continuation changed");
        return { feed, ...(page ? { page } : {}), reset };
    };
    try {
        return await receive(enabled, checkpoint, false);
    } catch (error) {
        check();
        const row = error as {
            status?: unknown;
            data?: { code?: unknown };
        } | null;
        if (
            !enabled ||
            row?.status !== 409 ||
            row.data?.code !== "WAVE_SEQUENCE_RESET" ||
            resetBudget.remaining < 1
        )
            throw error;
        resetBudget.remaining--;
        const supported = await capability();
        if (supported === undefined) throw error;
        return receive(supported, undefined, true);
    }
}
