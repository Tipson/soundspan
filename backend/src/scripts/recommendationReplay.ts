import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
    MAX_FROZEN_RECOMMENDATION_REPLAY_BYTES,
    runFrozenRecommendationReplay,
} from "../services/recommendations/frozenReplay";

async function readFixture(path: string): Promise<unknown> {
    const file = await open(path, "r");
    try {
        const stat = await file.stat();
        if (
            !stat.isFile() ||
            stat.size > MAX_FROZEN_RECOMMENDATION_REPLAY_BYTES
        ) {
            throw new RangeError(
                "Frozen recommendation replay: fixture byte limit exceeded",
            );
        }
        // Bound the read too: a file may grow after stat, and input is never a stream.
        const bytes = Buffer.alloc(MAX_FROZEN_RECOMMENDATION_REPLAY_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
            const read = await file.read(
                bytes,
                length,
                bytes.length - length,
                null,
            );
            if (read.bytesRead === 0) break;
            length += read.bytesRead;
        }
        if (length > MAX_FROZEN_RECOMMENDATION_REPLAY_BYTES) {
            throw new RangeError(
                "Frozen recommendation replay: fixture byte limit exceeded",
            );
        }
        try {
            return JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                    bytes.subarray(0, length),
                ),
            );
        } catch {
            throw new TypeError(
                "Frozen recommendation replay: invalid UTF-8 JSON fixture",
            );
        }
    } finally {
        await file.close();
    }
}

/** Run the synthetic default fixture or --input <file>, with optional --trace. */
export async function runRecommendationReplayCli(
    args: readonly string[],
    write: (output: string) => void = (output) => {
        process.stdout.write(`${output}\n`);
    },
): Promise<void> {
    let input = resolve(
        __dirname,
        "../../../fixtures/recommendation-replay-v1.json",
    );
    let inputSeen = false;
    let traceEnabled = false;
    for (let index = 0; index < args.length; index++) {
        if (args[index] === "--trace" && !traceEnabled) {
            traceEnabled = true;
        } else if (
            args[index] === "--input" &&
            !inputSeen &&
            args[index + 1] &&
            !args[index + 1].startsWith("--")
        ) {
            input = args[++index];
            inputSeen = true;
        } else {
            throw new TypeError(
                "Usage: recommendationReplay [--input <fixture.json>] [--trace]",
            );
        }
    }
    const report = await runFrozenRecommendationReplay(
        await readFixture(input),
        { traceEnabled },
    );
    write(JSON.stringify(report, null, 2));
}

if (require.main === module) {
    void runRecommendationReplayCli(process.argv.slice(2)).catch(
        (error: unknown) => {
            console.error(
                "Frozen recommendation replay failed:",
                error instanceof Error ? error.message : "unknown error",
            );
            process.exitCode = 1;
        },
    );
}
