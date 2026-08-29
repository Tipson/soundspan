"use client";

import { SettingsSection } from "../ui";
import { SystemSettings } from "../../types";
import { LidarrCard } from "./LidarrSection";
import { SoulseekCard } from "./SoulseekSection";
import { TidalCard } from "./TidalSection";

interface DownloadServicesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (
        service: string,
    ) => Promise<{ success: boolean; version?: string; error?: string }>;
    testingServices: Record<string, boolean>;
}

/**
 * Renders the DownloadServicesSection component.
 */
export function DownloadServicesSection({
    settings,
    onUpdate,
    onTest,
    testingServices,
}: DownloadServicesSectionProps) {
    return (
        <SettingsSection
            id="download-services"
            title="Additional Server Download Services"
            description="Optional extra sources for permanent server copies"
        >
            <div className="space-y-3">
                <div className="mx-4 rounded-lg border border-blue-500/25 bg-blue-500/10 px-3 py-2 text-xs text-blue-100/80">
                    YouTube Music already provides worldwide search and
                    streaming and can also save full albums when you explicitly
                    request a permanent server copy. The services below are
                    optional and are not required for playlist import or offline
                    downloads on your phone.
                </div>
                <LidarrCard
                    settings={settings}
                    onUpdate={onUpdate}
                    onTest={onTest}
                    isTesting={testingServices.lidarr || false}
                />
                <SoulseekCard
                    settings={settings}
                    onUpdate={onUpdate}
                    onTest={onTest}
                    isTesting={testingServices.slskd || false}
                />
                <TidalCard
                    settings={settings}
                    onUpdate={onUpdate}
                    onTest={onTest}
                    isTesting={testingServices.tidal || false}
                />
            </div>
        </SettingsSection>
    );
}
