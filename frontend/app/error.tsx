"use client";

import { useEffect } from "react";
import { SystemState } from "@/app/_components/SystemState";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { ru } from "@/lib/i18n/ru";

/**
 * Renders the Error component.
 */
export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        sharedFrontendLogger.error("Route error:", error);
    }, [error]);

    return (
        <SystemState
            kind="error"
            title={ru.errors.title}
            description="Страница не ответила как ожидалось. Повторите попытку — музыка и настройки останутся на месте."
            action={{ label: ru.common.tryAgain, onClick: reset }}
        />
    );
}
