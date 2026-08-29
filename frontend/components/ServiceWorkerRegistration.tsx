"use client";

import { useEffect } from "react";
import { createFrontendLogger } from "@/lib/logger";
import {
    createMigratingStorageKey,
    readMigratingStorageItem,
} from "@/lib/storage-migration";
import { createLegacyBackgroundCleanupLoop } from "@/features/device-offline/legacyBackgroundCleanup";

type BrowserServiceWorkerRegistration = globalThis.ServiceWorkerRegistration;

const IS_PLAYING_KEY = createMigratingStorageKey("is_playing");
const WAITING_WORKER_CHECK_INTERVAL_MS = 2000;
const logger = createFrontendLogger("ServiceWorker");

function isPlaybackActive(): boolean {
    return readMigratingStorageItem(IS_PLAYING_KEY) === "true";
}

function maybeActivateWaitingWorker(
    registration: BrowserServiceWorkerRegistration,
    context: string,
    deferredLogRef: { value: boolean },
) {
    const waitingWorker = registration.waiting;
    if (!waitingWorker) {
        deferredLogRef.value = false;
        return;
    }

    if (isPlaybackActive()) {
        if (!deferredLogRef.value) {
            deferredLogRef.value = true;
            logger.info("Update ready but deferred while playback is active", {
                context,
            });
        }
        return;
    }

    deferredLogRef.value = false;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

/**
 * Renders the ServiceWorkerRegistration component.
 */
export function ServiceWorkerRegistration() {
    useEffect(() => {
        if (typeof window === "undefined") return;
        if (!("serviceWorker" in navigator)) return;

        let disposed = false;
        let waitingWorkerIntervalId: number | null = null;
        let registrationRef: BrowserServiceWorkerRegistration | null = null;
        let updateFoundHandler: (() => void) | null = null;
        const deferredLogRef = { value: false };
        const legacyBackgroundCleanup = createLegacyBackgroundCleanupLoop();

        const handleControllerChange = () => {
            logger.info("Service worker controller updated");
            legacyBackgroundCleanup.trigger();
        };

        const handleVisibilityChange = () => {
            if (document.hidden) return;
            legacyBackgroundCleanup.trigger();
            if (!registrationRef) return;
            maybeActivateWaitingWorker(
                registrationRef,
                "visibilitychange",
                deferredLogRef,
            );
        };

        navigator.serviceWorker.addEventListener(
            "controllerchange",
            handleControllerChange,
        );
        window.addEventListener("focus", legacyBackgroundCleanup.trigger);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        legacyBackgroundCleanup.trigger();

        navigator.serviceWorker
            .register("/sw.js")
            .then((registration) => {
                if (disposed) return;
                registrationRef = registration;

                updateFoundHandler = () => {
                    const installingWorker = registration.installing;
                    if (!installingWorker) return;

                    const handleInstallingStateChange = () => {
                        if (installingWorker.state !== "installed") return;

                        installingWorker.removeEventListener(
                            "statechange",
                            handleInstallingStateChange,
                        );

                        if (!navigator.serviceWorker.controller) return;

                        maybeActivateWaitingWorker(
                            registration,
                            "updatefound",
                            deferredLogRef,
                        );
                    };

                    installingWorker.addEventListener(
                        "statechange",
                        handleInstallingStateChange,
                    );
                };

                registration.addEventListener(
                    "updatefound",
                    updateFoundHandler,
                );

                logger.info("Service worker registered", {
                    scope: registration.scope,
                });
                legacyBackgroundCleanup.trigger();
                maybeActivateWaitingWorker(
                    registration,
                    "register",
                    deferredLogRef,
                );

                waitingWorkerIntervalId = window.setInterval(() => {
                    if (!registrationRef) return;
                    maybeActivateWaitingWorker(
                        registrationRef,
                        "poll",
                        deferredLogRef,
                    );
                }, WAITING_WORKER_CHECK_INTERVAL_MS);
            })
            .catch((error) => {
                logger.error("Service worker registration failed", error);
            });

        return () => {
            disposed = true;

            if (waitingWorkerIntervalId !== null) {
                window.clearInterval(waitingWorkerIntervalId);
                waitingWorkerIntervalId = null;
            }
            legacyBackgroundCleanup.stop();

            window.removeEventListener(
                "focus",
                legacyBackgroundCleanup.trigger,
            );
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
            navigator.serviceWorker.removeEventListener(
                "controllerchange",
                handleControllerChange,
            );

            if (registrationRef && updateFoundHandler) {
                registrationRef.removeEventListener(
                    "updatefound",
                    updateFoundHandler,
                );
            }
        };
    }, []);

    return null;
}
