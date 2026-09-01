import { ReactNode } from "react";
import Image from "next/image";

interface ConnectionCardProps {
    icon: string | ReactNode;
    title: string;
    description?: string;
    connected: boolean;
    connectedAs?: string;
    onConnect: () => void;
    onDisconnect: () => void;
    isLoading?: boolean;
}

/**
 * Renders the ConnectionCard component.
 */
export function ConnectionCard({
    icon,
    title,
    description,
    connected,
    connectedAs,
    onConnect,
    onDisconnect,
    isLoading,
}: ConnectionCardProps) {
    return (
        <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface-elevated/70 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
                {/* Icon */}
                <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-highlight">
                    {typeof icon === "string" ? (
                        <Image
                            src={icon}
                            alt={title}
                            width={24}
                            height={24}
                            sizes="24px"
                            className="w-6 h-6"
                        />
                    ) : (
                        icon
                    )}
                </div>

                {/* Text */}
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-content">
                        {title}
                    </div>
                    {connected && connectedAs ? (
                        <div className="mt-1 text-xs text-content-muted">
                            Подключено как{" "}
                            <span className="text-content">{connectedAs}</span>
                        </div>
                    ) : description ? (
                        <div className="mt-1 text-xs leading-5 text-content-muted">
                            {description}
                        </div>
                    ) : null}
                </div>
            </div>

            {/* Action Button */}
            <button
                onClick={connected ? onDisconnect : onConnect}
                disabled={isLoading}
                className={`
                    inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-4 py-2 text-sm font-semibold transition-colors
                    ${isLoading ? "opacity-50 cursor-not-allowed" : ""}
                    ${
                        connected
                            ? "border border-line-muted bg-transparent text-content hover:border-white/30 hover:bg-white/[0.05]"
                            : "bg-brand text-black hover:bg-brand-hover"
                    }
                `}
            >
                {isLoading ? "…" : connected ? "Отключить" : "Подключить"}
            </button>
        </div>
    );
}
