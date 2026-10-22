// Cookie names for the dashboard session. Kept free of Node imports so middleware (edge) can use them.

/** Player-level API key from login: lists, creates and selects companies. httpOnly. */
export const COOKIE_PLAYER_KEY = "kw_player_key";
/** Active company id. Its company-bound key lives server-side in the local store, not in the browser. */
export const COOKIE_COMPANY_ID = "kw_company_id";
