"use client";

import { useEffect } from "react";
import { SystemState } from "@/app/_components/SystemState";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { ru } from "@/lib/i18n/ru";

/**
 * Renders the GlobalError component.
 */
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        sharedFrontendLogger.error("Global error:", error);
    }, [error]);

    return (
        <html lang="ru">
            <body>
                <SystemState
                    kind="error"
                    title={ru.errors.applicationTitle}
                    description="Soundspan не смог продолжить работу. Перезапустите интерфейс — ваша медиатека и настройки не изменятся."
                    action={{ label: ru.errors.reload, onClick: reset }}
                />
            </body>
        </html>
    );
}
