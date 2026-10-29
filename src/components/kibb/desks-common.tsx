"use client";

// The NPC desks (guide 3.16): seven player-to-player markets with an NPC house as the buyer of last resort. Shared by the
// desks page and the pages of each market (the ship market shows the broker's figures).

import { usePoll } from "@/hooks/use-poll";
import { kibbGet } from "@/lib/kibb/browser";
import { titleCase } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";

/** `days` on `GET /v1/world/desks`: 1..=360, default 30. */
export const DESK_DAYS = [7, 30, 90, 360] as const;

/** Each desk in words (guide 3.4, 3.7, 3.11, 3.13.5, 3.13.6, 3.16), and the page that trades in its market. */
export const DESKS: Record<S.DeskKind, { label: string; href: string; text: string }> = {
  ships: {
    label: "Ship broker",
    href: "/ships-market",
    text: "Buys a hull listed on the Exchange (not unlisted) at a port with an open shipyard when its price is far below the rebuild value, once the listing is a game hour old, holding only a few hulls per region. It pays more than a break-up and resells some game days later under the cost of a new hull.",
  },
  admiralty_commissions: {
    label: "Admiralty commissions",
    href: "/ships-market?tab=commissions",
    text: "A Crown with money to spare posts commissions for navy hulls at its yards, a little over the rebuild value, with a deposit forfeited if undelivered and one taken at a time per player. The desk's figures are hulls delivered to the Royal Navy; players' are commissions built for players.",
  },
  charter_filler: {
    label: "Charter filler",
    href: "/contracts",
    text: "Part-fills a player charter still open some game days after posting that pays well over the good's base price, one lot at a time from the nearest port that makes the good. The desk's figures are lots landed and the reward paid; players' are deliveries to player charters.",
  },
  envelopes: {
    label: "Lloyd's news desk",
    href: "/envelopes",
    text: "Buys an envelope a game hour old that carries news its port's coffee-house board lacks, at no more than the news is worth to it (which falls fast as it ages), within a budget per seller and region.",
  },
  ventures: {
    label: "Venture co-investor",
    href: "/ventures",
    text: "Puts a modest, capped stake late in the raise of a venture on the Exchange that gives its investors a large share of the profit, if the merchant's record shows no default or walk-away, and never into two open ventures of one merchant.",
  },
  ship_shares: {
    label: "Share desk",
    href: "/shares",
    text: "Buys a 64ths listing a game hour old priced well under both a 64th of the rebuild value and what the ship has earned lately (no earnings, no bid), holds a limited part of any ship, and relists a little above cost some game days later.",
  },
  futures: {
    label: "Goldsmiths' futures desk",
    href: "/futures",
    text: "Takes the other side of a futures listing at its region's hubs once it is an hour old, only when the strike is well in its favour against the hub's merchant mid, up to a modest size and a few contracts at a time. Values are the contracts' notional.",
  },
};

/** A desk's name, or its id in words for a desk this dashboard doesn't know yet. */
export const deskLabel = (d: string) => DESKS[d as S.DeskKind]?.label ?? titleCase(d);

/** The desk's share of its market over the window (0..1, by value or by count), or null when nothing traded. */
export function deskShare(d: S.DeskSection, by: "value" | "count"): number | null {
  const desk = by === "value" ? d.desk_bought.value_pence : d.desk_bought.count;
  const all = desk + (by === "value" ? d.player_trades.value_pence : d.player_trades.count);
  return all > 0 ? desk / all : null;
}

/** The desks board over the last `days` game days (public), every 5 minutes; never shown under another window. */
export function useDeskBoard(days: number) {
  const { data, error, loading, reload } = usePoll(() => kibbGet<S.DeskBoard>("/v1/world/desks", { days }).then((board) => ({ days, board })), 300_000, [days]);
  return { board: data && data.days === days ? data.board : undefined, error, loading, reload };
}
