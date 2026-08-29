/**
 * Leaves four seconds for route and network overhead beyond the backend's
 * bounded 13-second YouTube Music radio call, while staying below the
 * frontend proxy's 20-second upstream budget.
 */
export const PERSONALIZED_HOME_REQUEST_TIMEOUT_MS = 17_000;
export const PERSONALIZED_HOME_TIMEOUT_RETRY = false;
export const PERSONALIZED_HOME_QUERY_RETRY = false;
