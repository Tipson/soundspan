"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AuthConfig } from "@/lib/api/auth";
import { createFrontendLogger } from "@/lib/logger";
import { SettingsSection } from "../ui";
import { AppPasswordsPanel } from "./AppPasswordsPanel";
import { LinkedIdentitiesPanel } from "./LinkedIdentitiesPanel";

const logger = createFrontendLogger("Settings.SignInSecuritySection");

interface LinkNotice {
    kind: "success" | "error";
    message: string;
}

function getLinkErrorMessage(code: string): string {
    if (code === "identity_already_linked") {
        return "Эта учётная запись SSO уже связана с другим аккаунтом.";
    }
    return "Не удалось связать аккаунт SSO. Попробуйте ещё раз.";
}

function consumeLinkNotice(): LinkNotice | null {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get("ssoLinked");
    const error = params.get("ssoError");
    if (!linked && !error) return null;
    params.delete("ssoLinked");
    params.delete("ssoError");
    const query = params.toString();
    const cleanedUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", cleanedUrl);
    if (linked === "1") {
        return { kind: "success", message: "Аккаунт SSO подключён." };
    }
    return { kind: "error", message: getLinkErrorMessage(error ?? "") };
}

function LinkNoticeBanner({ notice }: { notice: LinkNotice }) {
    const success = notice.kind === "success";
    return (
        <p
            role={success ? "status" : "alert"}
            className={`rounded-lg border p-3 text-sm ${
                success
                    ? "border-green-500/30 bg-green-500/10 text-green-300"
                    : "border-red-500/30 bg-red-500/10 text-red-300"
            }`}
        >
            {notice.message}
        </p>
    );
}

/** Renders sign-in identity and OpenSubsonic app-password settings. */
export function SignInSecuritySection() {
    const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
    const [notice, setNotice] = useState<LinkNotice | null>(null);

    useEffect(() => {
        let active = true;
        queueMicrotask(() => {
            if (active) setNotice(consumeLinkNotice());
        });
        void api
            .getAuthConfig()
            .then((config) => {
                if (active) setAuthConfig(config);
            })
            .catch((error: unknown) => {
                logger.error("Failed to load auth capabilities", { error });
            });
        return () => {
            active = false;
        };
    }, []);

    return (
        <SettingsSection
            id="sign-in-security"
            title="Вход и безопасность"
            description="Способы входа и отдельные пароли для приложений"
        >
            {notice && <LinkNoticeBanner notice={notice} />}
            {authConfig?.oidcEnabled && (
                <LinkedIdentitiesPanel
                    providerName={authConfig.oidcProviderName}
                />
            )}
            <AppPasswordsPanel />
        </SettingsSection>
    );
}
