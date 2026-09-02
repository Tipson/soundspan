import type { Response } from "express";
import { getHttpErrorStatus } from "../utils/httpErrorStatus";

type StreamProxyErrorBody = { error: string; message?: string };

const STREAM_PROXY_ERRORS: Record<number, StreamProxyErrorBody> = {
    404: { error: "Stream not found" },
    429: { error: "YouTube Music rate limit reached" },
    451: {
        error: "age_restricted",
        message:
            "This content requires age verification and cannot be streamed via YouTube Music.",
    },
    502: { error: "YouTube Music network unavailable" },
    503: { error: "YouTube Music streaming is busy" },
    504: { error: "YouTube Music stream timed out" },
};

export function handleYtMusicStreamProxyError(
    res: Response,
    error: unknown,
): boolean {
    const status = getHttpErrorStatus(error);
    if (typeof status !== "number" || !STREAM_PROXY_ERRORS[status]) {
        return false;
    }
    res.status(status).json(STREAM_PROXY_ERRORS[status]);
    return true;
}
