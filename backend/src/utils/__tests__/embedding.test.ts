import { blendEmbeddings, lerpEmbedding, parseEmbedding } from "../embedding";

describe("lerpEmbedding", () => {
    it("returns the endpoints at t=0 and t=1", () => {
        const start = [1, 2, 3];
        const end = [4, 6, 8];

        expect(lerpEmbedding(start, end, 0)).toEqual(start);
        expect(lerpEmbedding(start, end, 1)).toEqual(end);
    });

    it("interpolates the midpoint", () => {
        expect(lerpEmbedding([0, 2, 4], [2, 4, 8], 0.5)).toEqual([1, 3, 6]);
    });

    it("preserves the first embedding dimension", () => {
        expect(lerpEmbedding([0, 2], [2, 4, 8], 0.5)).toHaveLength(2);
    });
});

describe("blendEmbeddings", () => {
    it("computes a weighted blend", () => {
        expect(
            blendEmbeddings(
                [
                    [1, 3],
                    [5, 7],
                ],
                [1, 3],
            ),
        ).toEqual([4, 6]);
    });

    it("preserves the first embedding dimension", () => {
        expect(
            blendEmbeddings(
                [
                    [1, 2, 3],
                    [5, 6, 7],
                ],
                [1, 1],
            ),
        ).toHaveLength(3);
    });

    it("preserves NaN results when the total weight is zero", () => {
        expect(blendEmbeddings([[1, 2]], [0])).toEqual([NaN, NaN]);
    });
});

