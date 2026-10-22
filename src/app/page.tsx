import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";

export default async function Home() {
  const jar = await cookies();
  if (jar.has(COOKIE_COMPANY_ID)) redirect("/dashboard");
  if (jar.has(COOKIE_PLAYER_KEY)) redirect("/companies");
  redirect("/login");
}
