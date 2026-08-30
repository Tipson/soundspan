"use client";

/** Accessible map-view control stack and its trail/about popovers. */

import {
    Brush,
    Crosshair,
    Footprints,
    HelpCircle,
    ListMusic,
    ListPlus,
    Loader2,
    Maximize2,
    Minimize2,
    Network,
    RotateCcw,
    Route,
    Shuffle,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import { Fragment } from "react";
import { vibeMapRu } from "@/lib/i18n/vibeMapRu";
import {
    FILTERABLE_MOODS,
    VIBE_ACCENTS,
    getMoodColor,
    moodLabel,
} from "./types";

export type LayoutMode = "natural" | "spread";
/** Trail visibility policy. */
export type TrailMode = "on" | "fade" | "off";

const TRAIL_MODE_OPTIONS: readonly { mode: TrailMode; label: string }[] = [
    { mode: "on", label: vibeMapRu.trailModes.on },
    { mode: "fade", label: vibeMapRu.trailModes.fade },
    { mode: "off", label: vibeMapRu.trailModes.off },
];

export interface ViewControlsProps {
    onZoomIn: () => void;
    onZoomOut: () => void;
    onReset: () => void;
    layoutMode: LayoutMode;
    layoutDisabled?: boolean;
    onToggleLayout: () => void;
    brushArmed: boolean;
    onToggleBrush: () => void;
    canLocate: boolean;
    locateHint: string;
    onLocate: () => void;
    canStartJourney: boolean;
    journeyHint: string;
    onStartJourney: () => void;
    queueOpen: boolean;
    onToggleQueue: () => void;
    queueCount: number;
    trailMode: TrailMode;
    onSetTrailMode: (mode: TrailMode) => void;
    trailPopoverOpen: boolean;
    onToggleTrailPopover: () => void;
    trailEmpty: boolean;
    onClearTrail: () => void;
    onSaveTrail: () => void;
    trailSaving?: boolean;
    aboutPopoverOpen: boolean;
    onToggleAboutPopover: () => void;
    isFullscreen: boolean;
    onToggleFullscreen: () => void;
}

const BTN =
    "vibe-ctrl-btn flex items-center justify-center w-10 h-10 rounded-lg " +
    "text-gray-300 hover:text-white hover:bg-white/10 transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 " +
    "disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-300";
const POPOVER_CLASS =
    "absolute right-full top-0 mr-2 p-2 flex flex-col gap-2 z-50 " +
    "bg-black/60 backdrop-blur-md border border-white/10 rounded-xl shadow-lg";
const CONTROL_STYLES = (
    <style>{`@media (pointer: coarse) {
        .vibe-ctrl-btn { min-width: 44px; min-height: 44px; }
    }`}</style>
);

function MoodLegend() {
    return (
        <div className="flex flex-wrap gap-1.5">
            {FILTERABLE_MOODS.map((mood) => (
                <span
                    key={mood}
                    className="inline-flex items-center gap-1.5 text-xs text-gray-300"
                >
                    <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: getMoodColor(mood) }}
                    />
                    {moodLabel(mood)}
                </span>
            ))}
        </div>
    );
}

function GlyphLegend() {
    return (
        <ul className="flex flex-col gap-1.5 text-xs text-gray-300">
            <li className="flex items-center gap-2">
                <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{
                        backgroundColor: VIBE_ACCENTS.edge,
                        boxShadow: `0 0 4px 1px ${VIBE_ACCENTS.edge}`,
                    }}
                />
                {vibeMapRu.legend.beacon}
            </li>
            <li className="flex items-center gap-2">
                <span
                    className="w-4 h-0 shrink-0 border-t-2"
                    style={{ borderColor: VIBE_ACCENTS.trail }}
                />
                {vibeMapRu.legend.trail}
            </li>
            <li className="flex items-center gap-2">
                <span
                    className="w-4 h-0 shrink-0 border-t-2 border-dashed"
                    style={{ borderColor: VIBE_ACCENTS.plan }}
                />
                {vibeMapRu.legend.plan}
            </li>
        </ul>
    );
}

function GestureCheatSheet() {
    const gestures: Array<[string, string]> = [
        [vibeMapRu.gestures.click, vibeMapRu.gestures.travel],
        [vibeMapRu.gestures.shiftDrag, vibeMapRu.gestures.sweep],
        [vibeMapRu.gestures.ctrlClick, vibeMapRu.gestures.alchemy],
        [vibeMapRu.gestures.wheelPinch, vibeMapRu.gestures.zoom],
        ["Esc", vibeMapRu.gestures.back],
    ];
    return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
            {gestures.map(([gesture, action]) => (
                <Fragment key={gesture}>
                    <dt className="text-gray-400">{gesture}</dt>
                    <dd className="text-gray-300">{action}</dd>
                </Fragment>
            ))}
        </dl>
    );
}

