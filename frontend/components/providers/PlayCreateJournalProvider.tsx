"use client";

import { useLayoutEffect, type ReactNode } from "react";
import { api } from "@/lib/api";
import {
    getAuthRuntimeLease,
    isCurrentAuthRuntime,
} from "@/lib/auth-runtime-generation";
import { createPlayCreateJournalRuntime } from "@/lib/playCreateJournalRuntime";
import { installPlayCreateJournalBridge } from "@/lib/playCreateJournalBridge";
import { createPlayCreateLoginNonce } from "@/lib/playCreateLoginFence";
import { frontendLogger } from "@/lib/logger";

const logger = frontendLogger.child("PlayCreateJournalProvider");

/** Mount accounting for the authenticated audio owner, without delaying or controlling its player. */
export function PlayCreateJournalProvider({
    ownerId,
    children,
}: {
    ownerId: string | null;
    children?: ReactNode;
}) {
    useLayoutEffect(() => {
        if (!ownerId || typeof window === "undefined") return;
        const authLease = getAuthRuntimeLease();
        let generation = 0;
        let online = navigator.onLine !== false;
        const runtime = createPlayCreateJournalRuntime({
            ownerId,
            api,
            auth: {
                signal: authLease.signal,
                isCurrent: () =>
                    !authLease.signal.aborted &&
                    isCurrentAuthRuntime(authLease.generation),
            },
            network: {
                isOnline: () => online && navigator.onLine !== false,
                getGeneration: () => generation,
            },
            nowMonotonic: () => performance.now(),
            nonce: () => {
                const nonce = createPlayCreateLoginNonce();
                if (!nonce)
                    throw new Error("Secure Play identity is unavailable");
                return nonce;
            },
            schedule: (run, delayMs) => {
                const timer = window.setTimeout(run, delayMs);
                return () => window.clearTimeout(timer);
            },
        });
        const dispose = installPlayCreateJournalBridge({
            runtime,
            api,
            authLease,
        });
        const onOnline = () => {
            generation++;
            online = true;
            runtime.wake();
        };
        const onOffline = () => {
            generation++;
            online = false;
            runtime.wake();
        };
        const onVisible = () => {
            if (
                document.visibilityState === "visible" &&
                online &&
                navigator.onLine !== false
            )
                runtime.wake();
        };
        window.addEventListener("online", onOnline);
        window.addEventListener("offline", onOffline);
        document.addEventListener("visibilitychange", onVisible);
        void runtime
            .prepare()
            .catch(() => logger.warn("Play journal preparation failed"));
        return () => {
            window.removeEventListener("online", onOnline);
            window.removeEventListener("offline", onOffline);
            document.removeEventListener("visibilitychange", onVisible);
            dispose();
        };
    }, [ownerId]);
    return <>{children}</>;
}
