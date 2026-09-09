const MAX_CACHED_EMBEDDINGS = 2_048;
const MAX_CACHED_EMBEDDING_TEXT_LENGTH = 16_384;
const parsedEmbeddings = new Map<string, number[]>();

/**
 * Parse a pgvector embedding from its text representation "[0.1,0.2,...]"
 * into a number array.
 */
export function parseEmbedding(text: string): number[] {
    if (typeof text !== "string" || text.trim() === "") {
        throw new Error("Invalid embedding: expected non-empty string");
    }
    const cached = parsedEmbeddings.get(text);
    if (cached) {
        parsedEmbeddings.delete(text);
        parsedEmbeddings.set(text, cached);
        return [...cached];
    }

    // pgvector's decimal array syntax can be parsed without allocating a
    // trimmed string for each coordinate. Keep the legacy fallback for other
    // numeric spellings accepted by existing callers.
    try {
        const parsed: unknown = JSON.parse(text);
        if (
            Array.isArray(parsed) &&
            parsed.length > 0 &&
            parsed.every(
                (value: unknown) =>
                    typeof value === "number" && Number.isFinite(value),
            )
        ) {
            // Exact content is immutable even when a recording is re-analyzed.
            // Cache only bounded standard vectors; callers always own a copy.
            if (
                parsed.length === 512 &&
                text.length <= MAX_CACHED_EMBEDDING_TEXT_LENGTH
            ) {
                if (parsedEmbeddings.size >= MAX_CACHED_EMBEDDINGS) {
                    parsedEmbeddings.delete(
                        parsedEmbeddings.keys().next().value!,
                    );
                }
                parsedEmbeddings.set(text, [...parsed]);
            }
            return parsed;
        }
    } catch {
        // Non-JSON numeric input is validated by the compatibility path below.
    }

    const values = text
        .trim()
        .split("[")
        .join("")
        .split("]")
        .join("")
        .split(",")
        .map((value: string) => value.trim());

    if (values.length === 0 || values.some((value: string) => value === "")) {
        throw new Error("Invalid embedding: contains non-numeric values");
    }

    const numbers = values.map((value: string) => Number(value));

    if (numbers.some((value: number) => !Number.isFinite(value))) {
        throw new Error("Invalid embedding: contains non-numeric values");
    }

    return numbers;
}

/**
 * Linearly interpolate between two embedding vectors.
 */
export function lerpEmbedding(a: number[], b: number[], t: number): number[] {
    return a.map((v, i) => v * (1 - t) + b[i] * t);
}

/**
 * Weighted average of multiple embeddings.
 */
export function blendEmbeddings(
    embeddings: number[][],
    weights: number[],
): number[] {
    const dim = embeddings[0].length;
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const result = new Array<number>(dim).fill(0);
    for (let i = 0; i < embeddings.length; i++) {
        const w = weights[i] / totalWeight;
        for (let d = 0; d < dim; d++) {
            result[d] += embeddings[i][d] * w;
        }
    }
    return result;
}
