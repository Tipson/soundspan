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
            <div className="space-y-2">
                <p className="text-sm text-content-secondary">
                    {pasteInstruction}
                    <span className="ml-1 text-xs text-content-muted">
                        (код уже скопирован)
                    </span>
                </p>
                <div className="flex items-center gap-3">
                    <code className="select-all rounded-xl border border-line bg-surface-highlight px-4 py-2 font-mono text-lg font-bold tracking-wider text-content">
                        {userCode}
                    </code>
                    <button
                        onClick={onCopyCode}
                        type="button"
                        aria-label={
                            copied ? "Код скопирован" : "Скопировать код"
                        }
                        className="grid min-h-11 min-w-11 place-items-center rounded-xl text-content-muted transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
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
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-content-muted">
                <PanelIcon icon={Loader2} className="w-3 h-3 animate-spin" />
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
        <div className="space-y-4 rounded-2xl border border-line bg-surface-elevated p-4">
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
                    className="inline-flex min-h-11 items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-4 py-2 text-sm font-semibold text-brand-light transition-colors hover:bg-brand/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                >
                    <PanelIcon icon={ExternalLink} className="w-4 h-4" />
                    {props.openLinkLabel}
                </a>
            )}
            <WaitingRow timeLeftSeconds={props.timeLeftSeconds} />
            <button
                type="button"
                onClick={props.onCancel}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl px-3 text-xs font-semibold text-content-muted transition-colors hover:bg-white/[0.05] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
            >
                Отмена
            </button>
        </div>
    );
}
