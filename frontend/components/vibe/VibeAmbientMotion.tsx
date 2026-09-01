"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WaveMode, WaveMood } from "@/lib/audio-state-context";
import {
    resolveVibeMotionProfile,
    shouldAnimateVibeAmbient,
} from "./vibeMotionProfile";

interface VibeAmbientMotionProps {
    trackId: string | null;
    bpm?: number | null;
    energy?: number | null;
    mode: WaveMode;
    mood: WaveMood;
    isPlaying: boolean;
    className?: string;
}

interface NavigatorMotionHints extends Navigator {
    connection?: EventTarget & { saveData?: boolean };
    deviceMemory?: number;
}

interface MotionEnvironment {
    isReady: boolean;
    isDesktop: boolean;
    isVisible: boolean;
    prefersReducedMotion: boolean;
    lowPower: boolean;
}

const STATIC_ENVIRONMENT: MotionEnvironment = {
    isReady: false,
    isDesktop: false,
    isVisible: true,
    prefersReducedMotion: false,
    lowPower: false,
};

function readLowPowerHint(): boolean {
    if (typeof navigator === "undefined") return false;
    const hints = navigator as NavigatorMotionHints;
    return (
        hints.connection?.saveData === true ||
        (typeof hints.deviceMemory === "number" && hints.deviceMemory <= 2) ||
        (typeof hints.hardwareConcurrency === "number" &&
            hints.hardwareConcurrency <= 2)
    );
}

function useMotionEnvironment(): MotionEnvironment {
    const [environment, setEnvironment] =
        useState<MotionEnvironment>(STATIC_ENVIRONMENT);

    useEffect(() => {
        const motionQuery = window.matchMedia?.(
            "(prefers-reduced-motion: reduce)",
        );
        const desktopQuery = window.matchMedia?.("(min-width: 1025px)");
        const connection = (navigator as NavigatorMotionHints).connection;
        const update = () => {
            setEnvironment({
                isReady: true,
                isDesktop: desktopQuery?.matches ?? window.innerWidth >= 1025,
                isVisible: document.visibilityState !== "hidden",
                prefersReducedMotion: motionQuery?.matches ?? false,
                lowPower: readLowPowerHint(),
            });
        };

        update();
        document.addEventListener("visibilitychange", update);
        motionQuery?.addEventListener?.("change", update);
        desktopQuery?.addEventListener?.("change", update);
        connection?.addEventListener?.("change", update);
        return () => {
            document.removeEventListener("visibilitychange", update);
            motionQuery?.removeEventListener?.("change", update);
            desktopQuery?.removeEventListener?.("change", update);
            connection?.removeEventListener?.("change", update);
        };
    }, []);

    return environment;
}

function readMotionPalette(): string[] {
    const styles = window.getComputedStyle(document.documentElement);
    const palette = [
        "--color-brand-light",
        "--color-ai-hover",
        "--color-warning",
        "--color-brand",
    ].map((token) => styles.getPropertyValue(token).trim());
    return palette.map((color) => color || "white");
}

function drawAmbientWaves(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    phase: number,
    energy: number,
    seedPhase: number,
    palette: readonly string[],
): void {
    context.clearRect(0, 0, width, height);
    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";
    context.lineJoin = "round";

    const beatPulse = 0.5 + 0.5 * Math.sin(phase - Math.PI / 2);
    const pulseScale = 0.86 + beatPulse * (0.08 + energy * 0.1);
    const pointStride = Math.max(10, Math.floor(width / 140));

    for (let layer = 0; layer < 4; layer += 1) {
        const layerRatio = layer / 3;
        const centerY = height * (0.3 + layerRatio * 0.34);
        const amplitude =
            height *
            (0.028 + energy * 0.042) *
            pulseScale *
            (1 - layerRatio * 0.16);
        const spatialCycles = 1.15 + energy * 0.8 + layerRatio * 0.34;
        const flowPhase =
            seedPhase + phase * (0.11 + layerRatio * 0.018) + layer * 1.37;

        context.beginPath();
        for (let x = -pointStride; x <= width + pointStride; x += pointStride) {
            const normalizedX = x / Math.max(width, 1);
            const fundamental = Math.sin(
                normalizedX * Math.PI * 2 * spatialCycles + flowPhase,
            );
            const harmonic =
                0.38 *
                Math.sin(
                    normalizedX * Math.PI * 2 * (spatialCycles * 1.85) -
                        flowPhase * 0.72 +
                        layer,
                );
            const y = centerY + amplitude * (fundamental + harmonic);
            if (x === -pointStride) context.moveTo(x, y);
            else context.lineTo(x, y);
        }

        const color = palette[layer % palette.length] ?? "white";
        context.strokeStyle = color;
        context.shadowColor = color;
        context.shadowBlur = 9 + energy * 15;
        context.lineWidth = 1.1 + energy * 2.2 + (3 - layer) * 0.3;
        context.globalAlpha = 0.12 + energy * 0.08 - layerRatio * 0.02;
        context.stroke();
    }
    context.restore();
}

