/**
 * iOS Standalone PWA AudioContext Bridge
 *
 * WebKit suspends an `AudioContext` when an installed PWA leaves the
 * foreground while allowing the underlying `HTMLAudioElement` clock to
 * continue. Routing a media element through that suspended context makes
 * the lock-screen timer advance without audible output and can leave a
 * short repeated sample when playback is paused.
 *
 * The production gate therefore remains closed on every platform. The
 * bridge implementation stays isolated and injectable so the engine
 * policy can be regression-tested without putting Web Audio back in the
 * production playback path.
 */

import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

export interface IosStandaloneBridgeEnvironmentInput {
    /** navigator.userAgent */
    userAgent: string;
    /** navigator.maxTouchPoints (iPadOS desktop-mode detection). */
    maxTouchPoints: number;
    /** matchMedia("(display-mode: standalone)").matches */
    isStandaloneDisplayMode: boolean;
    /** Legacy iOS Safari navigator.standalone flag. */
    isLegacyNavigatorStandalone: boolean;
}

/** Returns whether the runtime is an installed iOS/iPadOS web app. */
export function isIosStandalonePwa(
    input: IosStandaloneBridgeEnvironmentInput,
): boolean {
    const userAgent = input.userAgent.toLowerCase();
    const isMobileIos = /iphone|ipad|ipod/.test(userAgent);
    const isDesktopModeIpad =
        userAgent.includes("macintosh") && input.maxTouchPoints > 1;
    const isStandalone =
        input.isStandaloneDisplayMode || input.isLegacyNavigatorStandalone;
    return (isMobileIos || isDesktopModeIpad) && isStandalone;
}

/** Reads the installed-iOS-PWA detector inputs from the browser. */
export function detectIosStandalonePwaEnvironment(): boolean {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
        return false;
    }
    const standaloneNavigator = navigator as Navigator & {
        standalone?: boolean;
    };
    return isIosStandalonePwa({
        userAgent: navigator.userAgent ?? "",
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
        isStandaloneDisplayMode:
            typeof window.matchMedia === "function"
                ? window.matchMedia("(display-mode: standalone)").matches
                : false,
        isLegacyNavigatorStandalone: standaloneNavigator.standalone === true,
    });
}

/**
 * Returns whether production playback may route its media element through
 * Web Audio. This is deliberately false: iOS standalone PWAs need the bare
 * media-element pipeline for audible background playback, and no other
 * platform requires this bridge.
 */
export function shouldUseIosStandaloneAudioBridge(
    _input: IosStandaloneBridgeEnvironmentInput,
): boolean {
    return false;
}

/**
 * Reads the bridge gate inputs from the live browser environment.
 * Returns false during SSR.
 */
export function detectIosStandaloneAudioBridgeEnvironment(): boolean {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
        return false;
    }
    const standaloneNavigator = navigator as Navigator & {
        standalone?: boolean;
    };
    return shouldUseIosStandaloneAudioBridge({
        userAgent: navigator.userAgent ?? "",
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
        isStandaloneDisplayMode:
            typeof window.matchMedia === "function"
                ? window.matchMedia("(display-mode: standalone)").matches
                : false,
        isLegacyNavigatorStandalone: standaloneNavigator.standalone === true,
    });
}

/** Structural subset of MediaElementAudioSourceNode used by the bridge. */
export interface BridgeMediaElementSourceLike {
    connect(destination: AudioDestinationNode): void;
}

/** Structural subset of AudioContext used by the bridge (testable). */
export interface BridgeAudioContextLike {
    state: AudioContextState;
    destination: AudioDestinationNode;
    createMediaElementSource(
        element: HTMLAudioElement,
    ): BridgeMediaElementSourceLike;
    resume(): Promise<void>;
    close(): Promise<void>;
}

const createDefaultAudioContext = (): BridgeAudioContextLike | null => {
    if (typeof window === "undefined") {
        return null;
    }
    const AudioContextCtor =
        window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
    if (!AudioContextCtor) {
        return null;
    }
    return new AudioContextCtor() as BridgeAudioContextLike;
};

/**
 * Isolated compatibility implementation for controlled experiments. The
 * production gate is closed because Web Audio is not background-safe in an
 * installed iOS PWA. `createMediaElementSource` is called at most once per
 * element (calling it twice throws).
 */
export class IosStandaloneAudioContextBridge {
    private context: BridgeAudioContextLike | null = null;
    private bridgedElement: HTMLAudioElement | null = null;
    private readonly createContext: () => BridgeAudioContextLike | null;

    constructor(
        createContext: () => BridgeAudioContextLike | null = createDefaultAudioContext,
    ) {
        this.createContext = createContext;
    }

    /** Whether the bridge currently holds an open context. */
    isActive(): boolean {
        return this.context !== null;
    }

    /**
     * Creates the context and element source on first use; subsequent
     * calls for the same element are no-ops.
     */
    ensureForElement(element: HTMLAudioElement): void {
        if (this.context && this.bridgedElement === element) {
            return;
        }
        if (this.context && this.bridgedElement !== element) {
            sharedFrontendLogger.warn(
                "[NativeAudioEngine][iOSBridge] Bridge already bound to a different element; skipping rebind.",
            );
            return;
        }
        try {
            const context = this.createContext();
            if (!context) {
                return;
            }
            context
                .createMediaElementSource(element)
                .connect(context.destination);
            this.context = context;
            this.bridgedElement = element;
            sharedFrontendLogger.info(
                "[NativeAudioEngine][iOSBridge] AudioContext bridge established for standalone iOS PWA playback.",
            );
        } catch (err) {
            sharedFrontendLogger.error(
                "[NativeAudioEngine][iOSBridge] Failed to establish AudioContext bridge:",
                err,
            );
        }
    }

    /** Resumes a suspended context (call around user-gesture play). */
    resumeIfSuspended(): void {
        if (!this.context || this.context.state !== "suspended") {
            return;
        }
        void this.context.resume().catch((err) => {
            sharedFrontendLogger.warn(
                "[NativeAudioEngine][iOSBridge] Failed to resume AudioContext:",
                err,
            );
        });
    }

    /** Closes the context and releases the element binding. */
    close(): void {
        if (!this.context) {
            return;
        }
        void this.context.close().catch(() => undefined);
        this.context = null;
        this.bridgedElement = null;
    }
}
