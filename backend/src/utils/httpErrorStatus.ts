/** Extracts an HTTP status from an Axios-style error without trusting its shape. */
export function getHttpErrorStatus(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null || !("response" in error)) {
        return undefined;
    }
    const response = error.response;
    if (
        typeof response !== "object" ||
        response === null ||
        !("status" in response)
    ) {
        return undefined;
    }
    return typeof response.status === "number" ? response.status : undefined;
}
