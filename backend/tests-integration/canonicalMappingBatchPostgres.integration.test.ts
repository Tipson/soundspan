import { Client } from "pg";
import { prisma } from "../src/utils/db";
import {
    findMappedCanonicalCandidates,
    canonicalIdentityResolver,
    providerTrackIdentityToCandidate,
} from "../src/services/recommendations/canonicalIdentity";
import {
    createScaleDatabase,
    applyScaleMigrations,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const withPostgres = adminUrl && databaseName ? describe : describe.skip;
const track = (id: string) =>
    providerTrackIdentityToCandidate({
        source: "youtube",
        providerTrackId: id,
        title: id,
        artist: "Artist",
    });

withPostgres("canonical batch mapping with real PostgreSQL", () => {
    let admin: Client;
    beforeAll(async () => {
        admin = await createScaleDatabase(adminUrl!, databaseName!);
        await applyScaleMigrations(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
        await prisma.$disconnect();
        if (admin) await dropScaleDatabase(admin, databaseName!);
    });
    it("matches individual resolution, ignores stale rows and follows current aliases", async () => {
        for (const id of ["one", "two", "stale", "alias", "survivor"]) {
            await prisma.canonicalRecording.create({
                data: {
                    id,
                    canonicalKey: `key:${id}`,
                    title: id,
                    artist: "Artist",
                    duration: 180,
                },
            });
        }
        await prisma.canonicalRecording.update({
            where: { id: "alias" },
            data: {
                mergedIntoId: "survivor",
                identitySource: "identity-merged",
            },
        });
        for (const id of ["one", "two", "stale", "alias"]) {
            await prisma.trackYtMusic.create({
                data: {
                    id: `yt-${id}`,
                    videoId: id,
                    title: id,
                    artist: "Artist",
                    album: "Album",
                    duration: 180,
                },
            });
            await prisma.trackMapping.create({
                data: {
                    trackYtMusicId: `yt-${id}`,
                    canonicalRecordingId: id,
                    stale: id === "stale",
                    confidence: 1,
                    source: "test",
                },
            });
        }
        const input = ["two", "missing", "one", "stale", "alias", "one"].map(
            track,
        );
        const batch = await findMappedCanonicalCandidates(input);
        expect(batch).toEqual([
            { id: "two", canonicalKey: "key:two" },
            null,
            { id: "one", canonicalKey: "key:one" },
            null,
            { id: "survivor", canonicalKey: "key:survivor" },
            { id: "one", canonicalKey: "key:one" },
        ]);
        for (const index of [0, 2, 4, 5])
            expect(batch[index]).toEqual(
                await canonicalIdentityResolver.resolve(input[index]),
            );
        await prisma.trackMapping.updateMany({
            where: { trackYtMusicId: "yt-one" },
            data: { stale: true },
        });
        expect(await findMappedCanonicalCandidates([track("one")])).toEqual([
            null,
        ]);
        await prisma.trackTidal.create({
            data: {
                id: "tidal-two",
                tidalId: 2,
                title: "two",
                artist: "Artist",
                album: "Album",
                duration: 180,
            },
        });
        await prisma.trackMapping.create({
            data: {
                trackYtMusicId: "yt-two",
                trackTidalId: "tidal-two",
                canonicalRecordingId: "one",
                confidence: 1,
                source: "test",
            },
        });
        expect(await findMappedCanonicalCandidates([track("two")])).toEqual([
            null,
        ]);
    });
});
