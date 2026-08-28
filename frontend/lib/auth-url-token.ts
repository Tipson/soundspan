type AuthTokenReplacement = {
    revokeRuntime: () => void;
    setToken: (token: string) => void;
};

/**
 * Consume a legacy URL credential before any account storage can throw. Only
 * the secret parameter is removed; unrelated query state and the hash remain.
 */
export function replaceAuthTokenFromCurrentUrl(
    replacement: AuthTokenReplacement,
): boolean {
    if (typeof window === "undefined") return false;

    const currentUrl = new URL(window.location.href);
    if (!currentUrl.searchParams.has("token")) return false;

    const token = currentUrl.searchParams.get("token");
    currentUrl.searchParams.delete("token");
    window.history.replaceState(
        window.history.state,
        "",
        `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
    );

    if (!token) return false;
    replacement.revokeRuntime();
    replacement.setToken(token);
    return true;
}
