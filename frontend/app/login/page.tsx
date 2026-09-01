"use client";

import {
    Suspense,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { AuthPanel, AuthStage } from "@/features/auth/components/AuthStage";
import { LocalLoginForm } from "@/features/auth/components/LocalLoginForm";
import { OidcInviteForm } from "@/features/auth/components/OidcInviteForm";
import { OidcLinkForm } from "@/features/auth/components/OidcLinkForm";
import { SsoButton } from "@/features/auth/components/SsoButton";
import {
    buildOidcLoginUrl,
    getSsoErrorMessage,
    normalizeLoginReturnTo,
} from "@/features/auth/oidc";
import { api } from "@/lib/api";
import type { AuthConfig } from "@/lib/api/auth";
import { BRAND_NAME } from "@/lib/brand";
import { frontendLogger } from "@/lib/logger";
import { pluralRu, ru, userFacingError } from "@/lib/i18n/ru";

interface Artist {
    id: string;
    name: string;
    heroUrl: string | null;
    albumCount?: number;
}

interface LoginParameters {
    ssoCode: string | null;
    ssoLink: string | null;
    ssoInvite: string | null;
    ssoError: string | null;
    legacyError: string | null;
    returnTo: string;
    hasOidcCallback: boolean;
}

const loginLogger = frontendLogger.child("Login");
const AUTH_CONFIG_QUERY_KEY = ["auth", "config"] as const;
const ONBOARDING_QUERY_KEY = ["onboarding", "status"] as const;

function LoadingPage({ message }: { message?: string }) {
    return (
        <AuthStage footer={false}>
            <AuthPanel>
                <div
                    role="status"
                    className="flex flex-col items-center gap-3 py-8 text-content-secondary"
                >
                    <Loader2 className="h-8 w-8 animate-spin motion-reduce:animate-none" />
                    <p>{message ?? "Готовим вход в Soundspan…"}</p>
                </div>
            </AuthPanel>
        </AuthStage>
    );
}

function readLoginParameters(searchParams: URLSearchParams): LoginParameters {
    const ssoCode = searchParams.get("ssoCode");
    const ssoLink = searchParams.get("ssoLink");
    const ssoInvite = searchParams.get("ssoInvite");
    const ssoError = searchParams.get("ssoError");
    return {
        ssoCode,
        ssoLink,
        ssoInvite,
        ssoError,
        legacyError: searchParams.get("error"),
        returnTo: normalizeLoginReturnTo(searchParams.get("returnTo")),
        hasOidcCallback: Boolean(ssoCode || ssoLink || ssoInvite || ssoError),
    };
}

function stripQueryParameter(name: string): void {
    const url = new URL(window.location.href);
    url.searchParams.delete(name);
    const query = url.searchParams.toString();
    const nextUrl = `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
    window.history.replaceState({}, "", nextUrl);
}

function navigateToReturnTo(returnTo: string): void {
    window.location.assign(normalizeLoginReturnTo(returnTo));
}

function buildBrowserOidcLoginUrl(returnTo: string): string {
    return buildOidcLoginUrl(returnTo, {
        configuredApiUrl: process.env.NEXT_PUBLIC_API_URL,
        apiPathMode: process.env.NEXT_PUBLIC_API_PATH_MODE,
        browserLocation: window.location,
    });
}

function useLoginParameters(): LoginParameters {
    const searchParams = useSearchParams();
    const parameters = useMemo(
        () => readLoginParameters(new URLSearchParams(searchParams.toString())),
        [searchParams],
    );
    const [callbackPresentOnMount] = useState(parameters.hasOidcCallback);
    return {
        ...parameters,
        hasOidcCallback: callbackPresentOnMount || parameters.hasOidcCallback,
    };
}

function useLoginArtists(): { artists: Artist[]; currentIndex: number } {
    const [artists, setArtists] = useState<Artist[]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    useEffect(() => {
        void api
            .getRecentlyListened(10)
            .then((data) => {
                const items = Array.isArray(data?.items) ? data.items : [];
                const available = items
                    .filter((item) => item.type === "artist")
                    .map((item) => ({
                        id: item.id || "",
                        name: item.name || "Неизвестный артист",
                        heroUrl:
                            item.userHeroUrl ||
                            item.heroUrl ||
                            item.coverArt ||
                            null,
                        albumCount: item.albumCount,
                    }))
                    .filter((artist) => artist.id && artist.heroUrl);
                setArtists(available);
            })
            .catch(() => undefined);
    }, []);
    useEffect(() => {
        if (artists.length <= 1) return undefined;
        const interval = window.setInterval(() => {
            setCurrentIndex((index) => (index + 1) % artists.length);
        }, 5000);
        return () => window.clearInterval(interval);
    }, [artists.length]);
    return { artists, currentIndex };
}

function useCallbackError(
    parameters: LoginParameters,
): [string, (value: string) => void] {
    const [error, setError] = useState(() => {
        if (parameters.ssoError) return getSsoErrorMessage(parameters.ssoError);
        return parameters.legacyError || "";
    });
    useEffect(() => {
        if (parameters.ssoError) stripQueryParameter("ssoError");
    }, [parameters.ssoError]);
    return [error, setError];
}

interface CallbackExchangeState {
    failed: boolean;
    pending: boolean;
}

function useOidcCodeExchange(
    code: string | null,
    returnTo: string,
    setError: (message: string) => void,
): CallbackExchangeState {
    const startedCode = useRef<string | null>(null);
    const [state, setState] = useState<CallbackExchangeState>({
        failed: false,
        pending: Boolean(code),
    });
    useEffect(() => {
        if (!code || startedCode.current === code) return;
        startedCode.current = code;
        setState({ failed: false, pending: true });
        void api
            .exchangeOidcCode(code)
            .then(() => navigateToReturnTo(returnTo))
            .catch((caught) => {
                loginLogger.error("OIDC code exchange failed", {
                    error: caught,
                });
                setError(userFacingError(caught, ru.auth.completeSsoError));
                stripQueryParameter("ssoCode");
                setState({ failed: true, pending: false });
            });
    }, [code, returnTo, setError]);
    return state;
}

/** Renders the login route with local and OIDC authentication modes. */
function LoginPageContent() {
    const router = useRouter();
    const parameters = useLoginParameters();
    const [error, setError] = useCallbackError(parameters);
    const exchange = useOidcCodeExchange(
        parameters.ssoCode,
        parameters.returnTo,
        setError,
    );
    const { artists, currentIndex } = useLoginArtists();
    const authConfig = useQuery({
        queryKey: AUTH_CONFIG_QUERY_KEY,
        queryFn: () => api.getAuthConfig(),
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
    });
    const onboarding = useQuery({
        queryKey: ONBOARDING_QUERY_KEY,
        queryFn: () => api.getOnboardingStatus(),
        retry: false,
    });

    useEffect(() => {
        if (onboarding.data && !onboarding.data.hasAccount) {
            router.replace("/onboarding");
        }
    }, [onboarding.data, router]);

    if (authConfig.isPending || onboarding.isPending) return <LoadingPage />;
    if (authConfig.isError || !authConfig.data) {
        return <AuthConfigFailure onRetry={() => void authConfig.refetch()} />;
    }
    if (onboarding.data && !onboarding.data.hasAccount) return <LoadingPage />;

    return (
        <LoginScene artists={artists} currentIndex={currentIndex}>
            <LoginCard
                config={authConfig.data}
                parameters={parameters}
                exchange={exchange}
                error={error}
            />
        </LoginScene>
    );
}

function AuthConfigFailure({ onRetry }: { onRetry: () => void }) {
    return (
        <AuthStage footer={false}>
            <AuthPanel className="text-center">
                <p role="alert">{ru.auth.loadOptionsError}</p>
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-5 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-brand px-5 py-2.5 text-sm font-black text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                >
                    {ru.common.retry}
                </button>
            </AuthPanel>
        </AuthStage>
    );
}

interface LoginCardProps {
    config: AuthConfig;
    parameters: LoginParameters;
    exchange: CallbackExchangeState;
    error: string;
}

function LoginCard({ config, parameters, exchange, error }: LoginCardProps) {
    const startSso = (): void => {
        window.location.assign(buildBrowserOidcLoginUrl(parameters.returnTo));
    };
    const autoRedirect =
        !config.localLoginEnabled &&
        config.oidcEnabled &&
        !parameters.hasOidcCallback;

    useEffect(() => {
        if (autoRedirect) {
            window.location.assign(
                buildBrowserOidcLoginUrl(parameters.returnTo),
            );
        }
    }, [autoRedirect, parameters.returnTo]);

    const authenticated = (): void => navigateToReturnTo(parameters.returnTo);
    const flow = selectLoginFlow(
        config,
        parameters,
        exchange,
        autoRedirect,
        startSso,
        authenticated,
    );
    return (
        <AuthPanel>
            <p className="text-center text-[0.68rem] font-bold uppercase tracking-[0.18em] text-brand-light">
                Ваш Soundspan
            </p>
            <h1 className="mt-2 text-center text-2xl font-black tracking-[-0.035em] text-content sm:text-3xl">
                {ru.auth.welcomeBack}
            </h1>
            <p className="mb-7 mt-2 text-center text-sm leading-6 text-content-secondary">
                {ru.auth.continueTo} {BRAND_NAME}
            </p>
            {error && (
                <div
                    role="alert"
                    className="mb-4 rounded-2xl border border-red-400/25 bg-red-500/10 p-4 text-sm leading-5 text-red-200"
                >
                    {error}
                </div>
            )}
            {flow}
            {config.localLoginEnabled &&
                !parameters.ssoLink &&
                !parameters.ssoInvite && (
                    <p className="mt-6 text-center text-sm text-content-muted">
                        {ru.auth.inviteQuestion}{" "}
                        <Link
                            href="/register"
                            className="inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-brand-light transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        >
                            {ru.auth.signUp}
                        </Link>
                    </p>
                )}
        </AuthPanel>
    );
}

function selectLoginFlow(
    config: AuthConfig,
    parameters: LoginParameters,
    exchange: CallbackExchangeState,
    autoRedirect: boolean,
    startSso: () => void,
    authenticated: () => void,
): ReactNode {
    if (parameters.ssoCode && !exchange.failed) {
        return <LoadingPageContent message={ru.auth.completeSso} />;
    }
    if (parameters.ssoLink) {
        return (
            <OidcLinkForm
                linkToken={parameters.ssoLink}
                onAuthenticated={authenticated}
            />
        );
    }
    if (parameters.ssoInvite) {
        return (
            <OidcInviteForm
                inviteToken={parameters.ssoInvite}
                onAuthenticated={authenticated}
            />
        );
    }
    if (autoRedirect) {
        return (
            <RedirectingContent
                providerName={config.oidcProviderName}
                onClick={startSso}
            />
        );
    }
    return <DefaultLoginOptions config={config} onSsoClick={startSso} />;
}

function LoadingPageContent({ message }: { message: string }) {
    return (
        <div
            role="status"
            className="flex flex-col items-center gap-3 py-4 text-content-secondary"
        >
            <Loader2 className="w-6 h-6 animate-spin" />
            <p>{message}</p>
        </div>
    );
}

function RedirectingContent({
    providerName,
    onClick,
}: {
    providerName: string;
    onClick: () => void;
}) {
    return (
        <div className="space-y-4">
            <LoadingPageContent message={ru.auth.redirectSso} />
            <SsoButton providerName={providerName} onClick={onClick} />
        </div>
    );
}

function DefaultLoginOptions({
    config,
    onSsoClick,
}: {
    config: AuthConfig;
    onSsoClick: () => void;
}) {
    return (
        <div className="space-y-4">
            {config.oidcEnabled && (
                <SsoButton
                    providerName={config.oidcProviderName}
                    onClick={onSsoClick}
                />
            )}
            {config.oidcEnabled && config.localLoginEnabled && (
                <div
                    className="flex items-center gap-3 text-xs text-content-muted"
                    aria-hidden="true"
                >
                    <span className="h-px flex-1 bg-line" />
                    {ru.auth.or}
                    <span className="h-px flex-1 bg-line" />
                </div>
            )}
            {config.localLoginEnabled && <LocalLoginForm />}
        </div>
    );
}

function LoginScene({
    artists,
    currentIndex,
    children,
}: {
    artists: Artist[];
    currentIndex: number;
    children: ReactNode;
}) {
    const currentArtist = artists[currentIndex];
    return (
        <AuthStage
            backdrop={
                <LoginBackground
                    currentArtist={currentArtist}
                    currentIndex={currentIndex}
                />
            }
            aside={
                currentArtist ? (
                    <ArtistInfo artist={currentArtist} />
                ) : undefined
            }
        >
            {children}
        </AuthStage>
    );
}

function LoginBackground({
    currentArtist,
    currentIndex,
}: {
    currentArtist?: Artist;
    currentIndex: number;
}) {
    return (
        <div className="absolute inset-0">
            {currentArtist?.heroUrl && (
                <>
                    <div
                        key={currentIndex}
                        className="absolute inset-0 transition-opacity duration-1000"
                    >
                        <Image
                            src={currentArtist.heroUrl}
                            alt={currentArtist.name}
                            fill
                            className="object-cover"
                            priority
                        />
                    </div>
                    <div className="absolute inset-0 bg-surface/70 backdrop-blur-[100px]" />
                    <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/55 to-surface/60" />
                </>
            )}
        </div>
    );
}

function ArtistInfo({ artist }: { artist: Artist }) {
    return (
        <div className="max-w-xl animate-fade-in text-content motion-reduce:animate-none">
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-brand-light">
                {ru.auth.featuredArtist}
            </p>
            <h2 className="mb-3 text-4xl font-black tracking-[-0.045em] drop-shadow-2xl xl:text-5xl">
                {artist.name}
            </h2>
            {artist.albumCount !== undefined && (
                <p className="text-sm text-content-secondary">
                    {artist.albumCount}{" "}
                    {pluralRu(artist.albumCount, [
                        "альбом",
                        "альбома",
                        "альбомов",
                    ])}{" "}
                    {ru.auth.inYourLibrary}
                </p>
            )}
        </div>
    );
}

/** Provides the Suspense boundary required by Next.js search parameters. */
export default function LoginPage() {
    return (
        <Suspense fallback={<LoadingPage />}>
            <LoginPageContent />
        </Suspense>
    );
}
