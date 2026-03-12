import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY, COOKIE_TOKEN, UPSTREAM } from "@/lib/auth-cookies";

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Register
  const regRes = await fetch(`${UPSTREAM}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!regRes.ok) {
    const data = await regRes.json();
    return NextResponse.json(data, { status: regRes.status });
  }

  // Auto-login after registration
  const loginRes = await fetch(`${UPSTREAM}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: body.email, password: body.password }),
  });

  const loginData = await loginRes.json();

  if (!loginRes.ok) {
    return NextResponse.json(loginData, { status: loginRes.status });
  }

  const token: string = loginData.data.token;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_TOKEN, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  res.cookies.delete(COOKIE_COMPANY);

  return res;
}