/**
 * Tempo-aware visual layer for My Wave.
 *
 * Supplied analyzed BPM/energy drives the cadence. Online-first tracks without
 * those fields use a deterministic track + mode + mood visual fallback; that
 * fallback is not an audio measurement. This component never reads or reroutes
 * the media element and must remain independent from the playback audio graph.
 */
export function VibeAmbientMotion({
    trackId,
    bpm,
    energy,
    mode,
    mood,
    isPlaying,
    className = "",
}: VibeAmbientMotionProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const phaseRef = useRef(0);
    const environment = useMotionEnvironment();
    const profile = useMemo(
        () =>
            resolveVibeMotionProfile({
                trackId,
                bpm,
                energy,
                mode,
                mood,
            }),
        [bpm, energy, mode, mood, trackId],
    );
    const shouldAnimate =
        environment.isReady &&
        shouldAnimateVibeAmbient({
            isDesktop: environment.isDesktop,
            isPlaying,
            isVisible: environment.isVisible,
            prefersReducedMotion: environment.prefersReducedMotion,
            lowPower: environment.lowPower,
        });

    useEffect(() => {
        phaseRef.current = profile.seedPhase;
    }, [profile.seedPhase]);

    useEffect(() => {
        if (!environment.isReady || !environment.isDesktop) return;
        const canvas = canvasRef.current;
        if (!canvas) return;

        let context: CanvasRenderingContext2D | null = null;
        try {
            context = canvas.getContext("2d");
        } catch {
            return;
        }
        if (!context) return;

        const palette = readMotionPalette();
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        let width = 0;
        let height = 0;
        let frameId: number | null = null;
        let lastFrameAt = 0;
        const minFrameInterval = 1000 / 30;

        const draw = () => {
            if (width <= 0 || height <= 0 || !context) return;
            drawAmbientWaves(
                context,
                width,
                height,
                phaseRef.current,
                profile.energy,
                profile.seedPhase,
                palette,
            );
        };
        const resize = () => {
            const bounds = canvas.getBoundingClientRect();
            width = Math.max(0, Math.round(bounds.width));
            height = Math.max(0, Math.round(bounds.height));
            canvas.width = Math.max(1, Math.round(width * pixelRatio));
            canvas.height = Math.max(1, Math.round(height * pixelRatio));
            context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            draw();
        };
        const tick = (timestamp: number) => {
            if (lastFrameAt === 0) lastFrameAt = timestamp;
            const elapsedMs = timestamp - lastFrameAt;
            if (elapsedMs >= minFrameInterval) {
                const elapsedSeconds = Math.min(elapsedMs / 1000, 0.08);
                phaseRef.current += elapsedSeconds * profile.phaseVelocity;
                lastFrameAt = timestamp;
                draw();
            }
            frameId = window.requestAnimationFrame(tick);
        };

        resize();
        const resizeObserver =
            typeof ResizeObserver === "function"
                ? new ResizeObserver(resize)
                : null;
        resizeObserver?.observe(canvas);
        if (!resizeObserver) window.addEventListener("resize", resize);
        if (
            shouldAnimate &&
            typeof window.requestAnimationFrame === "function"
        ) {
            frameId = window.requestAnimationFrame(tick);
        }

        return () => {
            if (frameId !== null) window.cancelAnimationFrame(frameId);
            resizeObserver?.disconnect();
            if (!resizeObserver) window.removeEventListener("resize", resize);
        };
    }, [environment.isDesktop, environment.isReady, profile, shouldAnimate]);

    const motionState = environment.prefersReducedMotion
        ? "reduced-motion"
        : environment.lowPower
          ? "low-power"
          : !environment.isDesktop
            ? "compact-static"
            : !environment.isVisible
              ? "hidden"
              : isPlaying
                ? "playing"
                : "paused";

    return (
        <canvas
            ref={canvasRef}
            aria-hidden="true"
            data-testid="wave-tempo-motion"
            data-motion-state={motionState}
            data-motion-tempo-source={profile.tempoSource}
            data-motion-energy-source={profile.energySource}
            data-motion-bpm={profile.bpm.toFixed(1)}
            data-motion-energy={profile.energy.toFixed(2)}
            className={`pointer-events-none absolute inset-0 hidden h-full w-full opacity-75 [mix-blend-mode:screen] min-[1025px]:block ${className}`}
        />
    );
}