describe("parseEmbedding", () => {
    it("keeps repeated-vector map keys short while checking the full input", () => {
        jest.isolateModules(() => {
            const parse = (
                require("../embedding") as typeof import("../embedding")
            ).parseEmbedding;
            const values = Array.from({ length: 512 }, (_, i) => i / 999);
            const text = JSON.stringify(values);
            parse(text);
            const lookup = jest.spyOn(Map.prototype, "get");
            let actual: number[];
            let keyLengths: number[];
            try {
                actual = parse(Buffer.from(text).toString("utf8"));
                keyLengths = lookup.mock.calls.map(([key]) =>
                    typeof key === "string" ? key.length : 0,
                );
            } finally {
                lookup.mockRestore();
            }
            expect(actual!).toEqual(values);
            expect(keyLengths!.length).toBeGreaterThan(0);
            expect(Math.max(...keyLengths!)).toBeLessThanOrEqual(128);
        });
    });

    it("does not confuse equal-length vectors or invalid input sharing a prefix", () => {
        jest.isolateModules(() => {
            const parse = (
                require("../embedding") as typeof import("../embedding")
            ).parseEmbedding;
            const prefix = `[${Array.from({ length: 511 }, () => 0).join(",")},`;
            const first = `${prefix}1]`,
                second = `${prefix}2]`;
            parse(first)[511] = 99;
            expect(parse(second)[511]).toBe(2);
            expect(parse(first)[511]).toBe(1);
            expect(() => parse(`${prefix}x]`)).toThrow(
                "Invalid embedding: contains non-numeric values",
            );
            expect(parse(first)[511]).toBe(1);
        });
    });

    it("reuses identical standard vectors without sharing mutable result arrays", () => {
        jest.isolateModules(() => {
            const parse = (
                require("../embedding") as typeof import("../embedding")
            ).parseEmbedding;
            const text = JSON.stringify(
                Array.from({ length: 512 }, (_, i) => i / 999),
            );
            const jsonParse = jest.spyOn(JSON, "parse");
            try {
                const first = parse(text);
                first[0] = 99;
                const second = parse(text);
                expect(second[0]).toBe(0);
                expect(second).not.toBe(first);
                expect(jsonParse).toHaveBeenCalledTimes(1);
                const changed = parse(text.replace("[0,", "[1,"));
                expect(changed[0]).toBe(1);
                expect(jsonParse).toHaveBeenCalledTimes(2);
            } finally {
                jsonParse.mockRestore();
            }
        });
    });

    it("evicts old vector parses after the bounded working set fills", () => {
        jest.isolateModules(() => {
            const parse = (
                require("../embedding") as typeof import("../embedding")
            ).parseEmbedding;
            const vector = Array.from({ length: 512 }, () => 0);
            const first = JSON.stringify(vector);
            for (let i = 0; i <= 2048; i += 1) {
                vector[0] = i;
                parse(JSON.stringify(vector));
            }
            const jsonParse = jest.spyOn(JSON, "parse");
            try {
                parse(JSON.stringify(vector));
                expect(jsonParse).not.toHaveBeenCalled();
                parse(first);
                expect(jsonParse).toHaveBeenCalledTimes(1);
            } finally {
                jsonParse.mockRestore();
            }
        });
    });

    it("avoids per-coordinate string transformations for pgvector data", () => {
        const values = Array.from({ length: 512 }, (_, index) => index / 1024);
        const text = `[${values.join(",")}]`;
        const trim = jest.spyOn(String.prototype, "trim");
        let result: number[];
        let trimCalls: number;
        try {
            result = parseEmbedding(text);
            trimCalls = trim.mock.calls.length;
        } finally {
            trim.mockRestore();
        }
        expect(result!).toEqual(values);
        expect(trimCalls!).toBeLessThanOrEqual(2);
    });

    it("retains legacy numeric syntax and rejects non-numeric JSON values", () => {
        expect(parseEmbedding("[+1,.5,0x10]")).toEqual([1, 0.5, 16]);
        expect(parseEmbedding("1,2,3")).toEqual([1, 2, 3]);
        expect(parseEmbedding("[[1],2]")).toEqual([1, 2]);
        expect(Object.is(parseEmbedding("[-0]")[0], -0)).toBe(true);
        for (const value of ["[null]", "[true]", '["1"]', "[]", "[1e999]"]) {
            expect(() => parseEmbedding(value)).toThrow(
                "Invalid embedding: contains non-numeric values",
            );
        }
    });

    it("parses valid embedding strings across numeric formats", () => {
        expect(parseEmbedding("[0.1,0.2,0.3]")).toEqual([0.1, 0.2, 0.3]);
        expect(parseEmbedding("[-1,2.5,3e-4]")).toEqual([-1, 2.5, 0.0003]);
        expect(parseEmbedding("[1,2,3]")).toEqual([1, 2, 3]);
    });

    it("throws for empty, null, and undefined input", () => {
        expect(() => parseEmbedding("")).toThrow(
            "Invalid embedding: expected non-empty string",
        );
        expect(() => parseEmbedding("   ")).toThrow(
            "Invalid embedding: expected non-empty string",
        );
        expect(() => parseEmbedding(null as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string",
        );
        expect(() => parseEmbedding(undefined as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string",
        );
    });

    it("throws for non-string input", () => {
        expect(() => parseEmbedding(123 as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string",
        );
        expect(() => parseEmbedding([1, 2, 3] as unknown as string)).toThrow(
            "Invalid embedding: expected non-empty string",
        );
        expect(() =>
            parseEmbedding({ value: "[1,2,3]" } as unknown as string),
        ).toThrow("Invalid embedding: expected non-empty string");
    });

    it("throws for malformed embeddings with non-numeric values", () => {
        expect(() => parseEmbedding("[1,two,3]")).toThrow(
            "Invalid embedding: contains non-numeric values",
        );
        expect(() => parseEmbedding("[1,,3]")).toThrow(
            "Invalid embedding: contains non-numeric values",
        );
        expect(() => parseEmbedding("[1,NaN,3]")).toThrow(
            "Invalid embedding: contains non-numeric values",
        );
    });

    it("trims surrounding and per-value whitespace", () => {
        expect(parseEmbedding(" [ 0.1,  2.5 , -3 ] ")).toEqual([0.1, 2.5, -3]);
    });

    it("parses single-value embeddings", () => {
        expect(parseEmbedding("[42]")).toEqual([42]);
    });

    it("parses large embeddings", () => {
        const values = Array.from({ length: 512 }, (_, index) => index / 10);
        const text = `[${values.join(",")}]`;

        expect(parseEmbedding(text)).toEqual(values);
    });
});
