"use client";

import { useState, useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useFeatures } from "@/lib/features-context";
import { useAuth } from "@/lib/auth-context";
import { revokeAuthenticatedRuntime } from "@/lib/auth-runtime";
import { BookOpen, Check, Minus, Music2, Search, Zap } from "lucide-react";
import { AuthPanel, AuthStage } from "@/features/auth/components/AuthStage";
import {
    formatOnboardingConnectionFailure,
    formatOnboardingConnectionSuccess,
    onboardingRu,
} from "@/lib/i18n/musicPagesRu";

/**
 * Renders the OnboardingPage component.
 */
export default function OnboardingPage() {
    const router = useRouter();
    const { user, isLoading: authLoading } = useAuth();
    const {
        musicCNN,
        vibeEmbeddings,
        loading: featuresLoading,
    } = useFeatures();
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [initialLoading, setInitialLoading] = useState(true);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const hasCheckedSession = useRef(false);
    const showPasswordMismatch = error === onboardingRu.passwordMismatch;
    const showPasswordTooShort = error === onboardingRu.passwordTooShort;

    // Step 1: Account creation
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");

    // Guard: redirect away if onboarding is not needed (users already exist)
    useEffect(() => {
        let cancelled = false;
        async function checkOnboarding() {
            try {
                const data = await api.getOnboardingStatus();
                if (!cancelled && !data.needsOnboarding) {
                    router.replace("/login");
                }
            } catch {
                // Ignore — fail open so first-time setup still works
            }
        }
        checkOnboarding();
        return () => {
            cancelled = true;
        };
    }, [router]);

    // Use auth context state instead of duplicate API call
    useEffect(() => {
        // Wait for auth context to finish loading
        if (authLoading) return;

        // Only check once to prevent re-renders
        if (hasCheckedSession.current) return;
        hasCheckedSession.current = true;

        // If user exists and hasn't completed onboarding, skip to step 2
        if (user && !user.onboardingComplete) {
            setStep(2);
        }
        setInitialLoading(false);
    }, [authLoading, user]);

    // Step 2: Integrations
    const [lidarr, setLidarr] = useState({
        url: "",
        apiKey: "",
        enabled: false,
    });
    const [audiobookshelf, setAudiobookshelf] = useState({
        url: "",
        apiKey: "",
        enabled: false,
    });
    const [soulseek, setSoulseek] = useState({
        username: "",
        password: "",
        enabled: false,
    });

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setSuccess("");

        if (password !== confirmPassword) {
            setError(onboardingRu.passwordMismatch);
            return;
        }

        if (password.length < 6) {
            setError(onboardingRu.passwordTooShort);
            return;
        }

        setLoading(true);
        try {
            const sessionGeneration = api.getSessionGeneration();
            const response = await api.post<{
                token: string;
                user: { id: string; username: string };
            }>("/onboarding/register", { username, password });
            if (api.getSessionGeneration() !== sessionGeneration) return;
            // Store the JWT token for subsequent API calls
            if (response.token) {
                revokeAuthenticatedRuntime();
                api.setToken(response.token);
            }
            setStep(2);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            // Check if user already exists
            if (message?.includes("already taken")) {
                setError(onboardingRu.usernameTaken);
            } else {
                setError(onboardingRu.accountCreationFailed);
            }
        } finally {
            setLoading(false);
        }
    };

    const testConnection = async (
        type: "lidarr" | "audiobookshelf" | "soulseek",
    ) => {
        setError("");
        setSuccess("");
        setLoading(true);

        try {
            if (type === "lidarr") {
                if (!lidarr.url || !lidarr.apiKey) {
                    throw new Error(onboardingRu.urlApiRequired);
                }
                await api.post("/system-settings/test-lidarr", {
                    url: lidarr.url,
                    apiKey: lidarr.apiKey,
                });
            } else if (type === "audiobookshelf") {
                if (!audiobookshelf.url || !audiobookshelf.apiKey) {
                    throw new Error(onboardingRu.urlApiRequired);
                }
                await api.post("/system-settings/test-audiobookshelf", {
                    url: audiobookshelf.url,
                    apiKey: audiobookshelf.apiKey,
                });
            } else if (type === "soulseek") {
                if (!soulseek.username || !soulseek.password) {
                    throw new Error(onboardingRu.soulseekCredentialsRequired);
                }
                await api.post("/system-settings/test-soulseek", {
                    username: soulseek.username,
                    password: soulseek.password,
                });
            }
            setSuccess(formatOnboardingConnectionSuccess(type));
        } catch (err: unknown) {
            const errorMessage =
                err instanceof Error &&
                (err.message === onboardingRu.urlApiRequired ||
                    err.message === onboardingRu.soulseekCredentialsRequired)
                    ? err.message
                    : formatOnboardingConnectionFailure(type);
            setError(errorMessage);
        } finally {
            setLoading(false);
        }
    };

    const handleNextStep = async () => {
        setError("");
        setSuccess("");
        setLoading(true);

        try {
            if (step === 2) {
                // Save all integration configs
                await Promise.all([
                    api.post("/onboarding/lidarr", lidarr),
                    api.post("/onboarding/audiobookshelf", audiobookshelf),
                    api.post("/onboarding/soulseek", soulseek),
                ]);
                setStep(3);
            } else if (step === 3) {
                await api.post("/onboarding/complete");
                router.push("/sync");
            }
        } catch {
            setError(onboardingRu.configurationSaveFailed);
        } finally {
            setLoading(false);
        }
    };

    return (
        <AuthStage width="wide">
            {/* Show loading spinner while checking session */}
            {initialLoading ? (
                <div className="flex items-center justify-center py-20">
                    <div className="text-center">
                        <GradientSpinner size="lg" />
                        <p
                            className="mt-4 text-content-secondary"
                            role="status"
                        >
                            {onboardingRu.loading}
                        </p>
                    </div>
                </div>
            ) : (
                <div className="w-full">
                    <header className="mb-7 text-center">
                        <p className="text-[0.68rem] font-bold uppercase tracking-[0.18em] text-brand-light">
                            Первичная настройка
                        </p>
                        <h1 className="mt-2 text-2xl font-black tracking-[-0.035em] text-content sm:text-3xl">
                            {onboardingRu.welcome}
                        </h1>
                    </header>

                    {/* Progress Steps */}
                    <div
                        className="mb-7 flex items-start justify-center gap-1 sm:gap-3"
                        aria-label="Шаги первичной настройки"
                    >
                        {[
                            { num: 1, label: onboardingRu.stepAccount },
                            {
                                num: 2,
                                label: onboardingRu.stepIntegrations,
                            },
                            {
                                num: 3,
                                label: onboardingRu.stepEnrichment,
                            },
                        ].map((s, idx) => (
                            <div
                                key={s.num}
                                className="flex min-w-0 items-center"
                                aria-current={
                                    s.num === step ? "step" : undefined
                                }
                            >
                                <div className="flex flex-col items-center">
                                    <div
                                        className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold transition-colors ${
                                            s.num === step
                                                ? "bg-brand text-black shadow-lg shadow-brand/20"
                                                : s.num < step
                                                  ? "border border-line bg-white/[0.05] text-content-secondary"
                                                  : "border border-line bg-white/[0.03] text-content-muted"
                                        }`}
                                    >
                                        {s.num}
                                    </div>
                                    <span
                                        className={`mt-2 max-w-20 text-center text-[0.68rem] leading-4 transition-colors sm:max-w-none sm:text-xs ${
                                            s.num === step
                                                ? "text-brand font-medium"
                                                : "text-content-muted"
                                        }`}
                                    >
                                        {s.label}
                                    </span>
                                </div>
                                {idx < 2 && (
                                    <div
                                        className={`mx-1.5 mt-4 h-0.5 w-6 transition-colors sm:mx-4 sm:w-16 ${
                                            s.num < step
                                                ? "bg-brand/25"
                                                : "bg-white/10"
                                        }`}
                                    />
                                )}
                            </div>
                        ))}
                    </div>

                    {/* Main Content Card */}
                    <AuthPanel className="overflow-hidden">
                        <div>
                            {step === 1 && (
                                <div className="space-y-6">
                                    <div>
                                        <h2 className="mb-1 text-2xl font-black tracking-[-0.03em] text-content">
                                            {onboardingRu.createAccount}
                                        </h2>
                                        <p className="text-sm leading-6 text-content-secondary">
                                            {
                                                onboardingRu.createAccountDescription
                                            }
                                        </p>
                                    </div>

                                    <form
                                        onSubmit={handleRegister}
                                        className="space-y-4 mt-8"
                                    >
                                        <div>
                                            <label
                                                htmlFor="onboarding-username"
                                                className="mb-1.5 block text-sm font-medium text-content"
                                            >
                                                {onboardingRu.username}
                                            </label>
                                            <input
                                                id="onboarding-username"
                                                name="username"
                                                type="text"
                                                value={username}
                                                onChange={(e) =>
                                                    setUsername(e.target.value)
                                                }
                                                className="min-h-12 w-full rounded-2xl border border-line bg-surface-elevated px-4 py-3 text-base text-content outline-none transition-colors placeholder:text-content-muted hover:border-line-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                                                placeholder={
                                                    onboardingRu.usernamePlaceholder
                                                }
                                                required
                                                minLength={3}
                                                autoComplete="username"
                                                autoCapitalize="none"
                                                autoCorrect="off"
                                            />
                                        </div>

                                        <div>
                                            <label
                                                htmlFor="onboarding-password"
                                                className="mb-1.5 block text-sm font-medium text-content"
                                            >
                                                {onboardingRu.password}
                                            </label>
                                            <input
                                                id="onboarding-password"
                                                name="password"
                                                type="password"
                                                value={password}
                                                onChange={(e) =>
                                                    setPassword(e.target.value)
                                                }
                                                className={`min-h-12 w-full rounded-2xl border bg-surface-elevated px-4 py-3 text-base text-content outline-none transition-colors placeholder:text-content-muted focus:ring-2 focus:ring-brand/20 sm:text-sm ${
                                                    showPasswordTooShort
                                                        ? "border-red-500/50"
                                                        : "border-line hover:border-line-muted focus:border-brand/60"
                                                }`}
                                                placeholder={
                                                    onboardingRu.passwordPlaceholder
                                                }
                                                required
                                                minLength={6}
                                                autoComplete="new-password"
                                            />
                                        </div>

                                        <div>
                                            <label
                                                htmlFor="onboarding-confirm-password"
                                                className="mb-1.5 block text-sm font-medium text-content"
                                            >
                                                {onboardingRu.confirmPassword}
                                            </label>
                                            <input
                                                id="onboarding-confirm-password"
                                                name="confirmPassword"
                                                type="password"
                                                value={confirmPassword}
                                                onChange={(e) =>
                                                    setConfirmPassword(
                                                        e.target.value,
                                                    )
                                                }
                                                className={`min-h-12 w-full rounded-2xl border bg-surface-elevated px-4 py-3 text-base text-content outline-none transition-colors placeholder:text-content-muted focus:ring-2 focus:ring-brand/20 sm:text-sm ${
                                                    showPasswordMismatch
                                                        ? "border-red-500/50"
                                                        : "border-line hover:border-line-muted focus:border-brand/60"
                                                }`}
                                                placeholder={
                                                    onboardingRu.confirmPasswordPlaceholder
                                                }
                                                required
                                                minLength={6}
                                                autoComplete="new-password"
                                            />
                                        </div>

                                        {error && (
                                            <div
                                                role="alert"
                                                className="rounded-2xl border border-red-400/25 bg-red-500/10 p-4 text-sm leading-5 text-red-200"
                                            >
                                                {error}
                                            </div>
                                        )}

                                        <button
                                            type="submit"
                                            disabled={loading}
                                            className="mt-8 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-brand px-5 py-3 text-sm font-black text-black transition-[transform,background-color] active:scale-[0.98] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                                        >
                                            <span className="relative z-10 flex items-center justify-center gap-2">
                                                {loading ? (
                                                    <>
                                                        <GradientSpinner size="sm" />
                                                        {
                                                            onboardingRu.creatingAccount
                                                        }
                                                    </>
                                                ) : (
                                                    onboardingRu.continue
                                                )}
                                            </span>
                                        </button>
                                    </form>
                                </div>
                            )}

                            {step === 2 && (
                                <div className="space-y-6">
                                    <div>
                                        <h2 className="mb-1 text-2xl font-black tracking-[-0.03em] text-content">
                                            {onboardingRu.connectServices}
                                        </h2>
                                        <p className="text-sm leading-6 text-content-secondary">
                                            {
                                                onboardingRu.connectServicesDescription
                                            }
                                        </p>
                                    </div>

                                    <div className="space-y-4 mt-8">
                                        {/* Lidarr */}
                                        <IntegrationCard
                                            title={onboardingRu.lidarr}
                                            description={
                                                onboardingRu.lidarrDescription
                                            }
                                            localPort="localhost:8686"
                                            icon={
                                                <Music2
                                                    className="h-6 w-6"
                                                    aria-hidden="true"
                                                />
                                            }
                                            enabled={lidarr.enabled}
                                            onToggle={() =>
                                                setLidarr({
                                                    ...lidarr,
                                                    enabled: !lidarr.enabled,
                                                })
                                            }
                                            url={lidarr.url}
                                            apiKey={lidarr.apiKey}
                                            onUrlChange={(url) =>
                                                setLidarr({
                                                    ...lidarr,
                                                    url,
                                                })
                                            }
                                            onApiKeyChange={(apiKey) =>
                                                setLidarr({
                                                    ...lidarr,
                                                    apiKey,
                                                })
                                            }
                                            onTest={() =>
                                                testConnection("lidarr")
                                            }
                                            loading={loading}
                                        />

                                        {/* Audiobookshelf */}
                                        <IntegrationCard
                                            title={onboardingRu.audiobookshelf}
                                            description={
                                                onboardingRu.audiobookshelfDescription
                                            }
                                            localPort="localhost:13378"
                                            icon={
                                                <BookOpen
                                                    className="h-6 w-6"
                                                    aria-hidden="true"
                                                />
                                            }
                                            enabled={audiobookshelf.enabled}
                                            onToggle={() =>
                                                setAudiobookshelf({
                                                    ...audiobookshelf,
                                                    enabled:
                                                        !audiobookshelf.enabled,
                                                })
                                            }
                                            url={audiobookshelf.url}
                                            apiKey={audiobookshelf.apiKey}
                                            onUrlChange={(url) =>
                                                setAudiobookshelf({
                                                    ...audiobookshelf,
                                                    url,
                                                })
                                            }
                                            onApiKeyChange={(apiKey) =>
                                                setAudiobookshelf({
                                                    ...audiobookshelf,
                                                    apiKey,
                                                })
                                            }
                                            onTest={() =>
                                                testConnection("audiobookshelf")
                                            }
                                            loading={loading}
                                        />

                                        {/* Soulseek */}
                                        <SoulseekCard
                                            enabled={soulseek.enabled}
                                            onToggle={() =>
                                                setSoulseek({
                                                    ...soulseek,
                                                    enabled: !soulseek.enabled,
                                                })
                                            }
                                            username={soulseek.username}
                                            password={soulseek.password}
                                            onUsernameChange={(username) =>
                                                setSoulseek({
                                                    ...soulseek,
                                                    username,
                                                })
                                            }
                                            onPasswordChange={(password) =>
                                                setSoulseek({
                                                    ...soulseek,
                                                    password,
                                                })
                                            }
                                            onTest={() =>
                                                testConnection("soulseek")
                                            }
                                            loading={loading}
                                        />
                                    </div>

                                    {success && (
                                        <div
                                            role="status"
                                            className="flex items-center gap-2 rounded-2xl border border-green-500/20 bg-green-500/10 p-4"
                                        >
                                            <p className="text-sm text-green-500">
                                                {success}
                                            </p>
                                        </div>
                                    )}

                                    {error && (
                                        <div
                                            role="alert"
                                            className="flex items-center gap-2 rounded-2xl border border-red-500/20 bg-red-500/10 p-4"
                                        >
                                            <p className="text-sm text-red-500">
                                                {error}
                                            </p>
                                        </div>
                                    )}

                                    <div className="flex gap-3 mt-8">
                                        <button
                                            type="button"
                                            onClick={() => setStep(3)}
                                            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-full border border-line bg-white/[0.04] px-4 py-3 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.09] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                                        >
                                            {onboardingRu.skipForNow}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleNextStep}
                                            disabled={loading}
                                            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-full bg-brand px-4 py-3 text-sm font-black text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-50"
                                        >
                                            {loading
                                                ? onboardingRu.saving
                                                : onboardingRu.continue}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {step === 3 && (
                                <div className="space-y-6">
                                    <div>
                                        <h2 className="mb-1 text-2xl font-black tracking-[-0.03em] text-content">
                                            {onboardingRu.analysisFeatures}
                                        </h2>
                                        <p className="text-sm leading-6 text-content-secondary">
                                            {
                                                onboardingRu.analysisFeaturesDescription
                                            }
                                        </p>
                                    </div>

                                    <div className="mt-8 rounded-2xl border border-line bg-surface-elevated/65 p-5 sm:p-6">
                                        <h3 className="mb-4 text-lg font-semibold text-content">
                                            {
                                                onboardingRu.detectedAnalysisFeatures
                                            }
                                        </h3>

                                        {featuresLoading ? (
                                            <div className="flex items-center gap-3 text-content-muted">
                                                <GradientSpinner size="sm" />
                                                <span>
                                                    {
                                                        onboardingRu.detectingFeatures
                                                    }
                                                </span>
                                            </div>
                                        ) : (
                                            <div className="space-y-4">
                                                <div
                                                    className={`p-4 rounded-lg border ${musicCNN ? "bg-green-500/5 border-green-500/20" : "bg-white/5 border-white/10"}`}
                                                >
                                                    <div className="flex items-center gap-3 mb-2">
                                                        <span
                                                            className={
                                                                musicCNN
                                                                    ? "text-green-400"
                                                                    : "text-content-muted"
                                                            }
                                                        >
                                                            {musicCNN ? (
                                                                <Check
                                                                    className="h-4 w-4"
                                                                    aria-hidden="true"
                                                                />
                                                            ) : (
                                                                <Minus
                                                                    className="h-4 w-4"
                                                                    aria-hidden="true"
                                                                />
                                                            )}
                                                        </span>
                                                        <span className="font-medium text-content">
                                                            {
                                                                onboardingRu.musicCnnTitle
                                                            }
                                                        </span>
                                                    </div>
                                                    <p className="ml-7 text-sm text-content-muted">
                                                        {
                                                            onboardingRu.musicCnnDescription
                                                        }
                                                    </p>
                                                </div>
                                                <div
                                                    className={`p-4 rounded-lg border ${vibeEmbeddings ? "bg-green-500/5 border-green-500/20" : "bg-white/5 border-white/10"}`}
                                                >
                                                    <div className="flex items-center gap-3 mb-2">
                                                        <span
                                                            className={
                                                                vibeEmbeddings
                                                                    ? "text-green-400"
                                                                    : "text-content-muted"
                                                            }
                                                        >
                                                            {vibeEmbeddings ? (
                                                                <Check
                                                                    className="h-4 w-4"
                                                                    aria-hidden="true"
                                                                />
                                                            ) : (
                                                                <Minus
                                                                    className="h-4 w-4"
                                                                    aria-hidden="true"
                                                                />
                                                            )}
                                                        </span>
                                                        <span className="font-medium text-content">
                                                            {
                                                                onboardingRu.clapTitle
                                                            }
                                                        </span>
                                                    </div>
                                                    <p className="ml-7 text-sm text-content-muted">
                                                        {
                                                            onboardingRu.clapDescription
                                                        }
                                                    </p>
                                                </div>
                                            </div>
                                        )}

                                        <div className="mt-6 pt-4 border-t border-white/10">
                                            <p className="text-sm leading-6 text-content-muted">
                                                {musicCNN || vibeEmbeddings ? (
                                                    <>
                                                        {
                                                            onboardingRu.analysisCapacityLead
                                                        }{" "}
                                                        Откройте{" "}
                                                        <a
                                                            href="https://github.com/soundspan/soundspan/blob/main/docs/DEPLOYMENT.md"
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-brand hover:underline"
                                                        >
                                                            {
                                                                onboardingRu.deploymentGuide
                                                            }
                                                        </a>{" "}
                                                        {
                                                            onboardingRu.analysisCapacityTail
                                                        }{" "}
                                                        <code className="rounded bg-surface-highlight px-1.5 py-0.5 text-xs text-content-secondary">
                                                            docker-compose.override.lite-mode.yml
                                                        </code>{" "}
                                                        {onboardingRu.copyTo}{" "}
                                                        <code className="rounded bg-surface-highlight px-1.5 py-0.5 text-xs text-content-secondary">
                                                            docker-compose.override.yml
                                                        </code>{" "}
                                                        {
                                                            onboardingRu.andRestart
                                                        }
                                                    </>
                                                ) : (
                                                    <>
                                                        {
                                                            onboardingRu.liteModeLead
                                                        }{" "}
                                                        <code className="rounded bg-surface-highlight px-1.5 py-0.5 text-xs text-content-secondary">
                                                            docker-compose.override.yml
                                                        </code>{" "}
                                                        {
                                                            onboardingRu.restartWith
                                                        }{" "}
                                                        <code className="rounded bg-surface-highlight px-1.5 py-0.5 text-xs text-content-secondary">
                                                            docker compose up -d
                                                        </code>
                                                        .
                                                    </>
                                                )}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="rounded-2xl border border-line bg-surface-elevated/65 p-5 sm:p-6">
                                        <div className="flex items-start gap-4">
                                            <div className="w-12 h-12 bg-brand/10 border border-brand/20 rounded-lg flex items-center justify-center flex-shrink-0">
                                                <Zap
                                                    className="h-6 w-6 text-brand"
                                                    aria-hidden="true"
                                                />
                                            </div>
                                            <div>
                                                <h3 className="mb-2 text-lg font-bold text-content">
                                                    {
                                                        onboardingRu.artistEnrichment
                                                    }
                                                </h3>
                                                <p className="text-sm leading-relaxed text-content-secondary">
                                                    {
                                                        onboardingRu.artistEnrichmentDescription
                                                    }
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    {error && (
                                        <div
                                            role="alert"
                                            className="flex items-center gap-2 rounded-2xl border border-red-500/20 bg-red-500/10 p-4"
                                        >
                                            <p className="text-red-500 text-sm">
                                                {error}
                                            </p>
                                        </div>
                                    )}

                                    <div className="flex gap-3 mt-8">
                                        <button
                                            type="button"
                                            onClick={() => setStep(2)}
                                            disabled={loading}
                                            className="inline-flex min-h-12 items-center justify-center rounded-full border border-line bg-white/[0.04] px-5 py-3 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.09] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-50"
                                        >
                                            Назад
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleNextStep}
                                            disabled={loading}
                                            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-full bg-brand px-5 py-3 text-sm font-black text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-50"
                                        >
                                            <span className="relative z-10 flex items-center justify-center gap-2">
                                                {loading ? (
                                                    <>
                                                        <GradientSpinner size="sm" />
                                                        {
                                                            onboardingRu.finishingSetup
                                                        }
                                                    </>
                                                ) : (
                                                    onboardingRu.completeSetup
                                                )}
                                            </span>
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </AuthPanel>
                </div>
            )}
        </AuthStage>
    );
}

interface IntegrationCardProps {
    title: string;
    description: string;
    localPort?: string;
    icon: React.ReactNode;
    enabled: boolean;
    onToggle: () => void;
    url: string;
    apiKey?: string;
    username?: string;
    password?: string;
    onUrlChange: (url: string) => void;
    onApiKeyChange?: (apiKey: string) => void;
    onUsernameChange?: (username: string) => void;
    onPasswordChange?: (password: string) => void;
    onTest: () => void;
    loading: boolean;
    useSoulseekCreds?: boolean;
}

function IntegrationCard({
    title,
    description,
    localPort,
    icon,
    enabled,
    onToggle,
    url,
    apiKey,
    username,
    password,
    onUrlChange,
    onApiKeyChange,
    onUsernameChange,
    onPasswordChange,
    onTest,
    loading,
    useSoulseekCreds = false,
}: IntegrationCardProps) {
    const fieldId = useId().replaceAll(":", "");
    const urlId = `${fieldId}-url`;
    const apiKeyId = `${fieldId}-api-key`;
    const usernameId = `${fieldId}-username`;
    const passwordId = `${fieldId}-password`;

    return (
        <div
            className={`rounded-2xl border transition-colors ${
                enabled
                    ? "bg-surface-raised border-brand/25"
                    : "border-line bg-white/[0.035]"
            }`}
        >
            <div className="p-4">
                <div className="flex items-start justify-between gap-3 sm:items-center">
                    <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                        <div
                            className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                                enabled
                                    ? "bg-brand/10 border border-brand/20 text-brand"
                                    : "border border-line bg-white/[0.04] text-content-muted"
                            }`}
                        >
                            {icon}
                        </div>
                        <div className="min-w-0">
                            <h3 className="font-bold text-content">{title}</h3>
                            <p className="text-sm leading-5 text-content-muted">
                                {description}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onToggle}
                        role="switch"
                        aria-checked={enabled}
                        aria-label={`${enabled ? "Отключить" : "Включить"} ${title}`}
                        className="grid min-h-11 min-w-11 place-items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                    >
                        <span
                            aria-hidden="true"
                            className={`relative h-6 w-11 rounded-full transition-colors ${
                                enabled ? "bg-brand" : "bg-white/20"
                            }`}
                        >
                            <span
                                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-lg transition-transform ${
                                    enabled ? "translate-x-5" : ""
                                }`}
                            />
                        </span>
                    </button>
                </div>

                {enabled && (
                    <div className="space-y-3 mt-4 pt-4 border-t border-white/10">
                        <div>
                            <label
                                htmlFor={urlId}
                                className="mb-1.5 block text-xs font-semibold text-content-secondary"
                            >
                                Адрес сервера
                            </label>
                            <input
                                id={urlId}
                                name={`${fieldId}-url`}
                                type="url"
                                value={url}
                                onChange={(e) => onUrlChange(e.target.value)}
                                placeholder={`${onboardingRu.serverUrlPlaceholder} (например, http://${
                                    localPort || "localhost:PORT"
                                })`}
                                autoComplete="url"
                                className="min-h-11 w-full rounded-xl border border-line bg-surface-elevated px-4 py-2.5 text-base text-content outline-none transition-colors placeholder:text-content-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                            />
                        </div>
                        {useSoulseekCreds ? (
                            <>
                                <label htmlFor={usernameId} className="sr-only">
                                    Имя пользователя Soulseek
                                </label>
                                <input
                                    id={usernameId}
                                    name={`${fieldId}-username`}
                                    type="text"
                                    value={username || ""}
                                    onChange={(e) =>
                                        onUsernameChange?.(e.target.value)
                                    }
                                    placeholder={
                                        onboardingRu.soulseekUsernamePlaceholder
                                    }
                                    autoComplete="username"
                                    className="min-h-11 w-full rounded-xl border border-line bg-surface-elevated px-4 py-2.5 text-base text-content outline-none placeholder:text-content-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                                />
                                <label htmlFor={passwordId} className="sr-only">
                                    Пароль Soulseek
                                </label>
                                <input
                                    id={passwordId}
                                    name={`${fieldId}-password`}
                                    type="password"
                                    value={password || ""}
                                    onChange={(e) =>
                                        onPasswordChange?.(e.target.value)
                                    }
                                    placeholder={
                                        onboardingRu.soulseekPasswordPlaceholder
                                    }
                                    autoComplete="current-password"
                                    className="min-h-11 w-full rounded-xl border border-line bg-surface-elevated px-4 py-2.5 text-base text-content outline-none placeholder:text-content-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                                />
                                <p className="mt-2 text-xs text-content-muted">
                                    {onboardingRu.soulseekCredentialsHint}
                                </p>
                            </>
                        ) : (
                            <div>
                                <label
                                    htmlFor={apiKeyId}
                                    className="mb-1.5 block text-xs font-semibold text-content-secondary"
                                >
                                    Ключ API
                                </label>
                                <input
                                    id={apiKeyId}
                                    name={`${fieldId}-api-key`}
                                    type="password"
                                    value={apiKey || ""}
                                    onChange={(e) =>
                                        onApiKeyChange?.(e.target.value)
                                    }
                                    placeholder={onboardingRu.apiKeyPlaceholder}
                                    autoComplete="off"
                                    className="min-h-11 w-full rounded-xl border border-line bg-surface-elevated px-4 py-2.5 text-base text-content outline-none placeholder:text-content-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                                />
                            </div>
                        )}
                        <button
                            onClick={onTest}
                            onKeyDown={(e) =>
                                e.key === "Enter" &&
                                !loading &&
                                !e.defaultPrevented &&
                                onTest()
                            }
                            disabled={
                                loading ||
                                !url ||
                                (!useSoulseekCreds
                                    ? !apiKey
                                    : !username || !password)
                            }
                            tabIndex={0}
                            className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-line bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-content transition-colors hover:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {onboardingRu.testConnection}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

interface SoulseekCardProps {
    enabled: boolean;
    onToggle: () => void;
    username: string;
    password: string;
    onUsernameChange: (username: string) => void;
    onPasswordChange: (password: string) => void;
    onTest: () => void;
    loading: boolean;
}

function SoulseekCard({
    enabled,
    onToggle,
    username,
    password,
    onUsernameChange,
    onPasswordChange,
    onTest,
    loading,
}: SoulseekCardProps) {
    const fieldId = useId().replaceAll(":", "");
    const usernameId = `${fieldId}-username`;
    const passwordId = `${fieldId}-password`;

    return (
        <div
            className={`rounded-2xl border transition-colors ${
                enabled
                    ? "bg-surface-raised border-brand/25"
                    : "border-line bg-white/[0.035]"
            }`}
        >
            <div className="p-4">
                <div className="flex items-start justify-between gap-3 sm:items-center">
                    <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                        <div
                            className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                                enabled
                                    ? "bg-brand/10 border border-brand/20 text-brand"
                                    : "border border-line bg-white/[0.04] text-content-muted"
                            }`}
                        >
                            <Search className="h-6 w-6" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <h3 className="font-bold text-content">Soulseek</h3>
                            <p className="text-sm leading-5 text-content-muted">
                                {onboardingRu.soulseekDescription}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onToggle}
                        role="switch"
                        aria-checked={enabled}
                        aria-label={`${enabled ? "Отключить" : "Включить"} Soulseek`}
                        className="grid min-h-11 min-w-11 place-items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                    >
                        <span
                            aria-hidden="true"
                            className={`relative h-6 w-11 rounded-full transition-colors ${
                                enabled ? "bg-brand" : "bg-white/20"
                            }`}
                        >
                            <span
                                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-lg transition-transform ${
                                    enabled ? "translate-x-5" : ""
                                }`}
                            />
                        </span>
                    </button>
                </div>

                {enabled && (
                    <div className="space-y-3 mt-4 pt-4 border-t border-white/10">
                        <div>
                            <label
                                htmlFor={usernameId}
                                className="mb-1.5 block text-xs font-semibold text-content-secondary"
                            >
                                Имя пользователя Soulseek
                            </label>
                            <input
                                id={usernameId}
                                name={`${fieldId}-username`}
                                type="text"
                                value={username}
                                onChange={(e) =>
                                    onUsernameChange(e.target.value)
                                }
                                placeholder={
                                    onboardingRu.soulseekUsernamePlaceholder
                                }
                                autoComplete="username"
                                className="min-h-11 w-full rounded-xl border border-line bg-surface-elevated px-4 py-2.5 text-base text-content outline-none placeholder:text-content-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                            />
                        </div>
                        <div>
                            <label
                                htmlFor={passwordId}
                                className="mb-1.5 block text-xs font-semibold text-content-secondary"
                            >
                                Пароль Soulseek
                            </label>
                            <input
                                id={passwordId}
                                name={`${fieldId}-password`}
                                type="password"
                                value={password}
                                onChange={(e) =>
                                    onPasswordChange(e.target.value)
                                }
                                placeholder={
                                    onboardingRu.soulseekPasswordPlaceholder
                                }
                                autoComplete="current-password"
                                className="min-h-11 w-full rounded-xl border border-line bg-surface-elevated px-4 py-2.5 text-base text-content outline-none placeholder:text-content-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
                            />
                        </div>
                        <p className="text-xs text-content-muted">
                            {onboardingRu.createSoulseekAccount}{" "}
                            <a
                                href="https://www.slsknet.org/news/node/1"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-brand hover:underline"
                            >
                                slsknet.org
                            </a>
                        </p>
                        <button
                            onClick={onTest}
                            onKeyDown={(e) =>
                                e.key === "Enter" &&
                                !loading &&
                                username &&
                                password &&
                                onTest()
                            }
                            disabled={loading || !username || !password}
                            tabIndex={0}
                            className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-line bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-content transition-colors hover:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {onboardingRu.testConnection}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
