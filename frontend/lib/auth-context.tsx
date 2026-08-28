"use client";

import {
    createContext,
    useContext,
    useEffect,
    useRef,
    useState,
    ReactNode,
    useMemo,
    useCallback,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "./api";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    clearCachedAuthUser,
    isAuthSessionChangeStorageEvent,
    readCachedAuthUser,
    logoutWithMandatoryLocalCleanup,
    shouldRestoreCachedOfflineSession,
    writeCachedAuthUser,
} from "@/lib/auth-offline-session";
import {
    AUTH_RUNTIME_REVOKED_EVENT,
    revokeAuthenticatedRuntime,
} from "@/lib/auth-runtime";
import { replaceAuthTokenFromCurrentUrl } from "@/lib/auth-url-token";
import { activateUserPlaybackStorage } from "@/lib/userPlaybackStorage";

interface User {
    id: string;
    username: string;
    displayName?: string | null;
    email?: string | null;
    role: string;
    onboardingComplete?: boolean;
}

interface AuthContextType {
    isAuthenticated: boolean;
    isLoading: boolean;
    user: User | null;
    login: (
        username: string,
        password: string,
        token?: string,
    ) => Promise<void>;
    logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const publicPaths = ["/login", "/register", "/onboarding", "/sync"];
const publicPrefixes = ["/share/"];

/**
 * Renders the AuthProvider component.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();
    const pathname = usePathname();
    const authEpochRef = useRef(0);

    useEffect(() => {
        // Check if user has valid session on mount ONLY
        const checkAuth = async () => {
            const authEpoch = ++authEpochRef.current;
            // Check for token in URL (from redirect after login)
            replaceAuthTokenFromCurrentUrl({
                revokeRuntime: () =>
                    revokeAuthenticatedRuntime({
                        notifyAuthProvider: false,
                    }),
                setToken: (token) => api.setToken(token),
            });
            const sessionGeneration = api.getSessionGeneration();
            const isCurrentAuthAttempt = () =>
                authEpoch === authEpochRef.current &&
                sessionGeneration === api.getSessionGeneration();

            try {
                const userData = await api.getCurrentUser();
                if (!isCurrentAuthAttempt()) return;
                activateUserPlaybackStorage(userData.id);
                writeCachedAuthUser(userData);
                setUser(userData);
                setIsAuthenticated(true);

                // Check onboarding status - redirect if needed
                if (
                    userData.onboardingComplete === false &&
                    pathname !== "/onboarding"
                ) {
                    router.push("/onboarding");
                } else if (
                    userData.onboardingComplete &&
                    pathname === "/onboarding"
                ) {
                    router.push("/");
                }
            } catch (error) {
                if (!isCurrentAuthAttempt()) return;
                const cachedUser = readCachedAuthUser();
                if (
                    cachedUser &&
                    shouldRestoreCachedOfflineSession({
                        error,
                        online:
                            typeof navigator === "undefined" ||
                            navigator.onLine,
                        hasAccessToken: Boolean(api.getToken()),
                        cachedUser,
                    })
                ) {
                    activateUserPlaybackStorage(cachedUser.id);
                    setUser(cachedUser);
                    setIsAuthenticated(true);
                    return;
                }
                revokeAuthenticatedRuntime({ notifyAuthProvider: false });
                setIsAuthenticated(false);
                setUser(null);

                // If we're already on onboarding page, allow access
                if (pathname === "/onboarding") {
                    setIsLoading(false);
                    return;
                }

                // If not on a public path, check if we need onboarding
                const isPublic =
                    publicPaths.includes(pathname) ||
                    publicPrefixes.some((prefix) =>
                        pathname.startsWith(prefix),
                    );
                if (!isPublic) {
                    // Check if any users exist in the system
                    try {
                        const status = await api.get<{ hasAccount: boolean }>(
                            "/onboarding/status",
                        );
                        if (!isCurrentAuthAttempt()) return;

                        if (!status.hasAccount) {
                            // No users exist - redirect to onboarding
                            router.push("/onboarding");
                            return;
                        }
                    } catch {
                        // Intentionally ignored: if onboarding status check fails, assume users exist and proceed to login
                    }
                    if (!isCurrentAuthAttempt()) return;
                    // Users exist but not logged in - redirect to login
                    router.push("/login");
                }
            } finally {
                if (authEpoch === authEpochRef.current) {
                    setIsLoading(false);
                }
            }
        };

        checkAuth();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Only run once on mount

    useEffect(() => {
        const handleRuntimeRevoked = () => {
            authEpochRef.current += 1;
            setIsAuthenticated(false);
            setUser(null);
            setIsLoading(false);
        };
        window.addEventListener(
            AUTH_RUNTIME_REVOKED_EVENT,
            handleRuntimeRevoked,
        );
        return () =>
            window.removeEventListener(
                AUTH_RUNTIME_REVOKED_EVENT,
                handleRuntimeRevoked,
            );
    }, []);

    const login = useCallback(
        async (username: string, password: string, token?: string) => {
            revokeAuthenticatedRuntime();
            const authEpoch = ++authEpochRef.current;
            api.clearToken();
            setIsAuthenticated(false);
            setUser(null);
            setIsLoading(true);
            try {
                const userData = await api.login(username, password, token);
                if (authEpoch !== authEpochRef.current) return;

                // Check if 2FA is required
                if (userData.requires2FA) {
                    // Don't set user or redirect, just throw an error to trigger 2FA UI
                    throw new Error("2FA token required");
                }

                activateUserPlaybackStorage(userData.id);
                setUser(userData);
                writeCachedAuthUser(userData);
                setIsAuthenticated(true);
                setIsLoading(false);

                // Redirect based on onboarding status
                if (userData.onboardingComplete === false) {
                    router.push("/onboarding");
                } else {
                    router.push("/");
                }
            } catch (error: unknown) {
                if (authEpoch === authEpochRef.current) {
                    setIsLoading(false);
                }
                sharedFrontendLogger.error(
                    "[AUTH] Login failed:",
                    error instanceof Error ? error.message : error,
                );
                throw error;
            }
        },
        [router],
    );

    const logout = useCallback(async () => {
        authEpochRef.current += 1;
        try {
            await logoutWithMandatoryLocalCleanup({
                remoteLogout: () => api.logout(),
                clearLocalSession: () => {
                    revokeAuthenticatedRuntime();
                    api.clearToken();
                    setIsAuthenticated(false);
                    setUser(null);
                    setIsLoading(false);
                },
            });
        } catch (error) {
            sharedFrontendLogger.warn(
                "[AUTH] Server logout failed; local session was cleared",
                error,
            );
        }
        router.push("/login");
    }, [router]);

    // localStorage events fire only in the other same-origin tabs. Revoke the
    // old React/audio/device runtime synchronously, then revalidate whichever
    // credential the originating tab committed without copying that token
    // through the event payload.
    useEffect(() => {
        const handleCrossTabSessionChange = (event: StorageEvent) => {
            if (!isAuthSessionChangeStorageEvent(event)) return;

            const authEpoch = ++authEpochRef.current;
            revokeAuthenticatedRuntime({ notifyAuthProvider: false });
            const storedToken = api.reloadTokenFromStorage();
            const sessionGeneration = api.getSessionGeneration();
            setIsAuthenticated(false);
            setUser(null);
            setIsLoading(false);

            if (!storedToken) {
                router.push("/login");
                return;
            }

            void api
                .getCurrentUser()
                .then((userData) => {
                    if (
                        authEpoch !== authEpochRef.current ||
                        api.getSessionGeneration() !== sessionGeneration
                    ) {
                        return;
                    }
                    activateUserPlaybackStorage(userData.id);
                    writeCachedAuthUser(userData);
                    setUser(userData);
                    setIsAuthenticated(true);

                    if (
                        userData.onboardingComplete === false &&
                        pathname !== "/onboarding"
                    ) {
                        router.push("/onboarding");
                    } else if (
                        userData.onboardingComplete &&
                        pathname === "/onboarding"
                    ) {
                        router.push("/");
                    }
                })
                .catch(() => {
                    if (
                        authEpoch !== authEpochRef.current ||
                        api.getSessionGeneration() !== sessionGeneration
                    ) {
                        return;
                    }
                    clearCachedAuthUser();
                    setUser(null);
                    setIsAuthenticated(false);
                    router.push("/login");
                });
        };

        window.addEventListener("storage", handleCrossTabSessionChange);
        return () => {
            authEpochRef.current += 1;
            window.removeEventListener("storage", handleCrossTabSessionChange);
        };
    }, [pathname, router]);

    // Listen for session-expired events from the API client (stale/invalid tokens)
    useEffect(() => {
        const handleSessionExpired = () => {
            authEpochRef.current += 1;
            const current = window.location.pathname;
            const isPublicRoute =
                publicPaths.includes(current) ||
                publicPrefixes.some((prefix) => current.startsWith(prefix));

            setIsAuthenticated(false);
            setUser(null);
            setIsLoading(false);
            revokeAuthenticatedRuntime({ notifyAuthProvider: false });
            if (!isPublicRoute) {
                router.push("/login");
            }
        };
        window.addEventListener("auth:session-expired", handleSessionExpired);
        return () =>
            window.removeEventListener(
                "auth:session-expired",
                handleSessionExpired,
            );
    }, [router]);

    // Memoize context value to prevent unnecessary re-renders
    const contextValue = useMemo(
        () => ({
            isAuthenticated,
            isLoading,
            user,
            login,
            logout,
        }),
        [isAuthenticated, isLoading, user, login, logout],
    );

    return (
        <AuthContext.Provider value={contextValue}>
            {children}
        </AuthContext.Provider>
    );
}

/**
 * Executes useAuth.
 */
export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
