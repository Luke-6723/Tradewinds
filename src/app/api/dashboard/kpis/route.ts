import { type NextRequest, NextResponse } from "next/server";
import { autopilotManager } from "@/lib/server/autopilot-manager";
import { COOKIE_COMPANY } from "@/lib/auth-cookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const companyId = req.cookies.get(COOKIE_COMPANY)?.value ?? process.env.TRADEWINDS_COMPANY_ID ?? "";

  const ap = await autopilotManager.getState(companyId);
  const shipStates = Object.values(ap.ships);

  const cargoAtCost = shipStates.reduce((sum, ss) => {
    if (!ss.plan?.goodId) return sum;
    return sum + (ss.plan.actualBuyPrice ?? 0) * (ss.plan.quantity ?? 0);
  }, 0);

  const paxInTransit = shipStates.reduce((sum, ss) => {
    if (ss.phase === "transiting_to_sell" && ss.plan?.passengerBid) {
      return sum + ss.plan.passengerBid;
    }
    return sum;
  }, 0);

  const cargoInTransitValue = shipStates.reduce((sum, ss) => {
    if (!ss.plan?.goodId) return sum;
    const qty = ss.plan.quantity ?? 0;
    const price = ss.plan.sellPrice ?? ss.plan.actualBuyPrice ?? 0;
    return sum + qty * price;
  }, 0);

  return NextResponse.json({
    cargoInTransitValue,
    paxInTransit,
    cargoAtCost,
    netProfit: ap.profitAccrued,
    cyclesRun: ap.cyclesRun,
  });
}
