import fs from "fs";
import path from "path";

// Prisma 7 removed the Rust query engine: the client runs on a bundled WASM
// query compiler plus the pg driver adapter, so binaryTargets (which pinned
// engine binaries to the container's OpenSSL) must stay gone, and the
// connection URL lives in prisma.config.ts instead of the schema datasource.
describe("prisma engine-less client contract", () => {
    const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
    const schema = fs.readFileSync(schemaPath, "utf8");

    it("keeps the prisma-client-js generator without engine binary pins", () => {
        expect(schema).toContain("generator client {");
        expect(schema).toContain('provider = "prisma-client-js"');
        expect(schema).not.toContain("binaryTargets");
    });

    it("keeps the datasource URL out of the schema (Prisma 7 config file owns it)", () => {
        expect(schema).not.toContain("env(\"DATABASE_URL\")");

        const configPath = path.resolve(__dirname, "../../prisma.config.ts");
        const config = fs.readFileSync(configPath, "utf8");
        expect(config).toContain("defineConfig");
        expect(config).toContain('env("DATABASE_URL")');
    });
});

describe("shuffle migration rollout contract", () => {
    const migrationPath = path.resolve(
        __dirname,
        "../../prisma/migrations/20260711012100_add_track_random_sample_column/migration.sql",
    );
    const migration = fs.readFileSync(migrationPath, "utf8");

    it("backfills the volatile random default without rewriting Track on ADD COLUMN", () => {
        expect(migration).toContain('ADD COLUMN "random" DOUBLE PRECISION;');
        expect(migration).toContain('ALTER COLUMN "random" SET DEFAULT random()');
        expect(migration).toContain('UPDATE "Track" SET "random" = random()');
        expect(migration).not.toMatch(/ADD COLUMN[^;]+NOT NULL[^;]+DEFAULT random\(\)/s);
    });

    it("builds the sampling index without blocking Track writes", () => {
        expect(migration).toContain(
            'CREATE INDEX CONCURRENTLY "Track_random_idx" ON "Track"("random")',
        );
    });
});
