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
            className="settings-section-card min-w-0 scroll-mt-40 rounded-[14px] border border-line bg-surface-raised"
        >
            <div className="mb-5 md:mb-6">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
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

            <div className="space-y-1">{children}</div>

            {showSeparator && <div className="mt-5 h-px bg-line md:hidden" />}
        </section>
    );
}
