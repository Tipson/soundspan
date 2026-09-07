import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered)
    GlobalRegistrator.register({ url: "http://localhost/album/test" });
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Render the real detail panel and open its secondary actions through the UI. */
export async function renderExpandedDetailActions(
    element: React.ReactNode,
): Promise<string> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(element));
        const more = host.querySelector<HTMLButtonElement>(
            '[aria-label="Ещё действия"]',
        );
        if (more) await act(async () => more.click());
        return (
            host.innerHTML +
            (document.querySelector('[role="dialog"]')?.outerHTML ?? "")
        );
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
}