/** Legend and gesture reference shown from the view-control stack. */
export function AboutMapPopover() {
    return (
        <div
            role="dialog"
            aria-label={vibeMapRu.legend.about}
            className={`${POPOVER_CLASS} w-72 max-h-[70vh] overflow-y-auto`}
        >
            <p className="text-xs text-gray-300 leading-relaxed">
                {vibeMapRu.legend.descriptionStart}{" "}
                <strong className="text-white">
                    {vibeMapRu.legend.descriptionStrong}
                </strong>
                {vibeMapRu.legend.descriptionEnd}
            </p>
            <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                    {vibeMapRu.legend.moodColors}
                </p>
                <MoodLegend />
            </div>
            <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                    {vibeMapRu.legend.linesAndGlyphs}
                </p>
                <GlyphLegend />
            </div>
            <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                    {vibeMapRu.legend.gestures}
                </p>
                <GestureCheatSheet />
            </div>
        </div>
    );
}

function ZoomControls({ props }: { props: ViewControlsProps }) {
    return (
        <>
            <button
                type="button"
                onClick={props.onZoomIn}
                className={BTN}
                title={vibeMapRu.controls.zoomIn}
                aria-label={vibeMapRu.controls.zoomIn}
            >
                <ZoomIn className="w-5 h-5" />
            </button>
            <button
                type="button"
                onClick={props.onZoomOut}
                className={BTN}
                title={vibeMapRu.controls.zoomOut}
                aria-label={vibeMapRu.controls.zoomOut}
            >
                <ZoomOut className="w-5 h-5" />
            </button>
            <button
                type="button"
                onClick={props.onReset}
                className={BTN}
                title={vibeMapRu.controls.resetView}
                aria-label={vibeMapRu.controls.resetView}
            >
                <RotateCcw className="w-5 h-5" />
            </button>
        </>
    );
}

function MapActionControls({ props }: { props: ViewControlsProps }) {
    const spread = props.layoutMode === "spread";
    const locateClass = props.canLocate
        ? "vibe-ctrl-btn flex items-center justify-center w-10 h-10 rounded-lg text-indigo-300 bg-indigo-500/15 hover:text-white hover:bg-indigo-500/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
        : BTN;
    return (
        <>
            <button
                type="button"
                onClick={props.onToggleLayout}
                disabled={props.layoutDisabled}
                aria-pressed={spread}
                className={BTN}
                title={
                    spread
                        ? vibeMapRu.controls.cluster
                        : vibeMapRu.controls.spread
                }
                aria-label={
                    spread
                        ? vibeMapRu.controls.clusterLayout
                        : vibeMapRu.controls.spreadLayout
                }
            >
                {spread ? (
                    <Network className="w-5 h-5" />
                ) : (
                    <Shuffle className="w-5 h-5" />
                )}
            </button>
            <button
                type="button"
                onClick={props.onToggleBrush}
                aria-pressed={props.brushArmed}
                className={`${BTN} ${props.brushArmed ? "bg-indigo-500/30 text-white" : ""}`}
                title={
                    props.brushArmed
                        ? vibeMapRu.controls.brushArmed
                        : vibeMapRu.controls.brush
                }
                aria-label={vibeMapRu.controls.sweepBrush}
            >
                <Brush className="w-5 h-5" />
            </button>
            <button
                type="button"
                onClick={props.onLocate}
                disabled={!props.canLocate}
                className={locateClass}
                title={props.locateHint}
                aria-label={vibeMapRu.controls.locate}
            >
                <Crosshair className="w-5 h-5" />
            </button>
            <button
                type="button"
                onClick={props.onStartJourney}
                disabled={!props.canStartJourney}
                className={BTN}
                title={props.journeyHint}
                aria-label={vibeMapRu.controls.startJourney}
            >
                <Route className="w-5 h-5" />
            </button>
        </>
    );
}

