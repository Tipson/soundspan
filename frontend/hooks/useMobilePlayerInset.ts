"use client";

import { useCallback, useRef, type RefCallback } from "react";

const INSET_PROPERTY = "--app-mini-player-inset";
const SHELL_SELECTOR = ".mobile-shell-frame";
interface DockOwner {
    dock: HTMLDivElement;
    height: number | null;
}
interface ShellReservation {
    previousValue: string;
    previousPriority: string;
    owners: Map<symbol, DockOwner>;
}
const reservations = new WeakMap<HTMLElement, ShellReservation>();

function restorePrevious(shell: HTMLElement, reservation: ShellReservation) {
    if (reservation.previousValue) {
        shell.style.setProperty(
            INSET_PROPERTY,
            reservation.previousValue,
            reservation.previousPriority,
        );
    } else {
        shell.style.removeProperty(INSET_PROPERTY);
    }
}

function publishInset(shell: HTMLElement, reservation: ShellReservation) {
    const heights: number[] = [];
    for (const owner of reservation.owners.values()) {
        if (
            owner.height !== null &&
            owner.dock.isConnected &&
            owner.dock.closest(SHELL_SELECTOR) === shell
        ) {
            heights.push(owner.height);
        }
    }
    if (heights.length === 0) {
        restorePrevious(shell, reservation);
        return;
    }
    const value = Math.max(...heights) + "px";
    if (
        shell.style.getPropertyValue(INSET_PROPERTY) !== value ||
        shell.style.getPropertyPriority(INSET_PROPERTY)
    ) {
        shell.style.setProperty(INSET_PROPERTY, value);
    }
}

/** Reserves actual mini-player geometry without subscribing to playback or React state. */
export function useMobilePlayerInset(): RefCallback<HTMLDivElement> {
    const releaseRef = useRef<(() => void) | null>(null);
    return useCallback((dock: HTMLDivElement | null) => {
        releaseRef.current?.();
        releaseRef.current = null;
        if (!dock || typeof window === "undefined") return;
        const shell = dock.closest<HTMLElement>(SHELL_SELECTOR);
        if (!shell) return;

        const reservation = reservations.get(shell) ?? {
            previousValue: shell.style.getPropertyValue(INSET_PROPERTY),
            previousPriority: shell.style.getPropertyPriority(INSET_PROPERTY),
            owners: new Map<symbol, DockOwner>(),
        };
        reservations.set(shell, reservation);
        const token = Symbol("mini-player-inset");
        const owner: DockOwner = { dock, height: null };
        reservation.owners.set(token, owner);
        let active = true;
        let observer: ResizeObserver | null = null;

        const measure = () => {
            if (
                !active ||
                !dock.isConnected ||
                !shell.isConnected ||
                dock.closest(SHELL_SELECTOR) !== shell ||
                reservations.get(shell) !== reservation ||
                !reservation.owners.has(token)
            )
                return;
            const height = dock.getBoundingClientRect().height;
            if (!Number.isFinite(height) || height <= 0) return;
            owner.height = height;
            publishInset(shell, reservation);
        };
        releaseRef.current = () => {
            if (!active) return;
            active = false;
            observer?.disconnect();
            reservation.owners.delete(token);
            if (reservation.owners.size === 0) {
                reservations.delete(shell);
                restorePrevious(shell, reservation);
            } else {
                publishInset(shell, reservation);
            }
        };
        measure();
        if (typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(measure);
            observer.observe(dock);
        }
    }, []);
}
