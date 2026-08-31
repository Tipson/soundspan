/** Custom soundspan color tokens shared by runtime checks and tests. */
export const DESIGN_TOKENS: Record<string, string> = {
    brand: "#8fa8ff",
    "brand-dark": "#6e85df",
    "brand-hover": "#b3c3ff",
    "brand-light": "#d8e0ff",
    ai: "#9a8cff",
    "ai-dark": "#7365cf",
    "ai-hover": "#c2b8ff",
    surface: "#080a0f",
    "surface-active": "#222a36",
    "surface-elevated": "#1a202a",
    "surface-highlight": "#222a36",
    "surface-hover": "#222a36",
    "surface-overlay": "#1a202a",
    "surface-raised": "#11151d",
    "surface-sunken": "#11151d",
    line: "#2a3240",
    "line-muted": "#3b4657",
    "line-strong": "#57647a",
    content: "#f7f8fc",
    "content-body": "#e1e5ec",
    "content-disabled": "#707988",
    "content-muted": "#aeb6c5",
    "content-secondary": "#c4cad5",
    error: "#ff738e",
    success: "#64d8a8",
    warning: "#f2c46d",
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
