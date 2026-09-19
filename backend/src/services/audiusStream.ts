import axios from "axios";
import {
    isAllowedAudiusContentNodeUrl,
    isAllowedAudiusCdnUrl,
} from "@soundspan/media-metadata-contract";
import {
    resolveSafeOutboundUrl,
    resolveSafeOutboundRedirectTarget,
} from "./outboundUrlSafety";

/** Sanitized unsupported transport result; never contains signed URLs or raw headers. */
export class AudiusStreamUnavailableError extends Error {
    constructor(readonly status = 422) {
        super("Audius media node is unavailable or unsupported");
    }
}

/** Await DNS validation within the caller's shared deadline without retaining abort listeners. */
export function awaitAudiusDeadline<T>(
    work: Promise<T>,
    signal: AbortSignal,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error("Audius request cancelled"));
        if (signal.aborted) {
            void work.then(
                () => {},
                () => {},
            );
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
        work.then(resolve, reject).finally(() =>
            signal.removeEventListener("abort", abort),
        );
    });
}

/** Inspect official → content node → optional exact CDN with at most three GETs. */
export async function resolveAudiusStreamRedirect(
    path: string,
    signal: AbortSignal,
): Promise<string> {
    if (!/^\/tracks\/[A-Za-z0-9]{3,32}\/stream\?app_name=Soundspan$/.test(path))
        throw new Error("Invalid Audius stream path");
    const current = await awaitAudiusDeadline(
        resolveSafeOutboundUrl(`https://api.audius.co/v1${path}`),
        signal,
    );
    if (!current) throw new AudiusStreamUnavailableError();
    signal.throwIfAborted();
    const options = {
        signal,
        timeout: 8000,
        proxy: false as const,
        maxRedirects: 0,
        maxContentLength: 4096,
        headers: { Accept: "audio/*" },
        validateStatus: () => true,
    };
    const response = await axios.get(current, {
        ...options,
        responseType: "stream",
    });
    // The official endpoint must redirect. Destroy even unexpected status bodies immediately.
    response.data?.destroy();
    const location: unknown = response.headers.location;
    if (response.status === 429) throw new AudiusStreamUnavailableError(429);
    if (response.status !== 302 || !isAllowedAudiusContentNodeUrl(location))
        throw new AudiusStreamUnavailableError();
    const target = await awaitAudiusDeadline(
        resolveSafeOutboundRedirectTarget(location, current),
        signal,
    );
    if (!target) throw new AudiusStreamUnavailableError();
    signal.throwIfAborted();
    // GET signatures may not authorize HEAD. Range qualification also verifies seek transport.
    let candidate = target;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        signal.throwIfAborted();
        const terminal = await axios.get(candidate, {
            ...options,
            responseType: "stream",
            headers: { Accept: "audio/*", Range: "bytes=0-0" },
        });
        // Headers-only: never read or buffer an upstream media body, even if Range was ignored.
        terminal.data?.destroy();
        if (terminal.status === 429)
            throw new AudiusStreamUnavailableError(429);
        if (
            terminal.status === 206 &&
            /^audio\//i.test(String(terminal.headers["content-type"] ?? "")) &&
            /^bytes 0-0\/[1-9]\d*$/.test(
                String(terminal.headers["content-range"] ?? ""),
            )
        )
            return candidate;
        const next: unknown = terminal.headers.location;
        if (
            attempt !== 0 ||
            terminal.status !== 302 ||
            !isAllowedAudiusCdnUrl(next) ||
            new URL(next).pathname.split("/").at(-1) !==
                new URL(target).pathname.split("/").at(-1)
        )
            throw new AudiusStreamUnavailableError();
        const safe = await awaitAudiusDeadline(
            resolveSafeOutboundRedirectTarget(next, candidate),
            signal,
        );
        if (!safe) throw new AudiusStreamUnavailableError();
        candidate = safe;
    }
    throw new AudiusStreamUnavailableError();
}
