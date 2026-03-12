import { NextResponse } from "next/server";
import { COOKIE_COMPANY, COOKIE_TOKEN } from "@/lib/auth-cookies";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE_TOKEN);
  res.cookies.delete(COOKIE_COMPANY);
  return res;
}
