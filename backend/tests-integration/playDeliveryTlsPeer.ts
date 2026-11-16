import axios from "axios";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createScrobbleDispatchSubmitter } from "../src/services/playScrobbleSubmission";

/** Actual isolated TLS peer counts received submissions; it never resolves a public provider. */
export async function createPlayDeliveryTlsPeer(
    service: "lastfm" | "listenbrainz",
    lostAck = false,
) {
    const directory = mkdtempSync(join(tmpdir(), "soundspan-dev08-peer-"));
    let received = 0;
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
    const cert = readFileSync(join(directory, "peer.crt"));
    const server = https.createServer(
        { key: readFileSync(join(directory, "peer.key")), cert },
        (req, res) => {
            req.resume();
            req.once("end", () => {
                received++;
                if (lostAck) {
                    req.socket.destroy();
                    return;
                }
                res.setHeader("Content-Type", "application/json");
                res.end(
                    JSON.stringify(
                        service === "listenbrainz"
                            ? { status: "ok" }
                            : {
                                  scrobbles: {
                                      "@attr": { accepted: "1", ignored: "0" },
                                      scrobble: {
                                          ignoredMessage: { code: "0" },
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
    const agent = new https.Agent({ ca: cert, keepAlive: false });
    const peerUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        received: () => received,
        submit: createScrobbleDispatchSubmitter({
            post: (_url, data, options) =>
                axios.post(peerUrl, data, {
                    ...options,
                    httpsAgent: agent,
                    proxy: false,
                }),
        }),
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            agent.destroy();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}
