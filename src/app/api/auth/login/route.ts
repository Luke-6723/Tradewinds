import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY, COOKIE_TOKEN, UPSTREAM } from "@/lib/auth-cookies";

export async function POST(req: NextRequest) {
  const body = await req.json();

  const upstream = await fetch(`${UPSTREAM}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await upstream.json();

  if (!upstream.ok) {
    return NextResponse.json(data, { status: upstream.status });
  }

  const token: string = data.data.token;

  // Persist credentials so the standalone autopilot process can refresh tokens.
  // ⚠ Plaintext — this is a private app.
  const { saveAutopilotCredentials } = await import("@/lib/db/collections");
  void saveAutopilotCredentials(body.email as string, body.password as string).catch(() => {});

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_TOKEN, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  // Clear any stale company selection
  res.cookies.delete(COOKIE_COMPANY);

  return res;
}
