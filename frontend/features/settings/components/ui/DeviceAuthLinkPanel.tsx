"use client";

import type { ReactNode } from "react";
import {
    CheckCircle,
    Copy,
    ExternalLink,
    Loader2,
    type LucideIcon,
} from "lucide-react";
import { formatTime } from "@/utils/formatTime";
import { SETTINGS_SECONDARY_BUTTON } from "./settingsFieldStyles";

/** Content and controls displayed by the shared device-code linking panel. */
export interface DeviceAuthLinkPanelProps {
    userCode: string;
    verificationUrl: string;
    timeLeftSeconds: number | null;
    copied: boolean;
    onCopyCode: () => void;
    onCancel: () => void;
    introText: string;
    pasteInstruction: string;
    signInInstruction: ReactNode;
    openLinkLabel: string;
}

interface NumberedStepProps {
    number: number;
    children: ReactNode;
}

function PanelIcon({
    icon: Icon,
    className,
}: {
    icon: LucideIcon;
    className: string;
}) {
    if (!Icon) return null;
    return <Icon className={className} />;
}

function NumberedStep({ number, children }: NumberedStepProps) {
    return (
        <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-black">
                {number}
            </span>
            {children}
        </div>
    );
}

function CodeStep({
    userCode,
    copied,
    onCopyCode,
    pasteInstruction,
}: Pick<
    DeviceAuthLinkPanelProps,
    "userCode" | "copied" | "onCopyCode" | "pasteInstruction"
>) {
    return (
        <NumberedStep number={1}>
            <div className="min-w-0 space-y-2">
                <p className="text-sm text-content-secondary">
                    {pasteInstruction}
                    {copied && (
                        <span className="ml-1 text-xs text-content-muted">
                            (код уже скопирован)
                        </span>
                    )}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                    <code className="select-all break-all rounded-[10px] border border-line bg-surface-highlight px-4 py-2 font-mono text-lg font-bold tracking-wider text-content">
                        {userCode}
                    </code>
                    <button
                        onClick={onCopyCode}
                        type="button"
                        aria-label={
                            copied ? "Код скопирован" : "Скопировать код"
                        }
                        className="grid min-h-11 min-w-11 place-items-center rounded-[10px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        title="Скопировать код"
                    >
                        {copied ? (
                            <PanelIcon
                                icon={CheckCircle}
                                className="w-4 h-4 text-green-400"
                            />
                        ) : (
                            <PanelIcon icon={Copy} className="w-4 h-4" />
                        )}
                    </button>
                </div>
            </div>
        </NumberedStep>
    );
}

function WaitingRow({
    timeLeftSeconds,
}: Pick<DeviceAuthLinkPanelProps, "timeLeftSeconds">) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-content-muted">
                <PanelIcon
                    icon={Loader2}
                    className="w-3 h-3 animate-spin motion-reduce:animate-none"
                />
                <span>Ожидаем завершения входа…</span>
            </div>
            {timeLeftSeconds !== null && (
                <span
                    className={`text-xs tabular-nums ${
                        timeLeftSeconds < 120
                            ? "text-amber-400/70"
                            : "text-content-muted"
                    }`}
                >
                    Истекает через {formatTime(timeLeftSeconds)}
                </span>
            )}
        </div>
    );
}

/** Renders reusable instructions and controls for a device-code authentication session. */
export function DeviceAuthLinkPanel(props: DeviceAuthLinkPanelProps) {
    return (
        <div className="min-w-0 space-y-4 border-t border-line pt-4">
            <div className="space-y-3">
                <p className="text-sm text-content-secondary">
                    {props.introText}
                </p>
                <CodeStep {...props} />
                <NumberedStep number={2}>
                    <p className="text-sm text-content-secondary">
                        {props.signInInstruction}
                    </p>
                </NumberedStep>
                <NumberedStep number={3}>
                    <p className="text-sm text-content-secondary">
                        Вернитесь сюда — страница обновится автоматически
                    </p>
                </NumberedStep>
            </div>
            {props.verificationUrl && (
                <a
                    href={props.verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={SETTINGS_SECONDARY_BUTTON}
                >
                    <PanelIcon icon={ExternalLink} className="w-4 h-4" />
                    {props.openLinkLabel}
                </a>
            )}
            <WaitingRow timeLeftSeconds={props.timeLeftSeconds} />
            <button
                type="button"
                onClick={props.onCancel}
                className={SETTINGS_SECONDARY_BUTTON}
            >
                Отмена
            </button>
        </div>
    );
}
