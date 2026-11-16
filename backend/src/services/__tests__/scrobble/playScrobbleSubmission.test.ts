import axios from "axios";
import { execFileSync } from "node:child_process";
import {
    mkdtempSync,
    readFileSync,
    unlinkSync,
    rmdirSync,
    existsSync,
} from "node:fs";
import https, { type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
    createScrobbleDispatchSubmitter,
    ScrobbleBeforeHandoffError,
} from "../../playScrobbleSubmission";

describe("durable provider delivery against a local TLS peer", () => {
    let directory: string;
    let certificate: Buffer;
    let server: Server;
    let peerUrl: string;
    let received: number;
    let mode:
        | "success"
        | "lost_ack"
        | "invalid_auth"
        | "html"
        | "empty"
        | "ignored";
    let service: "lastfm" | "listenbrainz";

    beforeAll(async () => {
        directory = mkdtempSync(join(tmpdir(), "soundspan-play-delivery-tls-"));
        execFileSync(
            "openssl",
            [
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost,IP:127.0.0.1",
                "-keyout",
                join(directory, "peer.key"),
                "-out",
                join(directory, "peer.crt"),
            ],
            { stdio: "ignore" },
        );
        certificate = readFileSync(join(directory, "peer.crt"));
        server = https.createServer(
            {
                key: readFileSync(join(directory, "peer.key")),
                cert: certificate,
            },
            (req, res) => {
                req.resume();
                req.once("end", () => {
                    received += 1;
                    if (mode === "lost_ack") {
                        req.socket.destroy();
                        return;
                    }
                    res.setHeader("Content-Type", "application/json");
                    if (mode === "invalid_auth") {
                        res.statusCode = 401;
                        res.end(
                            JSON.stringify({
                                error: "fixture invalid authorization",
                            }),
                        );
                        return;
                    }
                    if (mode === "html") {
                        res.end("<html>proxy page</html>");
                        return;
                    }
                    if (mode === "empty") {
                        res.end();
                        return;
                    }
                    const accepted = mode === "ignored" ? "0" : "1";
                    const ignored = mode === "ignored" ? "1" : "0";
                    res.end(
                        JSON.stringify(
                            service === "listenbrainz"
                                ? { status: "ok" }
                                : {
                                      scrobbles: {
                                          "@attr": { accepted, ignored },
                                          scrobble: {
                                              ignoredMessage: { code: ignored },
                                          },
                                      },
                                  },
                        ),
                    );
                });
            },
        );
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        peerUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    beforeEach(() => {
        received = 0;
        mode = "success";
        service = "listenbrainz";
    });
    afterAll(async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        if (directory) {
            for (const name of ["peer.key", "peer.crt"])
                if (existsSync(join(directory, name)))
                    unlinkSync(join(directory, name));
            rmdirSync(directory);
        }
    });

    function submitter() {
        return createScrobbleDispatchSubmitter({
            post: (url, data, options) =>
                axios.post(peerUrl, data, {
                    ...options,
                    httpsAgent: new https.Agent({
                        ca: certificate,
                        keepAlive: false,
                    }),
                    proxy: false,
                }),
        });
    }
    const input = () => ({
        service,
        credential: "synthetic-fixture-credential",
        listenedAtSeconds: 1_700_000_000,
        track: {
            artist: "Fixture artist",
            title: "Fixture title",
            album: "Fixture album",
            durationSeconds: 200,
        },
        lastFm: { apiKey: "synthetic-key", sharedSecret: "synthetic-secret" },
    });

    test.each(["lastfm", "listenbrainz"] as const)(
        "%s valid ACK follows one actual received request",
        async (provider) => {
            service = provider;
            expect(await submitter()(input())).toBe("submitted");
            expect(received).toBe(1);
        },
    );

    test.each(["lastfm", "listenbrainz"] as const)(
        "%s accepted body then lost ACK stays ambiguous and is not resent",
        async (provider) => {
            service = provider;
            mode = "lost_ack";
            expect(await submitter()(input())).toBe("ambiguous");
            expect(received).toBe(1);
        },
    );

    test.each(["html", "empty"] as const)(
        "HTTP200 %s does not claim external success",
        async (response) => {
            mode = response;
            expect(await submitter()(input())).toBe("ambiguous");
            expect(received).toBe(1);
        },
    );

    test("invalid authorization and a proven ignored scrobble are distinct", async () => {
        mode = "invalid_auth";
        expect(await submitter()(input())).toBe("invalid_auth");
        service = "lastfm";
        mode = "ignored";
        expect(await submitter()(input())).toBe("rejected");
        expect(received).toBe(2);
    });

    test("missing server configuration is a proved pre-handoff failure with zero requests", async () => {
        service = "lastfm";
        await expect(
            submitter()({ ...input(), lastFm: undefined }),
        ).rejects.toBeInstanceOf(ScrobbleBeforeHandoffError);
        expect(received).toBe(0);
    });
});
