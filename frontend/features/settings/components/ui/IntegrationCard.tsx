"use client";

import { ReactNode } from "react";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";

interface IntegrationCardProps {
    icon: ReactNode;
    title: string;
    statusText: string;
    statusColor: "green" | "red" | "gray";
    connected: boolean;
    connectLabel?: string;
    disconnectLabel?: string;
    onConnect?: () => void;
    onDisconnect?: () => void;
    isLoading?: boolean;
    expanded: boolean;
    disabled?: boolean;
    disabledReason?: string;
    headerAction?: ReactNode;
    warning?: ReactNode;
    children?: ReactNode;
}

/**
 * Renders the IntegrationCard component.
 */
export function IntegrationCard({
    icon,
    title,
    statusText,
    statusColor,
    connected,
    connectLabel = "Подключить",
    disconnectLabel = "Отключить",
    onConnect,
    onDisconnect,
    isLoading = false,
    expanded,
    disabled = false,
    disabledReason,
    headerAction,
    warning,
    children,
}: IntegrationCardProps) {
    const statusIcon = isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-content-muted motion-reduce:animate-none" />
    ) : statusColor === "green" ? (
        <CheckCircle className="h-4 w-4 text-green-400" />
    ) : statusColor === "red" ? (
        <XCircle className="h-4 w-4 text-red-400" />
    ) : (
        <XCircle className="h-4 w-4 text-content-muted" />
    );

    return (
        <div
            className={`overflow-hidden rounded-2xl border border-line bg-surface-elevated/65 transition-opacity ${
                disabled ? "opacity-50" : ""
            }`}
        >
            {/* Header row */}
            <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                    {/* Icon */}
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-highlight">
                        {icon}
                    </div>

                    {/* Title + status */}
                    <div className="min-w-0">
                        <div className="text-sm font-semibold text-content">
                            {title}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            {statusIcon}
                            <span className="text-xs text-content-muted">
                                {disabled && disabledReason
                                    ? disabledReason
                                    : statusText}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Action area */}
                {headerAction
                    ? headerAction
                    : !disabled &&
                      (connected ? onDisconnect : onConnect) && (
                          <button
                              onClick={connected ? onDisconnect : onConnect}
                              disabled={isLoading}
                              className={`
                                inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-4 py-2 text-sm font-semibold transition-colors
                                ${isLoading ? "opacity-50 cursor-not-allowed" : ""}
                                ${
                                    connected
                                        ? "border border-line-muted bg-transparent text-content hover:border-white/30 hover:bg-white/[0.05]"
                                        : "bg-brand text-black hover:bg-brand-hover"
                                }
                            `}
                          >
                              {isLoading
                                  ? "..."
                                  : connected
                                    ? disconnectLabel
                                    : connectLabel}
                          </button>
                      )}
            </div>

            {/* Warning banner */}
            {warning && !disabled && <div className="px-4 pb-2">{warning}</div>}

            {/* Collapsible body */}
            <div
                className="grid transition-[grid-template-rows] duration-300 ease-in-out motion-reduce:transition-none"
                style={{
                    gridTemplateRows: expanded && !disabled ? "1fr" : "0fr",
                }}
            >
                <div className="overflow-hidden min-h-0">
                    {children && (
                        <div className="px-4 pb-4 pt-1">{children}</div>
                    )}
                </div>
            </div>
        </div>
    );
}
