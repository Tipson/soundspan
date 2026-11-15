import type { Request } from "express";

const MAX_COOKIE_HEADER_LENGTH = 4096;
const MAX_COOKIE_COUNT = 64;

/** Reads one unambiguous cookie from a size/count-bounded request header. */
export function readCookie(req: Request, name: string): string | null {
    const header = req.headers.cookie;
    if (!header || header.length > MAX_COOKIE_HEADER_LENGTH) return null;
    const cookies = header.split(";");
    if (cookies.length > MAX_COOKIE_COUNT) return null;
    let value: string | null = null;
    for (const rawCookie of cookies) {
        const cookie = rawCookie.trim();
        const separator = cookie.indexOf("=");
        if (separator < 0 || cookie.slice(0, separator) !== name) continue;
        if (value !== null) return null;
        value = cookie.slice(separator + 1);
    }
    return value || null;
}
