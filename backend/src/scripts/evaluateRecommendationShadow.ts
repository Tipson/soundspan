import { prisma } from "../utils/db";
import {
    recommendationShadowEvaluation,
    type RecommendationShadowEvaluationReport,
    type RecommendationShadowEvaluationWindow,
} from "../services/recommendations/shadowEvaluation";

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 90;

interface ShadowEvaluationCliDependencies {
    now(): Date;
    evaluate(
        window: RecommendationShadowEvaluationWindow,
    ): Promise<RecommendationShadowEvaluationReport>;
    write(output: string): void;
}

function readArguments(args: readonly string[]): Map<string, string> {
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (!argument.startsWith("--")) {
            throw new TypeError(`Unknown argument: ${argument}`);
        }
        const separator = argument.indexOf("=");
        const name = argument.slice(2, separator < 0 ? undefined : separator);
        const inlineValue =
            separator < 0 ? null : argument.slice(separator + 1);
        const value = inlineValue ?? args[index + 1];
        if (!value || value.startsWith("--")) {
            throw new TypeError(`Missing value for --${name}`);
        }
        if (inlineValue === null) index += 1;
        if (values.has(name)) {
            throw new TypeError(`Duplicate --${name} argument`);
        }
        if (name !== "hours" && name !== "since" && name !== "until") {
            throw new TypeError(`Unknown argument: --${name}`);
        }
        values.set(name, value);
    }
    return values;
}

function parseIsoDate(name: string, raw: string): Date {
    const value = new Date(raw);
    if (!Number.isFinite(value.getTime())) {
        throw new RangeError(`${name} must be an ISO date-time`);
    }
    return value;
}

/** Parses an explicit or bounded rolling recommendation evaluation window. */
export function parseShadowEvaluationWindow(
    args: readonly string[],
    now: Date,
): RecommendationShadowEvaluationWindow {
    if (!Number.isFinite(now.getTime())) {
        throw new RangeError("now must be a valid date-time");
    }
    const values = readArguments(args);
    const hours = values.get("hours");
    const since = values.get("since");
    const until = values.get("until");
    if (hours && (since || until)) {
        throw new TypeError("Use either --hours or --since with --until");
    }
    if (since || until) {
        if (!since || !until) {
            throw new TypeError("Both --since and --until are required");
        }
        const window = {
            since: parseIsoDate("since", since),
            until: parseIsoDate("until", until),
        };
        if (window.since >= window.until) {
            throw new RangeError("since must be earlier than until");
        }
        return window;
    }

    const rawHours = hours ?? String(DEFAULT_WINDOW_HOURS);
    const parsedHours = Number(rawHours);
    if (
        !Number.isInteger(parsedHours) ||
        parsedHours < 1 ||
        parsedHours > MAX_WINDOW_HOURS
    ) {
        throw new RangeError(
            `hours must be an integer between 1 and ${MAX_WINDOW_HOURS}`,
        );
    }
    return {
        since: new Date(now.getTime() - parsedHours * 60 * 60 * 1_000),
        until: now,
    };
}

const defaultDependencies: ShadowEvaluationCliDependencies = {
    now: () => new Date(),
    evaluate: (window) => recommendationShadowEvaluation.evaluate(window),
    write: (output) => console.log(output),
};

/** Runs the read-only shadow evaluator and writes one JSON report. */
export async function runShadowEvaluationCli(
    args: readonly string[],
    dependencies: ShadowEvaluationCliDependencies = defaultDependencies,
): Promise<void> {
    const window = parseShadowEvaluationWindow(args, dependencies.now());
    const report = await dependencies.evaluate(window);
    dependencies.write(JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
    try {
        await runShadowEvaluationCli(process.argv.slice(2));
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    void main().catch((error: unknown) => {
        console.error("Recommendation shadow evaluation failed", error);
        process.exitCode = 1;
    });
}
