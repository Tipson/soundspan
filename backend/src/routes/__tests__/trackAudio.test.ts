import express from "express";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { config } from "../../config";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import router from "../trackAudio";

jest.mock("../../middleware/auth", () => ({
    requireAuth: authenticate,
    requireAuthOrToken: authenticate,
    requireAdmin: (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
    ) => (req.header("x-user") === "admin" ? next() : res.sendStatus(403)),
}));

function authenticate(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
) {
    const user = req.header("x-user");
    if (!user) return res.sendStatus(401);
    req.user = {
        id: user,
        role: user === "admin" ? "admin" : "user",
    } as express.Request["user"];
    next();
}

jest.mock("../../config", () => ({ config: { music: { musicPath: "" } } }));
jest.mock("../../middleware/rateLimiter", () => ({
    apiLimiter: allow,
    adminSurfaceLimiter: allow,
    streamingLimiter: allow,
}));
function allow(
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
) {
    next();
}
jest.mock("../../services/musicSources/connections", () => ({
    loadMusicSourceAdapters: jest.fn(),
}));
jest.mock("../../services/youtubeDownload", () => ({
    youtubeDownloadService: {},
}));
jest.mock("music-metadata", () => ({ parseFile: jest.fn() }), {
    virtual: true,
});
jest.mock("../../utils/db", () => ({
    prisma: {
        track: { findUnique: jest.fn() },
        trackAudioVersion: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            upsert: jest.fn(),
            update: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

const app = express();
app.use(express.json());
app.use("/api/track-audio", router);
const base = "/api/track-audio/library/track-1";
const file = Buffer.from("synthetic-audio-data");
let root: string;
let record: { draftId: string | null; publishedId: string | null } | null;
const stream = (id: string) => `/api/track-audio/versions/${id}/stream`;
const draft = () =>
    request(app)
        .put(`${base}/draft`)
        .set("Content-Type", "audio/mpeg")
        .send(file);

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "soundspan-track-audio-"));
    config.music.musicPath = root;
    record = null;
    jest.mocked(prisma.track.findUnique).mockResolvedValue({
        id: "track-1",
    } as never);
    jest.mocked(parseFile).mockResolvedValue({
        format: { container: "MPEG", codec: "MPEG 1 Layer 3", duration: 13 },
    } as never);
    jest.mocked(prisma.$transaction).mockImplementation((action) =>
        (action as (transaction: typeof prisma) => Promise<unknown>)(prisma),
    );
    jest.mocked(prisma.trackAudioVersion.findUnique).mockImplementation(
        () => Promise.resolve(record) as never,
    );
    jest.mocked(prisma.trackAudioVersion.findFirst).mockImplementation(
        ({ where } = {}) => {
            if (
                record &&
                (where?.OR ?? [where]).some(
                    (clause) =>
                        (typeof clause?.publishedId === "string" &&
                            clause.publishedId === record?.publishedId) ||
                        (typeof clause?.draftId === "string" &&
                            clause.draftId === record?.draftId),
                )
            ) {
                return Promise.resolve({
                    ...record,
                    source: "library",
                    trackId: "track-1",
                }) as never;
            }
            return Promise.resolve(null) as never;
        },
    );
    jest.mocked(prisma.trackAudioVersion.upsert).mockImplementation(
        ({ create, update }) => {
            record = {
                publishedId: record?.publishedId ?? null,
                draftId: (record ? update.draftId : create.draftId) as string,
            };
            return Promise.resolve(record) as never;
        },
    );
    jest.mocked(prisma.trackAudioVersion.update).mockImplementation(
        ({ data }) => {
            record = {
                draftId:
                    data.draftId === null ? null : (record?.draftId ?? null),
                publishedId: data.publishedId as string | null,
            };
            return Promise.resolve(record) as never;
        },
    );
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("an admin stages, previews and publishes an immutable version for all users", async () => {
    await draft().expect(401);
    await draft().set("x-user", "listener").expect(403);
    await request(app)
        .get(base)
        .set("x-user", "listener")
        .expect(200, { publishedId: null });
    const staged = await draft().set("x-user", "admin").expect(201);
    const id: string = staged.body.draftId;
    await request(app)
        .get(base)
        .set("x-user", "listener")
        .expect(200, { publishedId: null });
    await request(app).get(stream(id)).set("x-user", "listener").expect(404);
    await request(app)
        .get(stream(id))
        .set("x-user", "admin")
        .set("Range", "bytes=0-3")
        .expect(206)
        .expect("Content-Range", `bytes 0-3/${file.length}`);
    await request(app)
        .post(`${base}/publish`)
        .set("x-user", "listener")
        .send({ versionId: id })
        .expect(403);
    await request(app)
        .post(`${base}/publish`)
        .set("x-user", "admin")
        .send({ versionId: id })
        .expect(200, { draftId: null, publishedId: id });
    await request(app)
        .get(base)
        .set("x-user", "another-listener")
        .expect(200, { publishedId: id });
    await request(app)
        .head(stream(id))
        .set("x-user", "listener")
        .expect(200)
        .expect("Cache-Control", "private, no-store")
        .expect("ETag", `"${id}"`);
    await request(app)
        .delete(`${base}/published/${id}`)
        .set("x-user", "admin")
        .expect(200);
    await request(app).get(stream(id)).set("x-user", "listener").expect(404);
    await request(app)
        .get(base)
        .set("x-user", "listener")
        .expect(200, { publishedId: null });
});

test("replacing a draft rejects stale approval and never replaces the published bytes", async () => {
    const first = (await draft().set("x-user", "admin").expect(201)).body
        .draftId;
    await request(app)
        .post(`${base}/publish`)
        .set("x-user", "admin")
        .send({ versionId: first })
        .expect(200);
    const old = (await draft().set("x-user", "admin").expect(201)).body.draftId;
    const current = (await draft().set("x-user", "admin").expect(201)).body
        .draftId;
    await request(app)
        .post(`${base}/publish`)
        .set("x-user", "admin")
        .send({ versionId: old })
        .expect(409);
    await request(app)
        .get(base)
        .set("x-user", "listener")
        .expect(200, { publishedId: first });
    await request(app).get(stream(old)).set("x-user", "admin").expect(404);
    expect((await readdir(join(root, ".track-audio"))).sort()).toEqual(
        [`${first}.mp3`, `${current}.mp3`].sort(),
    );
});

test("invalid audio leaves the published version intact and unknown tracks reject uploads", async () => {
    jest.mocked(prisma.track.findUnique).mockResolvedValueOnce(null);
    await draft().set("x-user", "admin").expect(404);
    jest.mocked(parseFile).mockRejectedValueOnce(new Error("invalid audio"));
    await draft().set("x-user", "admin").expect(422);
    expect(await readdir(join(root, ".track-audio"))).toEqual([]);
});

test("a missing draft file cannot replace a playable publication", async () => {
    const first = (await draft().set("x-user", "admin").expect(201)).body
        .draftId;
    await request(app)
        .post(`${base}/publish`)
        .set("x-user", "admin")
        .send({ versionId: first })
        .expect(200);
    const missing = (await draft().set("x-user", "admin").expect(201)).body
        .draftId;
    await rm(join(root, ".track-audio", `${missing}.mp3`));
    await request(app)
        .post(`${base}/publish`)
        .set("x-user", "admin")
        .send({ versionId: missing })
        .expect(409, { error: "version_file_missing" });
    await request(app)
        .get(base)
        .set("x-user", "listener")
        .expect(200, { publishedId: first });
    await request(app)
        .head(stream(first))
        .set("x-user", "listener")
        .expect(200);
});

test("a missing published file leaves standard playback available and stays visible to the admin", async () => {
    const id = (await draft().set("x-user", "admin").expect(201)).body.draftId;
    await request(app)
        .post(`${base}/publish`)
        .set("x-user", "admin")
        .send({ versionId: id })
        .expect(200);
    await rm(join(root, ".track-audio", `${id}.mp3`));
    await request(app)
        .get(base)
        .set("x-user", "listener")
        .expect(200, { publishedId: null });
    await request(app)
        .get(`${base}/manage`)
        .set("x-user", "admin")
        .expect(200, { draftId: null, publishedId: id });
});
