import { NextResponse } from "next/server";
import { KibbApiError } from "@/lib/kibb/client";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { errorResponse, forgetOwner } from "@/lib/kibb/server";

/** 401 for the account routes when the request carries no player session. */
export function noSession() {
  return NextResponse.json({ status: 401, code: "not_signed_in", detail: "Sign in first" }, { status: 401 });
}

/**
 * The reply for an error from a call made with the player key: a 401 means the key itself is
 * expired or revoked, so the browser is signed out (and sent to /login by browser.ts).
 */
export function playerKeyError(playerKey: string, e: unknown): NextResponse {
  if (e instanceof KibbApiError && e.status === 401) {
    forgetOwner(playerKey);
    const res = NextResponse.json({ status: 401, code: "not_signed_in", detail: "Your session has expired; sign in again" }, { status: 401 });
    res.cookies.delete(COOKIE_PLAYER_KEY);
    res.cookies.delete(COOKIE_COMPANY_ID);
    return res;
  }
  return errorResponse(e);
}
