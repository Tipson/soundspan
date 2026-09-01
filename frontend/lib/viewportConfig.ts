import type { Viewport } from "next";

/** Shared mobile viewport policy; pinch zoom remains available for accessibility. */
export const APP_VIEWPORT: Viewport = {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: "#000000",
};
