import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_COMPANY, COOKIE_TOKEN } from "@/lib/auth-cookies";

export default async function Home() {
  const jar = await cookies();
  const hasToken   = jar.has(COOKIE_TOKEN)   || !!process.env.TRADEWINDS_TOKEN;
  const hasCompany = jar.has(COOKIE_COMPANY) || !!process.env.TRADEWINDS_COMPANY_ID;

  if (!hasToken)   redirect("/login");
  if (!hasCompany) redirect("/companies");
  redirect("/dashboard");
}