function QueueControl({ props }: { props: ViewControlsProps }) {
    return (
        <div className="relative">
            <button
                type="button"
                onClick={props.onToggleQueue}
                aria-pressed={props.queueOpen}
                className={`${BTN} ${props.queueOpen ? "bg-white/10 text-white" : ""}`}
                title={vibeMapRu.controls.showQueue}
                aria-label={vibeMapRu.controls.showQueue}
            >
                <ListMusic className="w-5 h-5" />
            </button>
            {props.queueCount > 0 && (
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-indigo-500 text-white text-[10px] font-bold flex items-center justify-center leading-none"
                >
                    {props.queueCount > 99 ? "99+" : props.queueCount}
                </span>
            )}
        </div>
    );
}

function TrailPopover({ props }: { props: ViewControlsProps }) {
    return (
        <div
            role="menu"
            aria-label={vibeMapRu.controls.trailDisplay}
            className={`${POPOVER_CLASS} w-44`}
        >
            <div
                role="radiogroup"
                aria-label={vibeMapRu.controls.trailMode}
                className="flex rounded-lg overflow-hidden border border-white/10"
            >
                {TRAIL_MODE_OPTIONS.map(({ mode, label }) => (
                    <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={props.trailMode === mode}
                        onClick={() => props.onSetTrailMode(mode)}
                        className={`flex-1 py-1 text-xs transition-colors ${props.trailMode === mode ? "bg-indigo-500/40 text-white" : "text-gray-300 hover:bg-white/10"}`}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <button
                type="button"
                onClick={props.onClearTrail}
                disabled={props.trailEmpty}
                className="text-left px-2 py-1.5 rounded-lg text-xs text-gray-300 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
                {vibeMapRu.controls.clearHistory}
            </button>
            <button
                type="button"
                onClick={props.onSaveTrail}
                disabled={props.trailEmpty || props.trailSaving}
                className="flex items-center gap-1.5 text-left px-2 py-1.5 rounded-lg text-xs text-gray-300 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
                {props.trailSaving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                    <ListPlus className="w-3.5 h-3.5" />
                )}
                {vibeMapRu.controls.saveHistory}
            </button>
        </div>
    );
}

function TrailControl({ props }: { props: ViewControlsProps }) {
    return (
        <div className="relative">
            <button
                type="button"
                onClick={props.onToggleTrailPopover}
                aria-pressed={props.trailMode !== "off"}
                aria-expanded={props.trailPopoverOpen}
                className={`${BTN} ${props.trailPopoverOpen ? "bg-white/10 text-white" : ""}`}
                title={vibeMapRu.controls.trailSettings}
                aria-label={vibeMapRu.controls.trailSettings}
            >
                <Footprints className="w-5 h-5" />
            </button>
            {props.trailPopoverOpen && <TrailPopover props={props} />}
        </div>
    );
}

function AboutControl({ props }: { props: ViewControlsProps }) {
    return (
        <div className="relative">
            <button
                type="button"
                onClick={props.onToggleAboutPopover}
                aria-expanded={props.aboutPopoverOpen}
                className={`${BTN} ${props.aboutPopoverOpen ? "bg-white/10 text-white" : ""}`}
                title={vibeMapRu.legend.about}
                aria-label={vibeMapRu.legend.about}
            >
                <HelpCircle className="w-5 h-5" />
            </button>
            {props.aboutPopoverOpen && <AboutMapPopover />}
        </div>
    );
}

function FullscreenControl({ props }: { props: ViewControlsProps }) {
    return (
        <button
            type="button"
            onClick={props.onToggleFullscreen}
            aria-pressed={props.isFullscreen}
            className={BTN}
            title={
                props.isFullscreen
                    ? vibeMapRu.controls.exitFullscreenEsc
                    : vibeMapRu.controls.fullscreen
            }
            aria-label={
                props.isFullscreen
                    ? vibeMapRu.controls.exitFullscreen
                    : vibeMapRu.controls.enterFullscreen
            }
        >
            {props.isFullscreen ? (
                <Minimize2 className="w-5 h-5" />
            ) : (
                <Maximize2 className="w-5 h-5" />
            )}
        </button>
    );
}

/** Render the full map control stack. */
export function ViewControls(props: ViewControlsProps) {
    return (
        <div className="pointer-events-auto flex flex-col gap-1 p-1 bg-black/60 backdrop-blur-md border border-white/10 rounded-xl shadow-lg">
            <ZoomControls props={props} />
            <span className="mx-2 my-0.5 h-px bg-white/10" aria-hidden="true" />
            <MapActionControls props={props} />
            <QueueControl props={props} />
            <TrailControl props={props} />
            <AboutControl props={props} />
            <span className="mx-2 my-0.5 h-px bg-white/10" aria-hidden="true" />
            <FullscreenControl props={props} />
            {CONTROL_STYLES}
        </div>
    );
}
