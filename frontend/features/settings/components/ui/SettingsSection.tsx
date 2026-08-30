import { ReactNode } from "react";

interface SettingsSectionProps {
    id: string;
    title: string;
    titleExtra?: ReactNode;
    description?: string;
    children: ReactNode;
    showSeparator?: boolean;
}

/**
 * Renders the SettingsSection component.
 */
export function SettingsSection({
    id,
    title,
    titleExtra,
    description,
    children,
    showSeparator = true,
}: SettingsSectionProps) {
    const titleId = `${id}-title`;

    return (
        <section
            id={id}
            data-settings-section="true"
            aria-labelledby={titleId}
            className="settings-section-card scroll-mt-28"
        >
            <div className="mb-5 md:mb-6">
                <div className="flex items-center gap-2">
                    <h2
                        id={titleId}
                        className="text-lg font-semibold tracking-[-0.02em] text-content md:text-xl"
                    >
                        {title}
                    </h2>
                    {titleExtra}
                </div>
                {description && (
                    <p className="mt-1.5 max-w-2xl text-sm leading-6 text-content-secondary">
                        {description}
                    </p>
                )}
            </div>

            <div className="space-y-1.5">{children}</div>

            {showSeparator && (
                <div className="mt-6 h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent md:hidden" />
            )}
        </section>
    );
}
