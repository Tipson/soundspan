"use client";

/**
 * JourneyPanel — the Journey/Drift-mode overlay. Presentational: destination is
 * either a map dot ("pick on map") or a mood chip (disabled when the bucket is
 * too thin to route). Submitting draws + lists the numbered waypoint route;
 * "Play journey" queues it. The Drift section is the one-shot shortcut: a
 * "drift toward <mood>" button per mood that journeys 12 steps from now-playing.
 */

import { ListPlus, Loader2, MapPin, Play, Route, X } from "lucide-react";
import { vibeMapRu, vibeTrackCount } from "@/lib/i18n/vibeMapRu";
import {
    VIBE_PANEL_CLASS,
    VIBE_PANEL_STYLE,
    PANEL_CLOSE_CLASS,
} from "./TravelPanel";
import type { JourneyView } from "./useVibeMode";
import { VibeTrackRow } from "./VibeTrackRow";
import { moodLabel } from "./types";

/** Mood buckets thinner than this can't seed a journey (mirrors the backend). */
const MIN_MOOD_TRACKS = 5;

function JourneyHeader({
    fromLabel,
    close,
}: Pick<JourneyView, "fromLabel" | "close">) {
    return (
        <>
            <div className="flex items-center gap-2 mb-2">
                <Route className="w-4 h-4 text-indigo-300" />
                <span className="text-sm font-semibold text-white">
                    {vibeMapRu.journey.title}
                </span>
                <button
                    type="button"
                    onClick={close}
                    aria-label={vibeMapRu.journey.exit}
                    title={vibeMapRu.journey.exit}
                    className={PANEL_CLOSE_CLASS}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
            <p className="text-xs text-gray-400 mb-2">
                {vibeMapRu.journey.from}{" "}
                <span className="text-white">{fromLabel}</span>
            </p>
        </>
    );
}

function DestinationPicker({ view }: { view: JourneyView }) {
    const { picking, destTrackId, destLabel, togglePick } = view;
    return (
        <>
            <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                {vibeMapRu.journey.destination}
            </p>
            <button
                type="button"
                onClick={togglePick}
                aria-pressed={picking}
                className={`w-full min-h-[40px] flex items-center gap-2 px-2 py-2 mb-2 rounded-lg border text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${picking ? "border-indigo-400/60 bg-indigo-500/20 text-white" : "border-white/10 text-gray-300 hover:bg-white/5"}`}
            >
                <MapPin className="w-4 h-4 shrink-0" />
                {picking
                    ? vibeMapRu.journey.clickDestination
                    : destTrackId
                      ? `${vibeMapRu.journey.destinationPrefix}: ${destLabel}`
                      : vibeMapRu.journey.chooseOnMap}
            </button>
        </>
    );
}

