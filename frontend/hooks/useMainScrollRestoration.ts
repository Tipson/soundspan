"use client";

import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type RefObject,
} from "react";

const MAX_SAVED_ROUTES = 50;
const RESTORE_DEADLINE_MS = 2000;

/** Restore the shell's inner scroll container on browser back/forward only.
 * State belongs to the mounted account shell; no history/router objects are patched.
 */
export function useMainScrollRestoration(
    containerRef: RefObject<HTMLElement | null>,
    routeKey: string,
) {
    const positions = useRef(new Map<string, number>());
    const activeRoute = useRef(routeKey);
    const traversal = useRef<string | null>(null);
    const restoring = useRef(false);
    const [traversalVersion, setTraversalVersion] = useState(0);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const currentLocation = () => {
            const query = new URLSearchParams(
                window.location.search,
            ).toString();
            return window.location.pathname + (query ? `?${query}` : "");
        };
        const remember = () => {
            // Next can reset scroll after changing the URL but before React commits.
            if (restoring.current || currentLocation() !== activeRoute.current)
                return;
            const saved = positions.current;
            saved.delete(activeRoute.current);
            saved.set(activeRoute.current, container.scrollTop);
            if (saved.size > MAX_SAVED_ROUTES) {
                const oldest = saved.keys().next().value;
                if (oldest !== undefined) saved.delete(oldest);
            }
        };
        const onTraversal = () => {
            traversal.current = currentLocation();
            // Next's earlier popstate listener may already have committed routeKey.
            // Schedule our own commit so restoration does not depend on listener order.
            setTraversalVersion((version) => version + 1);
        };
        container.addEventListener("scroll", remember, { passive: true });
        window.addEventListener("popstate", onTraversal, true);
        return () => {
            container.removeEventListener("scroll", remember);
            window.removeEventListener("popstate", onTraversal, true);
        };
    }, [containerRef]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const target =
            traversal.current === routeKey
                ? positions.current.get(routeKey)
                : undefined;
        activeRoute.current = routeKey;
        if (traversal.current === routeKey) traversal.current = null;
        if (!container || target === undefined) return;

        restoring.current = true;
        let frame = 0;
        let stopped = false;
        const deadline = performance.now() + RESTORE_DEADLINE_MS;
        const stop = () => {
            stopped = true;
            restoring.current = false;
            window.cancelAnimationFrame(frame);
            container.removeEventListener("wheel", stop);
            container.removeEventListener("touchstart", stop);
            container.removeEventListener("pointerdown", stop);
            container.removeEventListener("keydown", stop);
        };
        const restore = () => {
            if (stopped) return;
            container.scrollTop = target;
            if (
                container.scrollHeight - container.clientHeight >= target ||
                performance.now() >= deadline
            ) {
                stop();
            } else {
                frame = window.requestAnimationFrame(restore);
            }
        };
        container.addEventListener("wheel", stop, { passive: true });
        container.addEventListener("touchstart", stop, { passive: true });
        container.addEventListener("pointerdown", stop, { passive: true });
        container.addEventListener("keydown", stop);
        // Run after the router's commit/scroll effects; bounded retries allow loading content.
        frame = window.requestAnimationFrame(restore);
        return stop;
    }, [containerRef, routeKey, traversalVersion]);
}
