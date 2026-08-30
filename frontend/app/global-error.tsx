"use client";

import { useEffect } from "react";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { ru, userFacingError } from "@/lib/i18n/ru";

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
                <div className="flex h-screen items-center justify-center bg-black">
                    <div className="text-center">
                        <h2 className="text-2xl font-bold text-white mb-4">
                            {ru.errors.applicationTitle}
                        </h2>
                        <p className="text-gray-400 mb-6">
                            {userFacingError(error, ru.errors.critical)}
                        </p>
                        <button
                            onClick={reset}
                            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                        >
                            {ru.errors.reload}
                        </button>
                    </div>
                </div>
            </body>
        </html>
    );
}