function MoodChoices({ view }: { view: JourneyView }) {
    return (
        <div className="flex flex-wrap gap-1.5 mb-3">
            {view.moods.map((m) => {
                const thin = m.trackCount < MIN_MOOD_TRACKS;
                const active = view.moodTarget === m.mood;
                return (
                    <button
                        key={m.mood}
                        type="button"
                        disabled={thin}
                        onClick={() => view.chooseMood(m.mood)}
                        aria-pressed={active}
                        title={
                            thin
                                ? vibeMapRu.journey.notEnoughMoodTracks
                                : vibeTrackCount(m.trackCount)
                        }
                        className={`inline-flex items-center gap-1 min-h-[36px] px-3 py-1.5 rounded-full border text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${active ? "border-indigo-400/60 bg-indigo-500/30 text-white" : "border-white/10 text-gray-300 hover:bg-white/5"} disabled:opacity-30 disabled:cursor-not-allowed`}
                    >
                        {moodLabel(m.mood)}{" "}
                        <span className="tabular-nums text-gray-400">
                            {m.trackCount}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

function JourneySubmission({ view }: { view: JourneyView }) {
    return (
        <>
            <label className="flex items-center gap-2 mb-3 text-xs text-gray-300">
                <span className="w-10">{vibeMapRu.journey.steps}</span>
                <input
                    type="range"
                    min={4}
                    max={16}
                    step={1}
                    value={view.steps}
                    aria-label={vibeMapRu.journey.stepsAria}
                    onChange={(e) =>
                        view.setSteps(parseInt(e.target.value, 10))
                    }
                    className="flex-1 h-1.5 accent-indigo-400"
                />
                <span className="tabular-nums text-gray-400 w-4">
                    {view.steps}
                </span>
            </label>
            <button
                type="button"
                onClick={view.submit}
                disabled={!view.canSubmit || view.loading}
                className="w-full min-h-[40px] mb-3 flex items-center justify-center gap-2 px-2 py-2 rounded-lg bg-indigo-500/80 hover:bg-indigo-500 text-white text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 disabled:opacity-30 disabled:cursor-not-allowed"
            >
                {view.loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                    <Route className="w-4 h-4" />
                )}
                {vibeMapRu.journey.build}
            </button>
            {view.error && (
                <p className="text-xs text-red-400 mb-2">{view.error}</p>
            )}
        </>
    );
}

function RouteActions({ view }: { view: JourneyView }) {
    return (
        <div className="flex items-center">
            <button
                type="button"
                onClick={view.play}
                className="inline-flex items-center gap-1 min-h-[36px] px-2 rounded-lg text-xs text-indigo-300 hover:text-white hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
            >
                <Play className="w-3.5 h-3.5" /> {vibeMapRu.journey.play}
            </button>
            <button
                type="button"
                onClick={view.save}
                disabled={view.saving}
                title={vibeMapRu.journey.saveTitle}
                aria-label={vibeMapRu.journey.saveTitle}
                className="inline-flex items-center gap-1 min-h-[36px] px-2 rounded-lg text-xs text-indigo-300 hover:text-white hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 disabled:opacity-30 disabled:cursor-not-allowed"
            >
                {view.saving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                    <ListPlus className="w-3.5 h-3.5" />
                )}
                {vibeMapRu.journey.save}
            </button>
        </div>
    );
}

function JourneyRoute({ view }: { view: JourneyView }) {
    if (view.waypoints.length === 0) return null;
    return (
        <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
                <p className="text-xs uppercase tracking-wide text-gray-400">
                    {view.targetLabel
                        ? `${vibeMapRu.journey.routeTo} ${view.targetLabel}`
                        : vibeMapRu.journey.route}
                </p>
                <RouteActions view={view} />
            </div>
            <ol className="flex flex-col">
                {view.waypoints.map((w) => (
                    <li key={`${w.id}-${w.seq}`}>
                        <VibeTrackRow
                            title={w.title}
                            artistName={w.artist.name}
                            onMap={w.onMap}
                            distance={w.distance}
                            quantiles={view.quantiles}
                            accentClass="text-indigo-300/80"
                            seq={w.seq}
                        />
                    </li>
                ))}
            </ol>
        </div>
    );
}

function DriftChoices({ view }: { view: JourneyView }) {
    const choices = view.moods.filter((m) => m.trackCount >= MIN_MOOD_TRACKS);
    if (choices.length === 0) return null;
    return (
        <div className="border-t border-white/10 pt-2">
            <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                {vibeMapRu.journey.drift}
            </p>
            <div className="flex flex-wrap gap-1.5">
                {choices.map((m) => (
                    <button
                        key={m.mood}
                        type="button"
                        onClick={() => view.drift(m.mood)}
                        title={`${vibeMapRu.journey.drift} ${moodLabel(m.mood)} · 12`}
                        className="inline-flex items-center min-h-[36px] px-3 py-1.5 rounded-full border border-white/10 text-xs text-gray-300 hover:bg-white/5 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                    >
                        {moodLabel(m.mood)}
                    </button>
                ))}
            </div>
        </div>
    );
}

export function JourneyPanel({ view }: { view: JourneyView }) {
    return (
        <div
            className={VIBE_PANEL_CLASS}
            style={VIBE_PANEL_STYLE}
            data-vibe-panel="journey"
        >
            <JourneyHeader fromLabel={view.fromLabel} close={view.close} />
            <DestinationPicker view={view} />
            <MoodChoices view={view} />
            <JourneySubmission view={view} />
            <JourneyRoute view={view} />
            <DriftChoices view={view} />
        </div>
    );
}
