"use client";

import { useEffect } from "react";

const locks = new WeakMap<HTMLElement, { owners: number; overflow: string }>();

/** Keeps body scrolling locked until the last participating overlay closes. */
export function useBodyScrollLock(isOpen: boolean) {
    useEffect(() => {
        if (!isOpen) return;
        const body = document.body;
        const lock = locks.get(body) ?? {
            owners: 0,
            overflow: body.style.overflow,
        };
        lock.owners += 1;
        locks.set(body, lock);
        body.style.overflow = "hidden";
        return () => {
            lock.owners -= 1;
            if (lock.owners === 0) {
                body.style.overflow = lock.overflow;
                locks.delete(body);
            }
        };
    }, [isOpen]);
}
