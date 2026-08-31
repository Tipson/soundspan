import { GradientSpinner } from "./GradientSpinner";

interface LoadingScreenProps {
    message?: string;
}

/**
 * Renders the LoadingScreen component.
 */
export function LoadingScreen({ message = "Загрузка…" }: LoadingScreenProps) {
    return (
        <div className="flex min-h-screen items-center justify-center bg-surface">
            <div className="flex flex-col items-center gap-4">
                <GradientSpinner size="lg" />
                {message && (
                    <p className="text-sm font-medium text-content-muted">
                        {message}
                    </p>
                )}
            </div>
        </div>
    );
}
