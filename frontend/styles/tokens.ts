/** Custom soundspan color tokens shared by runtime checks and tests. */
export const DESIGN_TOKENS: Record<string, string> = {
    brand: "#a970ff",
    "brand-dark": "#7f4bd3",
    "brand-hover": "#c497ff",
    "brand-light": "#decaff",
    ai: "#d866c7",
    "ai-dark": "#a73e96",
    "ai-hover": "#f19ae5",
    surface: "#090909",
    "surface-active": "#28272b",
    "surface-elevated": "#1c1b1e",
    "surface-highlight": "#28272b",
    "surface-hover": "#28272b",
    "surface-overlay": "#1c1b1e",
    "surface-raised": "#121214",
    "surface-sunken": "#101011",
    line: "#2b292f",
    "line-muted": "#403c47",
    "line-strong": "#615a69",
    content: "#faf8fc",
    "content-body": "#e8e3eb",
    "content-disabled": "#77717d",
    "content-muted": "#aaa3b0",
    "content-secondary": "#cdc6d1",
    error: "#ff738e",
    success: "#64d8a8",
    warning: "#f0a45c",
};

/** WCAG AA contrast threshold for normal text. */
export const AA_NORMAL = 4.5;

/** WCAG AA contrast threshold for large text. */
export const AA_LARGE = 3;

/** WCAG contrast threshold for non-text UI components and states. */
export const NON_TEXT = 3;

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
        throw new TypeError(`Expected a 6-digit hex color, received: ${hex}`);
    }

    return [
        Number.parseInt(hex.slice(1, 3), 16),
        Number.parseInt(hex.slice(3, 5), 16),
        Number.parseInt(hex.slice(5, 7), 16),
    ];
}

function linearizeSrgb(channel: number): number {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Calculates WCAG relative luminance for a six-digit sRGB hex color. */
export function relativeLuminance(hex: string): number {
    const [red, green, blue] = parseHex(hex);
    return (
        0.2126 * linearizeSrgb(red) +
        0.7152 * linearizeSrgb(green) +
        0.0722 * linearizeSrgb(blue)
    );
}

/** Calculates the WCAG contrast ratio between two six-digit sRGB hex colors. */
export function contrastRatio(fgHex: string, bgHex: string): number {
    const foreground = relativeLuminance(fgHex);
    const background = relativeLuminance(bgHex);
    const lighter = Math.max(foreground, background);
    const darker = Math.min(foreground, background);
    return (lighter + 0.05) / (darker + 0.05);
}

function channelToHex(channel: number): string {
    return Math.round(channel).toString(16).padStart(2, "0");
}

/** Composites a six-digit foreground color over a six-digit background color. */
export function compositeOver(
    fgHex: string,
    bgHex: string,
    alpha: number,
): string {
    const foreground = parseHex(fgHex);
    const background = parseHex(bgHex);
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
        throw new RangeError(
            `Expected alpha between 0 and 1, received: ${alpha}`,
        );
    }

    const channels = foreground.map(
        (channel, index) => channel * alpha + background[index] * (1 - alpha),
    );
    return `#${channels.map(channelToHex).join("")}`;
}
