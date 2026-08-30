import type { DeviceAudioExportResult } from "./vault";

export interface PhysicalFileDownloadLink {
    href: string;
    download: string;
    rel: string;
    click(): void;
    remove(): void;
}

export interface PhysicalFileDownloadRuntime {
    createLink(): PhysicalFileDownloadLink;
    appendLink(link: PhysicalFileDownloadLink): void;
    defer(callback: () => void): void;
}

function browserRuntime(): PhysicalFileDownloadRuntime {
    if (typeof document === "undefined") {
        throw new Error("Browser file downloads are unavailable");
    }
    return {
        createLink: () => document.createElement("a"),
        appendLink: (link) => document.body.append(link as HTMLAnchorElement),
        // Delayed revocation gives the browser time to take ownership of the
        // Blob URL before the app releases its temporary vault lease.
        defer: (callback) => window.setTimeout(callback, 1_000),
    };
}

/** Hand one verified offline file to the browser's normal download/save flow. */
export function startPhysicalFileDownload(
    input: Pick<DeviceAudioExportResult, "url" | "displayName" | "release">,
    runtime: PhysicalFileDownloadRuntime = browserRuntime(),
): void {
    const link = runtime.createLink();
    link.href = input.url;
    link.download = input.displayName;
    link.rel = "noopener";
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        input.release();
    };
    try {
        runtime.appendLink(link);
        link.click();
        link.remove();
        runtime.defer(release);
    } catch (error) {
        link.remove();
        release();
        throw error;
    }
}
