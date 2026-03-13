import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY } from "@/lib/auth-cookies";
import { getWarehouseStocks } from "@/lib/db/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const companyId = req.cookies.get(COOKIE_COMPANY)?.value ?? process.env.TRADEWINDS_COMPANY_ID ?? "";
  if (!companyId) {
    return NextResponse.json({ error: "No company selected" }, { status: 401 });
  }
  const stocks = await getWarehouseStocks(companyId);
  return NextResponse.json(stocks);
}
