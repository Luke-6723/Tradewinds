import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY } from "@/lib/auth-cookies";
import { saveAutopilotCompanyId } from "@/lib/db/collections";

export async function POST(req: NextRequest) {
  const { company_id } = await req.json();
  void saveAutopilotCompanyId(company_id).catch(() => {});
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_COMPANY, company_id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
