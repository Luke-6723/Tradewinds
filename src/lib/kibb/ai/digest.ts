/**
 * What the strategist reads and what it may answer: a stable system prompt (game rules, what the
 * autopilot does, the directives and their limits, the catalog; cached for an hour), a compact
 * digest of the fleet and the world for each call, and the JSON schema of its answer.
 *
 * Nothing written by other players reaches the model: ships, charters, lanes, rival companies, our
 * loans and commissions appear as aliases (S1, C4, L2, R1, D1, K1) resolved back when the answer is applied, ports, goods and
 * zones as catalog ids, free-text notices only as the fields the Haiku screen extracted, and the
 * outcome of its orders only as fixed status codes (the game's own wording stays in the log).
 */

import type { ExpansionWatch, CharterInfo, StormSummary } from "../fleet/world";
import type { FleetSettings, GunPolicy } from "../fleet/manager";
import type { Lane, StallStake } from "../fleet/planner";
import type { MarketModelSummary } from "../fleet/market-model";
import type { TripRecord } from "../fleet/agent";
import type { Catalog } from "../types";
import type { ScreenedEvent } from "./screen";
import { aiRange, isHousekeeping, NUMBER_KEYS, SWITCH_KEYS, type Active, type BanKind, type Bias, type ShipOrderKind } from "./directives";

// ── System prompt ────────────────────────────────────────────────────────────

const RULES = `You are the strategist for a fleet autopilot in Tradewinds, a multiplayer age-of-sail trading game. You advise; deterministic code does every calculation, places every order and checks every limit.

## The game
- Time runs 60x: 1 game hour is 1 real minute, a game day is 24 real minutes. Your advice is applied for its horizon (15 to 180 real minutes) and then lapses.
- Ships buy goods from NPC markets at ports and either deliver them to charters (fixed pay per ton for goods carried in from another port), sell them to NPC buyers elsewhere, or carry sealed freight for other companies.
- Expansion (Admiralty) charters are public and belong to a tier. Every ton delivered also earns a share of the tier's completion bonus (12% of the tier's base value), split by the square root of each player's tons valued at base prices, a player's companies pooled: the first tons earn the most and a leader's extra tons little (80% / 15% / 5% of the value delivered take about 59% / 26% / 15%; the public board's share is of the value delivered, not of the bonus). The planner counts each load's marginal share; the digest gives ours as the board stands.
- Charter premium taper: Crown and Admiralty charters (not players' charters) always pay the goods' value (per ton the catalog base price, or the reward if lower); the premium above that is multiplied by sqrt(50,000 Cr / earnings) once our charter earnings over the last 10 game days pass 50,000 Cr (all our companies together, the delivery included). Tons still count in full towards expansion charters and the completion bonus. The planner, leftovers and stall holds value Crown pay that way (each load's own pay counted in), so as earnings grow, player charters, market sales and the bonus weigh relatively more; the digest gives our earnings and the factor. When the tier's target tonnage is delivered, the next phase opens: new ports, new hull classes, a new tier whose charters are often far away and nobody can reach yet.
- An expansion posting lapses and is re-posted. A posting is stalled while under a tenth of its expected pace (its tons spread over its window) has been delivered; any other company's delivery cancels the escalation (our own other companies count as other companies). If it is still stalled at the lapse, the re-post pays more (about +25%) on fewer tons (about 75%). Whether our own small deliveries cancel it isn't published: the autopilot takes them to, until re-posts that only our ships delivered to (still under the line late in the window) escalate twice in a row; from then on a ship may deliver into a stalled posting what keeps it under 80% of its pace line (the digest says which holds). The autopilot has learned how often a stalled posting really stays stalled until it lapses. A rival once took a lead by being the only one able to reach a stalled, escalating charter.
- Hulls are rated coastal, regional or oceanic; a ship can only sail water its hull is rated for. Some charters lie beyond coastal water.
- Cash sits in regional vaults (8 banking regions, the American colonies among them); moving it costs fees: the Crown's, or a bank's when the cheapest open bank posting an exchange fee for the destination is strictly under the Crown's fee and has the cash there (a bank draft, carried automatically: auto-remit for bills never uses one; the digest's cash line counts what drafts saved). Upkeep is billed daily from the home region: sprawl on coastal and regional hull tons plus half the oceanic hull tons (above the first 40 t, steeper than linear), plus 1 Cr per oceanic hull ton a day, plus the factors. Ships cost a lot; buying them early compounds income (the leading rival grew to about 20 ships by reinvesting charter pay).
- The Crown's wealth levy: a company's net worth (as the leaderboard counts it: cash, escrow, goods, hulls, loans, deposits, venture stakes) above 1,000,000 Cr pays 0.1% of the excess every game day (about 6% a real day), taken from cash (richest vault first, never below the threshold). Putting money to work doesn't avoid it: it is simply a cost of size, kept in the home floor (the digest gives it).
- Contraband (goods of category contraband) lives only aboard ships: no market, warehouse, charter, freight or pledge takes it. Smugglers' coves (is_cove ports) sell it from the Underworld's book and sell ships' stores, but host no lawful lanes and no factor. The autopilot never plans lawful trade at a cove or in contraband; a ship with contraband aboard never berths, buys stores or trades in an ordinary port (a ship lying there with it may be searched, berthed more than in the roadstead; a cove is never searched), and holds it in the roadstead unless the smuggling mode takes her.
- The Free Trade (smuggling): ordinary ports want contraband from time to time (a multiple of base for the first ton ashore, fading, each ton walking it down); the news travels only to the coves (their board, with its age) or is seen where our ships lie. At sea only patrols search, in their zones; in port a ship lying there with contraband may be searched any time; runs ashore often draw the Crown's attention. Caught: the ship and everything aboard are forfeit, insurance pays nothing (Lloyd's never covers contraband), and the conviction goes on our public credit record. The smuggling mode (setting smuggling: only the user can turn it on, you may switch it off; it needs the key's underworld scope) uses one dedicated ship at a time (never the only one, never pledged, insured, listed, in a convoy, or with lawful cargo or sealed freight aboard), buys at most smuggleMaxTons and smuggleMaxPence at a cove on a fresh rich want (a game day old at most, 3x base or more), sails only routes no patrol works (checked again before departing), lies in the roadstead and runs it ashore at once, and only when the expected gain is at least twice the expected loss on a conservative seizure model learned from our own runs; after a seizure it switches itself off until the user turns it on again. Switched off (by the user, you or a seizure), nothing new is bought, but a load already aboard is finished first (run ashore where she lies, or sold at a cove clear of patrols): switching it off doesn't strand a ship with contraband. No patrol of ours goes where our smugglers sail, nor anywhere while a ship with contraband aboard lies in an ordinary port with no passage planned (a patrol order then waits or is dropped). The digest's "Free Trade" section says what it does.
- Shipyards: a turnkey build buys each material off the yard port's ask book (players' asks and the NPC ladder, cheapest first; our own and linked asks, and asks over 2.5x the mid, are passed over), pays customs on every fill and a 15% markup on the NPC-sourced part only; byomBuilds saves that markup. Discount yards (Lisbon, Boston, Havana) charge 30% less labour and no markup: their quotes (the digest's) are what we'd pay, but a hull's rebuild value stays the full price. A book that can't supply refuses the build. The packet (Phase 2, 16 kn, 16 t, can seal its dispatches) is a courier: the buyer never builds one.
- Ships pledged to loans: a liened ship can't be listed, sold or pledged again until repaid; a defaulted loan's ship is arrested (it can't depart or join a convoy; cargo aboard is sold toward the debt). The autopilot parks an arrested ship until our loans show it free (state "arrested").
- Loans by quote: a loan has a fixed annual rate (bps per 360 game days) for 1-360 game days, simple interest for the game time elapsed; repaid "balloon" (all at maturity) or "amortised" (installments every 10 game days; one missed is in arrears for a game day, then the whole loan defaults). Repaying early is free (interest to date only). The Goldsmiths' Company quotes at once against one of our ships (at most 40% of her rebuild value and 7,500 Cr a loan, with recourse) at 45% a year for terms up to 30 game days sliding to 30% at 360 (the digest lists it by term); players post requests for quotes and lenders quote on them (within a tenth to three times the Goldsmiths' rate for the term), the borrower approving one. A default on a player lender's loan (or a Goldsmiths' ship mortgage) hands a liened ship to the lender where she lies, credited at 80% of her rebuild value (a surplus over the debt is paid back to the borrower), and arrests her meanwhile; with recourse the rest is claimed from our vaults. A default on a Goldsmiths' instant loan (the autopilot's own, bar ship mortgages) is harsher: they take the ship credited only at her break-up value, 35% of her rebuild value, pay no surplus, and the rest is still owed (taken from our vaults until paid). An insured ship lost under a lien pays the lender first. Walking away (written off, except on a Goldsmiths' instant loan, where the rest stays owed; a permanent mark on the credit record) is the owner's call only: the autopilot never does it. After any walk-away by us or a linked company the Goldsmiths quote and lend nothing for a real day (the autopilot borrows nothing until then). Net worth subtracts what is owed, so borrowing never lifts us up the board. With leverage on, the autopilot borrows only to bridge a hull our own cash can't fund (against cash due from cargo at sea, at most half the hull) or a load at its source that cash limits, when the money earns at least minLoanReturnX times the interest over the term and pays back within half of it, on the Goldsmiths' quote (balloon), with what is owed kept within maxDebtPct of net worth; it then asks player lenders for quotes and approves one that refinances the Goldsmiths' loan for less. Banks' lending lines are standing terms (a rate as a share of the Goldsmiths' rate for the term, a loan-to-value, longest term, principal range, credit filters and caps) that quote at once on every request they cover, standing 6 game hours: cheap money through a refinance request, which the autopilot shapes to fit the cheapest line that covers it (its pledge, term and size) and whose quote it approves within the minute when strictly under the Goldsmiths' rate and saving enough (the Goldsmiths' own answer to an unquoted request is never taken: it is their rate). Its other loan is a ship mortgage (mortgages on, with leverage): a turnkey hull our cash can't fund is built with the yard region's Goldsmiths paying 60% of its price (80% for an oceanic hull), amortised over 180 game days (an installment every 10), a lien on the new hull with recourse, one at a time, within the debt cap (principal and interest), when the hull's net covers its installments 1.5x and earns minLoanReturnX its interest (the cheaper in interest when an instant loan would also do); never repaid early (in full only as the season ends); a default credits 80% of her rebuild value plus the surplus. What is owed (installments included; of a mortgage, its next 2) is never spent on hulls, marques or lending, loads never spend what a repayment counts on, an instant loan is repaid early when cash isn't scarce, and always in full 2 game days before maturity (short: all new spending stops). No new loans in the season's last 12 hours, while one is overdue or in arrears, or while our idle cash is quoted (it is taken back first). With idleCash on, spare cash the fleet hasn't needed for 20 game hours (beyond its loads, our loans and 25,000 Cr) is quoted on players' secured requests (ship liens or goods, with recourse, at most 60 game days) from borrowers with a clean credit record (no default, walk-away, write-off, bankruptcy or smuggling conviction), never our own companies, at 0.9x the Goldsmiths' rate for the term (never under 15% a year); the quote's principal is escrowed until the borrower approves another, it lapses, or the fleet needs the cash and it is withdrawn.
- Banks (guide 3.13.4): a bank pays interest every game day on deposits (a rate in bps a game day); a demand withdrawal is paid at once as far as its cash reaches, the rest owed later, and a bank that leaves one unpaid for a game day fails (the Crown insures 2,500 Cr per player at an insured bank, on deposits 14+ game days old). With deposits on, cash the fleet doesn't need (beyond its loads, loans, commissions, a liquid buffer of 25,000 Cr or two game days of bills, and while the buyer may build its next hull, and what a spend was short of lately) that has had nothing to fund for 6 game hours goes on demand deposit where it lies with healthy banks (open, nothing overdue, reserves at the Crown's 20%, a rate above nothing and at most 25 bps), insured first, at most 2,500 Cr a bank unless it is insured with reserves twice the Crown's 20%, never over a tenth of a bank's deposits and reserves, within depositBudgetPence; a region short of cash takes ours back before anything is remitted, a bank in trouble has ours withdrawn at once (one winding down or failed pays nothing on demand: ours there is frozen, owed later), and all of it comes back when the fleet needs the cash, we owe on a loan dearer than deposits pay, or in the season's final hours. Deposits count in net worth and, at healthy banks, as cash every spend may use (loads, hulls, commissions, ship deals, underwriting, marques and patrols): they come back for it first, a loan or mortgage is taken only for what they can't cover, and they never stop borrowing, so deposits never hold the fleet back. With runBank on (off by default), our own bank is chartered once net worth reaches bankMinNetWorthPence and 60,000 Cr plus the buffer are spare (the 10,000 Cr fee to the Crown is never refunded): it takes no deposits (rates 0 / 0), posts exchange fees 15% under the Crown's median into regions where our vault keeps a clear surplus (never home; a remittance there is then carried as our draft, paid out of our vault there, the fee our income) and one lending line (ship liens, balloon, 70% of the Goldsmiths' rate, at most 50% of the ship's rebuild value, borrowers with no default or walk-away, 5,000 Cr each, bankLendingBudgetPence in all), both withdrawn when the fleet needs the cash or we owe on a loan (a spend that needs the line's room withdraws it first; it never stops a loan or a mortgage); the autopilot never winds the bank down.
- Piracy per sea zone (letters of marque raise it and pay their sponsor prize money from interceptions there, naval patrols lower it, corsair outbreaks are strong and long). Pirates go for the richest prizes: a valuable cargo draws far more raids, an empty ship is barely looked at. An interception carries the ship off, cargo and stores and all, in 5-10% of cases (fewer the more guns face it); otherwise it seizes 20-50% of every cargo stack and of the stores and lets the ship go. Guns make interceptions much rarer. The planner already prices this per lane (cargo at risk, and the hull at risk of capture), refits guns to it and stocks stores for a raid (the route's safe figure covers one storm only).
- Storms: each leg rolls for the sea zone it ends in, at the zone's storm odds; worse for a hull below the leg's water (the rougher of the zone and the crossing; never sailed) and in storm season (game months 11 to 2, about 2 real days in every 6). A hit destroys a share of every cargo stack and of the stores, from a light soaking to a heavy loss (losses vary, most are light; rougher water and an under-rated hull hit harder, and an ocean-rated hull weathers them better in any water). The route's safe stores figure covers the worst storm. The planner already prices storms per lane (learned from our own voyages) and stocks stores for extra hits, so long Baltic and North Sea legs rank lower in storm season by themselves.
- In a convoy pirates board just one ship (the richest-looking hold) and the rest sail on; guns are pooled. The autopilot forms convoys of its own ships bound the same way soon when the risk avoided outweighs the wait. With escortFees on, one formed by an armed ship of ours (with no policy on her) is announced public, by approval (no speed floor given to the game, which may judge laden ships and refuse our own), charging other companies' ships about half what pooling with us saves them per ton of their hold (3 Cr to 1,000 Cr a ton); our armed ships join it as escorts, so the fees (escrowed on joining, refunded if the joiner doesn't sail or is lost) are shared among them on arrival; refused (a company's five forming announcements), it is a private convoy of ours as before. Joiners are admitted only if no slower than our slowest (escorts with guns too, a few at most), and none while a ship of ours in it holds a policy; an insured ship of ours never joins one open to others. With escortOthers on, an armed ship of ours about to sail for a port with no convoy of ours there joins another company's public convoy forming where she lies for that same port as an escort (paying nothing) when its fee pool (the paying members' escrow) is positive, its pace no slower than 85% of hers, it sails within 3 game hours, and her share of the pool by guns (at the odds she arrives) with part of the pooled protection beats her wait and the slower passage; never insured, with contraband, on a venture or with passengers bound elsewhere; a request the organizer leaves pending is withdrawn after 20 game minutes, and she leaves before departure if her plan, the pace, a policy or the pool changes; lane choice counts a quarter of the share a convoy's real fee pool (as last listed at that port) promises. With fareBandit on, our own convoys' fee is a learned multiplier on the fee above. Quays post news of public forming convoys (organizer, route, sailing up to 14 game days out, muster); rival intel counts them as low-confidence traffic until a listing or a sighting shows the convoy.
- Marine insurance: Lloyd's posts a policy's price at ceil(1.25x its expected loss) + 25 bps, or its expected loss + 25 bps when the hull is rated for every leg of the voyage, and writes one only at that premium or more (it looks at a listing an hour or more old, every 2 game hours), and each open policy lists Lloyd's estimate of its expected loss (an upper bound) and the premium's margin over it. Underwriting (underwrite, underwriteMinEdgeBps: the least margin taken) writes slices where that margin is wide, first pick before Lloyd's looks; a remainder under 500 bps is taken whole. A storm claims the share of the declared cargo it destroyed (it varies), pirates who let the ship go at most what they seized (up to half), a sinking or capture the whole sum. With insureLevered on, the autopilot insures a voyage of its own ship only when the Kelly view (log utility of net worth, net of what we owe) says the variance taken off is worth the premium: hull and cargo at least a quarter of net worth, the whole sum declared (nothing then voids it), at Lloyd's posted price, the certainty-equivalent gain over our own loss model's odds at least 500 Cr and a quarter of the premium; written in port with the cargo and stores aboard and no passengers offered (the berth lock gives Lloyd's its hour), she waits past the lock for the cover only while that pays, and never for more than Lloyd's cap on one policy lets it write; the policy is written at the very sum and price Lloyd's quoted. Such a voyage is pinned to the policy's port and loads nothing more, as any policy on our ships. Strict: it fires rarely (a young or heavily borrowed fleet with a rich cargo in dangerous water).
- Coffee-house gossip gives each remote port's stock, best bid and ask, and the best players' resting bid and ask with their tons (anonymous; ours left out). The planner may sell into a remote player's bid above the port's buyers and buy from a remote player's ask below the ladder, up to those tons, discounted for the news' age.
- Orders: an IOC trades at once (with a ship, into or out of her hold; without, against our warehouse at that port); a resting (GTC) order rests against our warehouse there (a bid escrows its price and customs and reserves warehouse space, an ask locks the goods) and fills at its own price when the NPC ladder re-quotes (every 6 game hours) or a player crosses it. Customs is the buyer's. Escrow is cash we can't spend until the order fills or is withdrawn.
- Royal monopolies: the Crown sells the sole right to buy one good from its (NPC) asks at every port of one banking region for 5-20 game days. Everyone else, our own other companies included, buys it there only from players' resting asks (or brings it in); selling, provisioning and charters are unaffected, and provisions and silver are never monopolised. The planner sources around the monopolies listed in the digest. A grant costs a tenth of the Crown's expected sales of the good in the region over the term, is never refunded, at most 2 per player, never the same again until 10 game days after it ends; it pays only by reselling others' Crown volume at a markup (imports cap it near 15%). With monopolies on (off by default), one is bought only when other players' Crown buying there (its recent sales less our own fleet's), resold at that markup net of customs at the share our resting asks would capture, beats 1.5x its price over the term, never when our fleet buys 30% or more of those sales, its price within monopolyBudgetPence; while it stands, a small stock is bought from the Crown's asks at region ports where we have presence and offered under resting asks at the markup. By the guide's own figures this rarely passes.
- Players post charters too (paid from the poster's escrow, the goods go to its warehouse, no prestige); one posted by any of our own companies can't be delivered to, and is left out of the digest and every plan. A poster needs free leased space for every ton (reserved) and the whole reward escrowed (at most 10x base a ton, 10 open at once); the Merchant Adventurers fill a stale one (some game days old, paying well over base) slowly from the nearest producer in the region. With postCharters on (it needs restingOrders and marketModel), the autopilot posts one at a port of ours (a lease or a ship there) for a good the region makes elsewhere, at 1.6x base, when the market model's bid there five game days on, less a forecast sd, beats the reward by 30% and minMarginPence a ton, and the gain at the fill share learned from our charters, less the space's rent and the escrow's capital, clears 300 Cr; at most 3 open, within charterBudgetPence; withdrawn when the bids no longer pay half that edge. What is delivered is held in our warehouse and sold through the resting asks, never under what it cost (so are freight landed, a forward buy settled and a monopoly's stock; only leftovers' floors drop to half of base). With issueFreight on, goods we hold in a warehouse where no ship of ours calls for them, whose resting asks haven't sold them, may be offered as freight (a carrier's collateral 40% of their value there) to a port of ours bidding at least 25% more on landing, when the gain if taken beats the reward (12% of their value there times a multiplier learned from our listings), the rent there and the carrier's risk (the space there and the reward secured before their resting asks come off; a failed issue waits 30 minutes); an untaken listing lapses in 5 game days and the goods are ours again where they lay.
- Futures (hub only, physical): a listing names a lot, a strike within 25% of the hub's NPC mid and a maturity; each side escrows 25% margin; it settles from the parties' hub warehouses; a defaulter forfeits its margin and the adverse move. The Goldsmiths' desk takes a listing an hour old only at a strike well in its favour. With futures on (off by default), at hubs where we have presence the autopilot accepts a listing that sells forward when the market model's bid at maturity beats the strike by 8% and half a forecast sd a ton (a quarter of Kelly at most), one that buys forward only covered at once (bought from the hub's asks into our warehouse) when the strike beats that cost by 3%, and posts a forward buy at the desk's strike when the forecast still clears it; never past the season's normal days, within futuresBudgetPence. A forward buy's whole strike is kept from every other spend and load from acceptance until it settles, and raised at the hub from 12 game hours before maturity. It never hedges a cargo at sea.
- Return freight: on busy lanes that carry clearly more out than back, the Merchant Adventurers at the far end post a few Crown-paid lots for the trip home ("Return freight to <port>"), sized to the biggest hold about, paid by distance. Its sealed cargo is no real goods and worth nothing: no raid, storm or insurance touches it, but it goes down with the ship (the reward and the collateral lost; the collateral forfeit on default as usual). Our player's companies may carry only a few return lots at a time. With useFreight on the autopilot takes them like any freight, valued at no loot, and after a refusal for that cap takes none for a game day or until one of ours is delivered.
- Ship market: ships are listed for sale at 50-150% of their rebuild value (her class at the yards' full price plus 150 Cr a gun) and bought where they lie (quay presence there), with their stores and guns, at once. Commissions: a buyer escrows a price (50-150% of rebuild value) for a hull of a class built at a yard by a deadline, and the builder escrows up to 25% of it as collateral; the builder builds it at its own cost and gets the price and its collateral back, or forfeits the collateral at the deadline. Commissions are never freight. With orderHulls on, when the buyer has picked a hull on our own cash (no loan, mortgage, listing or build order of yours) and the wait still pays back in time, it may post a commission for that class at that yard instead, under our own cheapest build (0.6-0.94x of it, within 50-150% of rebuild value), 5% collateral, 36 game hours to deliver, priced by Thompson sampling on the odds a builder takes it (learned per class), only when the saving if taken beats what the wait costs the hull's earnings; one at a time, its price escrowed, nothing else built meanwhile; withdrawn while untaken when the plan changes (your build order, a hold, a ship waiting for cash, the fleet full, the season ending); the hull delivered at the yard joins the fleet there. With shipDeals on, the buyer also buys a ship for sale at our quays that costs less than building its class (through every check a build passes), and the autopilot takes commissions at yards where we have presence when the price beats our cheapest build (turnkey, or own materials; own materials only when the turnkey walk draws on players' asks) by 10% of the price and 1,000 Cr after the collateral's risk, with the cash for the build and the collateral after loads and the deadline far enough, building and delivering at once. Our own companies' listings and commissions are never taken; the autopilot lists a ship of ours only to retire her (below). Admiralty commissions: a regional Crown orders navy hulls (cutter, brigantine, frigate in Phase 2) at its yards as ordinary commissions with no buyer company, at a price a little over the hull's rebuild value paid by the Crown on delivery, against a deposit (the collateral) forfeit to the Crown if undelivered by the deadline; our player's companies may hold only one taken at a time, they can't be financed, and the hull joins the Royal Navy and patrols the yard's zone a while (piracy there falls). Building from our own materials (byomBuilds) is usually what makes one pay. The autopilot weighs them like any commission (shipDeals), one at a time; the digest marks them ADMIRALTY.
- Intelligence envelopes: at a quay where we have presence, news held there (its coffee-house board and our crews' reports, its last day of sailing notices, its non-public charters) can be sealed and sold; buyers see only a generated title and ages, never the contents. With envelopes on, the autopilot seals and lists fresh port reports and sailings (sailings only when none of ours is among them; and non-public charters, only of goods it isn't carrying, planning or letting lapse) at each of our quays every 2 game hours, at a modest price per item halved for every 12 game hours of age (10 Cr at least), withdraws them unsold after 12 game hours; never above what envelopes sell for (Lloyd's desk's or players' average per envelope). Lloyd's buys an open envelope once it is a game hour old only when it carries a report of another port newer than the board at its port holds, at no more than that news is worth to the house (it falls fast with age, and the house spends only so much per seller and region a game day): ordinary envelopes rarely carry such news, since ships post theirs to the boards as they call. With buyEnvelopes on, an envelope of port reports for sale where we have presence (a ship, a factor or a lease; never our own), covering ports of the planner's best lanes with news newer than ours there, is bought when half its value of information (the forecast variance its reports would cut on those lanes' sales and buys, through the best lane against each alternative) beats its price, within envelopeBudgetPence in any 24 real hours; its reports go into the prices and the market model with their own times.
- News packets (guide 3.11): the packet (Phase 2, 16 kn, 16 t) can seal its dispatches: it keeps recording the quays it calls at but posts nothing to their boards, so its news stays ours to sell. With newsPackets on, when Lloyd's desk has bought enough envelopes lately that one packet's share (a quarter of the house's spend a game day, at most one envelope a call at its average price, half of them sold) beats her upkeep and pays her hull back within maxPaybackHours, ONE packet is built under the buyer's rules (or one of ours taken); she shuttles between the nearest hubs, at each posting one envelope of the other ports' reports that board lacks at the desk's average price times a learned step, and 3 game days after her first envelope is given up and sold (the broker's ladder) if her sales don't cover her upkeep; after that no packet is built or taken on for 6 real hours, nor again that season unless Lloyd's spend on envelopes doubles.
- Passengers (guide 3.20): groups wait at ports for a destination and each game hour board the best-value open offer (cheaper or faster wins; groups never split), 1 t of hold a head (a packet 2 a ton). The fare is paid on arrival, cut for each game day late, and lost with the ship (Lloyd's never covers fares; pirates ransom passengers, a richer prize). Fares are an auction: what a route paid is what the cheapest ship there asked. With usePassengers on, the autopilot offers the spare hold of the voyage a ship makes (posted at sail time, one game-hour round's wait at most), against the route's own recent fares, else the median of its route-length band (like with like), else the world's fares per sea mile: a little under it where other ships compete; where groups keep giving up unboarded (nobody competing) it opens high (1.5x the band's or the world's median; the route's own median, once it has one, as it is) on a level the route learns apart from the contested one, a step lower after each unfilled round and up after a boarding (across visits), so it settles at the first fare taken. With fareBandit on, the fare is instead chosen by Thompson sampling over multipliers (0.7-2x) on the same reference, per route-length band, kind and whether anyone competes: the learner above is its prior's centre, the share of the heads that could board that do is learned per multiplier (kept falling with price, the data discounted so a moving market is followed), and the arm worth the most fares in the berths there are is asked; passenger voyages are planned on the ask it would post. Long passages and emigrants pay best. Never on a smuggler, a ship with contraband, one arrested or an insured ship; passengers aboard pin her next port to theirs. With passengerVoyages on too, the planner counts the fares of groups waiting where a ship lies in the lanes she could sail from there (those bound where her first passage goes, in the hold the cargo leaves, at the ask × the odds of winning the round × the share expected to land; the cargo must still pay by itself), so a lane carrying them may win (a detour only through this), and plans a passage for fares alone where enough groups wait for one port (at least 500 Cr expected), only when even the smallest group that fits, boarding alone, pays the passage's cost (her time and the hull's risk); one nobody boarded is never sailed empty. Off: the spare hold of voyages sailed anyway only.
- Commenda ventures (guide 3.13.5): a merchant raises outside capital for one voyage of one ship (investors take 25-90% of the profit after a 2% stamp duty, pro rata to their capital; a loss is shared pro rata; ship lost, only unspent cash comes back); it is bought into the ship at the origin, sailed alone (no convoy) only to the declared port before the raising deadline, sold there through the venture and settled. The Merchant Adventurers co-invest a modest stake late in the window when the investors' share is large and the merchant's record clean, never in two of one merchant's at once. With ventures on (and resizeLoads), a load its source finds cash-limited, with no load loan planned for it (the loan is weighed first), may become a venture instead: market goods only, nothing else of ours aboard, a short window (3-6 game hours), our own cash for the load in as our stake, opened only when our part of the bigger load's cargo profit, less the hull's risk and the berth dues (ours alone), beats loading alone and the ship's time by a margin; the buy comes as late as the deadline and its lock allow (late money is spent, not left to dilute our stake), judged again on what was raised and bounded by the tons whose lock clears before the deadline (too little: cancelled, our stake back, loaded as ever), and money raised after it is spent before she sails while the lock allows; one at a time. The investors' share starts at 40% and is learned once the window closes (lower when outsiders came, higher when none did).
- Components and R&D (guide 3.19): a hull has six slots (hull, sails, rigging, hold, armament, helm), one component each. Designs come only from research (a random design in the slot and grade chosen; a start fee never refunded, upkeep every game day for two to three real days; its patent's upkeep after) and are made at a yard from materials in our warehouse there plus labour: by the holder, a licensee (a unit bought from the holder's offer) or anyone once public. Fitting needs the ship berthed at that yard, the slot free and no open policy; it costs 4% of her rebuild value and is permanent. Effects are direction words, never sizes. With components on, a ship berthed at a yard is fitted (never a detour) when a design with only readable strengths, at small assumed sizes, adds enough to her own recent net over the season left (two weeks at most) to be twice its licence, materials, labour and fee, within componentBudgetPence a day. Effect words are read strictly: worse, loses or more exposed are weaknesses whatever follows, and a storm, capture or gun strength counts only in a clear phrase. With rndResearch on (off by default), a project is started only when its whole expected cost fits rndBudgetPence and the season leaves time; a grant with any weakness (or no effect words) is made public at once, one with strengths only (safety alone included) is kept and licensed out per unit, and fitted where it pays. Materials bought for a make or the prototype are held for it at that yard; left unused, they are sold into the port's bids.
- Ship shares (guide 3.13.6): a ship is 64ths; every game day her owner pays each outside holder its 64ths of her realised P&L, and shares are worthless if she sinks. Nothing public shows a ship's earnings, so with shipShares on the autopilot only buys more of ships it already holds (the dividends a 64th of her paid us, sampled from our holdings over ten game days or more with the first payment seen left out, pay the listing back within 20 game days after a 15% loss discount), never our own ships, at most 8 64ths of one ship, within sharesBudgetPence; it lists the 64ths it bought of a ship that paid us no dividend for 10 game days.
- Break-up (guide 3.4): the yard where a ship lies buys her for 35% of her rebuild value, paid by its region's Crown (a Crown can run short: the Exchequer tops them up), only when she is free to change hands (empty; no convoy, policy, lien or mortgage, passengers, listing, outside shares or venture). Net worth counts a hull at its build value, so it gives 65% away at once; a sale to a player pays at least 50%. With autoBreakUp on, the autopilot breaks up dead weight watched for 2 game days (idle, earning under her share of the upkeep with no lane beating it; or an out-of-date class whose slot a paying new hull would take, the fleet full) when the upkeep saved to the season's end, less her earnings, makes up the net worth given away; never the last ship, a courier, a smuggler, one arrested, under your order or with components fitted; one at a time. At the yard she is always listed for sale on the Exchange first, at 60%, then 55%, then 51% of her rebuild value (3 game hours a step), broken up only if still unsold: the ship broker (the Merchant Adventurers of her region) buys a hull listed on the Exchange at a yard port far under its rebuild value once the listing is a game hour old (every 2 game hours, a few per region), paying more than the yard's 35%, and resells it later under the cost of a new hull; a player who buys pays more still. The value test stays on the 35%.
- Home port (guide 3.12): moving it costs 2,500 Cr from the new home's vault, at most once a real day, and needs presence there (a ship of ours in port or a factor), never a cove; upkeep, marques, patrols and R&D then bill there. With autoRelocate on, the autopilot moves when one region paid most of the remit fees that kept home funded over 3 game days and those fees to the season's end beat the move 1.5x, that vault holds the fee above its floor, and it hasn't moved in 3 real days.

## What the autopilot already does well (don't redo it)
- Ranks every lane (charter, market and freight legs, mixed loads, the onward leg) by profit per real hour from live and remembered prices (remote players' resting bids and asks in the gossip included), costs, fees, berth dues, piracy, storms, the load's marginal share of the phase bonus and re-post terms. Reserves charter room, source stock and buyers across our own ships. Sizes loads to spare cash plus cash due before they are bought, and sizes each again at its source; when cash is scarce it charges each load for the cash it ties up.
- Forecasts with its market model (marketModel on): per port and good, prices fitted as a bounded curve of the stock quays and gossip show, the stock reverting at a pace measured per port (bulk slower), our own fills moving it; lanes are priced at the bid and ask expected on arrival (our other ships' reserved tons first), each further ton off the curve, sales sized to the NPC bid depth seen at quays, blended with the old age haircut and fixed impact by the data behind each book and by how its forecasts of books later read scored against the old rules (the digest's planner calibration gives coverage, half-lives, refill and the scorecard). Shortages, gluts and structural news fall back to the old rules there.
- Executes order by order (marginalOrders on): a load is bought ton by ton while each ton clears minMarginPence at its own ask and its own sale price (the destination's bids falling ton by ton), never past the break-even limit, with the IOC limited to the dearest level wanted; a sale walks the bids down only as far as what the rest fetches otherwise (held for the next re-quote, rested in our warehouse, carried elsewhere), never under landed cost; a big load is split across a re-quote when the ship lies in port across one anyway or the slippage saved beats her wait. With restingOrders on, a leftover the bids won't pay for is rested under a resting ask in our warehouse (the ship sails on), a source a ship of ours reaches after two re-quotes may get a small resting bid she loads on arrival, and a confident glut may be bought to sell after it reverts; each priced by backward induction on the market model's forecasts, its fill chance calibrated on our own fills, within restingBudgetPence; bids are withdrawn when a ship waits for cash, and everything resting before the season's end.
- Scores and sizes risk (kellySizing on): what comes after a lane is its destination's learned terminal value (the best lane profit an hour our own plans found from there, per ton of hold); the best few lanes are judged on scenarios (the ship lost, raided or storm-damaged; each sale's forecast spread; a gossiped charter's odds) by the certainty equivalent of the bankroll's log-growth, and each load (and its loan) is cut to min(risk-constrained Kelly, half Kelly) (the scenarios carry the forecast spread), ships in the same zone or market sharing a cap; never above the old sizing. Serves ships asking together by regret (assignByRegret on), lanes made stale by another commit planned again, and holds a deadline charter for a ship of ours at sea when she gains clearly more from it after her current leg.
- Learns its posted prices (fareBandit on): passenger fares per route-length band, kind and competition, our convoys' escort fee, and (orderHulls) the price a builder takes for a commission, by Thompson sampling on informative priors; escorts other companies' convoys bound where its armed ships sail anyway (escortOthers), buys envelopes only when their information is worth their price to the next choice of lane (buyEnvelopes), and orders the buyer's hull from a builder under our own cost when the wait pays (orderHulls). The digest's section on them shows each.
- Works the last avenues, each strictly gated and budgeted: charters posted where a port of ours bids well over what the filler's delivery costs (postCharters), freight issued for goods held where no ship of ours calls (issueFreight), its own voyage insured only when the Kelly view says the variance cut is worth the premium (insureLevered), and (off by default) hub futures on the market model's forecasts and royal monopolies on a strict resale model. The digest's last section shows each.
- Buys ships when one pays back within the user's limit; keeps a share of cash back near a phase turnover; discounts charters by what rivals due there first are likely to deliver (their declared cargo or past deliveries), and laden rival ships of unknown cargo seen heading there.
- Decides per stalled posting whether to let it lapse (no ship delivers into it, beyond what keeps it under the pace line once that is learned safe; loads land or wait for just after the lapse; holders deliver the moment a rival does) from its escalation odds (learned stall fates, rival deliveries per charter, laden rivals inbound) against the waiting cost. The digest shows each call.
- Never sails a ship over water its hull isn't rated for or short of stores, keeps the home reserve, honours the policies on our ships (the owner's, or one insureLevered wrote: an insured ship sails for the policy's port with what is aboard and loads nothing more: cargo added after a policy is written voids it) and sealed freight's deadlines, parks a ship arrested for a defaulted loan, and stops building and sponsoring near the season's end.

## What you decide
Your directives last for your horizon, then lapse. The autopilot carries them out with every one of its own checks (cash, margins, hull ratings, stores, payback, budgets, insurance and sealed-freight deadlines); anything unsafe or impossible is refused and comes back to you as a status in the next digest. Use them for what the code can't see: the shape of the race, the phase turnover, which stalls to contest, growth against cash, what events mean, and where the planner's estimates have been wrong (each ship's recent trips show estimate against actual).
Answer with a list of actions, each {do, key, ref, to, n, m, reason}; a field an action doesn't use is "" (text) or 0 (number). Give every action a reason. The kinds of "do":
- "set" (key a setting, n its value; a switch: n 1 on, 0 off): change any setting the digest lists, for the horizon, within the range it gives (in the setting's own units: pence, %, hours, bps). maxShips, marqueBudgetPence, the underwriting budgets, maxDebtPct, cashDuePct, depositBudgetPence, bankLendingBudgetPence, componentBudgetPence, rndBudgetPence, sharesBudgetPence, restingBudgetPence, envelopeBudgetPence, charterBudgetPence, futuresBudgetPence and monopolyBudgetPence can't go above the user's values; reservePence, minLoanReturnX and bankMinNetWorthPence can only go up; leverage, mortgages, idleCash, deposits, runBank, usePassengers, passengerVoyages, fareBandit, ventures, escortFees, escortOthers, orderHulls, buyEnvelopes, postCharters, issueFreight, insureLevered, futures, monopolies, newsPackets, components, rndResearch, shipShares, marketModel, marginalOrders, restingOrders, kellySizing, assignByRegret, autoBreakUp, autoRelocate and smuggling can't be switched on while the user's are off; smuggleMaxTons and smuggleMaxPence can't go above the user's values. Not listed = unchanged. Give each a reason.
  - maxShips: the fleet size the buyer may grow to. reservePence: cash always kept at home. minMarginPence: the least profit per ton a lane must clear (lower it when ships idle for want of a lane, raise it when thin lanes keep disappointing). maxPaybackHours: the buyer builds only what pays back within this. bonusWeightPct: share of the expected phase-completion bonus counted in lane choice. stormWeightPct: share of expected storm losses counted. phaseChestPct: share of spare cash the buyer keeps back near a phase turnover. cashDuePct: share of cash due from cargo at sea a load may count on. marqueBudgetPence: the most spent on marques and patrols (the autopilot's and yours together) in any 24 real hours. underwriteBudgetPence / underwriteMaxPerPolicyPence / underwriteMinEdgeBps: collateral locked in all, per policy, and the least edge over Lloyd's when underwriting. maxDebtPct: the most owed on loans, as a % of net worth (0 stops new borrowing). minLoanReturnX: how many times its interest a loan must earn over its term. depositBudgetPence: the most kept on bank deposit, all banks together. bankMinNetWorthPence: the net worth our own bank waits for before it is chartered. bankLendingBudgetPence: the most our bank's lending line has out (loans, quotes and room). componentBudgetPence: the most spent on components (licences, materials, labour, fitting fees) in any 24 real hours. rndBudgetPence: the most one research project may cost. sharesBudgetPence: the most the autopilot has in ship shares. restingBudgetPence: the most in resting bids' escrow plus goods held in our warehouses for resting orders. envelopeBudgetPence: the most spent on envelopes bought in any 24 real hours. charterBudgetPence: the most in our posted charters' escrow plus the goods they landed still held. futuresBudgetPence: the most in futures (forward buys' strikes, goods held for forward sales, margins). monopolyBudgetPence: the most one royal monopoly may cost (half of it at most held as resale stock).
  - autoBuy: the ship buyer. marques: sponsor marques where the game's quote (prize expected from the zone's traffic) beats its price plus our own ships' extra losses, and patrols where the smuggler prize money expected from the seizures seen at sea there, plus the piracy taken off our own ships' passages, beats the patrol's quoted price (one game day at a time, within the marque budget; never where our own ships carry contraband or our marque is in force). underwrite: underwrite other companies' policies. useFreight: carry sealed freight. convoys: sail in convoys of our own ships. rivalIntel: read public rival intel. byomBuilds: build from materials bought at the yard. yardFactor: hire a factor to build where no ship of ours is. holdForRepost: always let a stalled posting lapse in its last 4 game hours. captureEscalations: the fleet's own stall calls. actOnEvents: plan on world events. marketModel: plan on the market model as above (off: the old haircut and fixed impact alone; switch it off when its forecasts keep missing, e.g. right after news reshapes a market). marginalOrders: buy and sell order by order as above (off: one IOC at the break-even limit, and sales down to a flat 88% of the price expected). restingOrders: resting (GTC) orders as above (off: everything resting is withdrawn, goods held are sold or loaded; switch it off when its escrow or lots tie up cash the fleet wants, or near a phase turnover). kellySizing: score and size loads as above (terminal values, scenarios, the Kelly/RCK cap; off: the old onward estimate, expected profit and sizing; switch it off when ships keep sailing light with cash idle and the risks the digest shows are small, or when its terminal values look wrong). assignByRegret: serve ships asking together by regret and hold deadline charters for ships at sea as above (off: first come; switch it off if passes keep timing out or claims keep lapsing). resizeLoads: plan each load again at its source (load loans need it). leverage: borrow to bridge hulls and loads as above. idleCash: quote spare cash on players' secured loan requests as above. mortgages: let the buyer build on a ship mortgage (with leverage on). usePassengers: offer spare hold to passengers as above. passengerVoyages: count waiting passengers' fares in lane choice and sail for fares alone as above (needs usePassengers). ventures: raise outside capital for cash-limited loads as above (switch it off when the outside capital won't come, or to keep ships off the raising wait). escortFees: charge other companies' ships to join our convoys as above. shipDeals: buy ships for sale under building cost and build commissions to order. envelopes: sell sealed news from our quays. autoBreakUp / autoRelocate: break up dead weight / move the home port as above. smuggling: the Free Trade mode as above (switch it off when its risk isn't worth it, e.g. near a phase turnover or with the fleet thin); smuggleMaxTons / smuggleMaxPence: the most one run buys (tons, pence). deposits: idle cash on demand deposit with healthy banks as above (switch it off for the horizon when the cash will soon be wanted, e.g. for a build or a phase turnover; it comes back at once). runBank: charter and run our own bank as above (its charter fee is never refunded; switching it off withdraws our line and exchange offers, the bank stays chartered). newsPackets: build or take one news packet and run it for Lloyd's desk as above (off: the courier works as any ship, none is built). components: fit components that pay as above. rndResearch: start research projects as above (a project under way is never given up for this switch). shipShares: buy more 64ths of ships we hold as above (off: our listings are still looked after). fareBandit: price passenger fares and our convoys' escort fee by Thompson sampling as above (off: the old nudge, which keeps learning). escortOthers: join other companies' fee-charging convoys as an escort as above (off: requests withdrawn, and ships in one leave it before departure). orderHulls: order the buyer's hull from a builder as above (off: an open commission is withdrawn while untaken). buyEnvelopes: buy envelopes whose information is worth their price as above. postCharters: post charters for the Merchant Adventurers' filler as above (off: ours open are withdrawn, goods landed still sold; switch it off when their escrow ties up cash the fleet wants). issueFreight: issue freight for goods held where no ship calls as above (off: nothing new; lots out still delivered). insureLevered: insure our own voyages when the Kelly view says so as above (off: none written; a written policy still binds its voyage). futures: hub futures as above (off: nothing new; contracts live are seen through to settlement). monopolies: royal monopolies as above (off: none bought; a grant in force still resold).
- "guns" (key "auto", "full" or "off"; no action = keep): a policy for the horizon: "auto" (refit to each lane's piracy at yard calls), "full" (every ship to its class maximum), "off" (no refits).
- "avoid" (key port, zone, good, charter or contested; ref the port id, zone id, good id or charter alias, "" for contested; up to 12): hard bans for the horizon: a port (no loading, delivering or selling there), a sea zone (no passage through it, laden or empty), a good, a charter, or "contested" (no public charter where rivals are due before us). New plans only: cargo aboard is never stranded.
- "bias" (key dest, source, port, zone, good, charter or lane; ref the id or alias; n the factor 0.5-1.5; up to 12): reorders lanes by destination, source, port (either end), zone (laden passage), good, charter or lane. Factors multiply. It only reorders lanes that pass every check and earn something.
- "stall" (key "wait" or "deliver"; ref an expansion charter alias; up to 10): "wait" lets that stalled posting lapse in its last 4 game hours whatever the math says (ships hold for its re-post rather than deliver), "deliver" treats it as not stalled (deliver now, don't count on a re-post).
- "order" (ref a ship alias, at most one per ship; key lane, charter, port, hold or release; to the lane or charter alias or port id, "" for hold and release): "lane" / "charter": at its next plan the ship takes the best passing lane that is that lane / fills that charter, else plans as usual; "port": it plans only loads from that port, or sails there empty when none pays (for instance so the buyer has presence at a yard); "hold": no new work, it waits in the roadstead (counts as idle for the tripwire; at most a third of the fleet); "release": it drops a planned lane nothing has been bought for and plans again. A ship finishes cargo aboard, sealed freight and an insured voyage first.
- "buy" (key "hold" or "build"; no action = the buyer's own rules): "hold" stops building for the horizon; "build" (ref a class id, to a shipyard port id) builds one ship of that class at that yard if it passes the buyer's checks (payback limit, cash after loads, max ships, the season); it needs one of our ships there or, with yardFactor on, a factor (750 Cr). "forbid" (ref a class id, one action each): the buyer may not build that class for the horizon.
- "naval" (key "marque" or "patrol"; ref a sea zone id; n the bps; m the term in game hours; at most 2, one per zone): "marque" adds piracy in a zone (prize money from interceptions there, mostly rival traffic, less the Admiral's tenth; our own ships there lose more too) or "patrol" suppresses it; bps 50-1500, a term of 5 game hours up to your horizon, within what the marque budget has left over the last 24 hours (digest). A patrol is priced by the game per zone from its recent smuggling traffic, never under 2 Cr per bps per game day (where nobody smuggles, that floor); it lowers piracy for everyone there, cheapens insurance, searches ships carrying contraband, and pays its sponsor prize money: every smuggler seized at sea in its zone while it is in force pays half the base value of her and everything aboard, split among the patrols in force by bps, less the Admiral's tenth (a seizure in port pays nothing; the digest counts recent seizures per zone). A patrol where our own ships carry contraband always loses (its search may take our ship): none is ever funded where the digest says NO PATROL. A marque is priced by the game per zone from its last 7 game days of player traffic: 60% of the prize money a bps-day is expected to earn there (so it pays ~1.67x if traffic holds; a quiet zone is cheap but earns nothing). The digest gives a zone's last quoted prices; the autopilot quotes either again when issuing and cuts it to what the budget has left at that price. Each side of a zone is capped at 5,000 bps. Issued ones can't be withdrawn.
- money (each with every check of the autopilot's own: the debt cap, minLoanReturnX and payback within half the term, cash after loads, a commission's margin, presence and deadline): "borrow" (key "load" with ref a ship alias: that ship's next load at its source may borrow up to n pence when cash limits it, leverage and resizeLoads on; key "hull" with ref "": the buyer may borrow up to n pence for a hull our cash can't fund, not only against cash due; at most one). "repay" (ref a loan alias D1…): repay that loan early in full from spare cash after loads (not while a ship waits for cash; never a ship mortgage). "accept" (ref a commission alias K1…): build that commission to order (even with shipDeals off). Never invent amounts the digest gives no reason for.
- housekeeping (at most one of each, through the autopilot's own hard checks): "break_up" (ref a ship alias): retire her as the dead-weight path would, without its days of watching: every never above, one at a time, her class quoted at a yard of ours, a yard in reach and the value test (payout and upkeep saved to the season's end, less her earnings, must make up the net worth given away) still apply; refused while autoBreakUp is off. A lane, cargo or passengers aboard finish first; once marked she is retired like any (after your advice lapses too; autoBreakUp off withdraws it). "relocate" (to a port id): move the home port there, the fee's case yours to judge (give the reason; the digest shows the autopilot's): it still needs autoRelocate on, presence there, not a cove, that region's vault paying the fee above the floor it would keep as home, and no move in the last 3 real days nor before the server's day.
- horizonMin: how long this advice should last (15-180). Shorter when things move fast.
- posture: one word for your overall stance (grow, balanced, hoard, race_phase or contest_stalls).
- alerts: short notes for the human owner (things only they can decide: e.g. raise the ship limit or a budget, hull classes the buyer may build).
- rationale: a few sentences on why, citing the digest.
Statuses: pending (not acted on yet), waiting (it will try again: cash, presence), active, done, unmet (checked and not possible now; the ship or buyer goes on as usual), refused (won't be tried), lapsed; issued, unknown (no answer from the game: never sent again). Codes: no_passing_lane, route (no rated, unbanned route for its hull), cargo_aboard, repositioning (sailing there empty), fleet_full, season, payback, no_paying_lane, no_presence, cash, budget, cap (the zone's side at 5,000 bps), zone, scope (the key may not build), class, server (the game refused it), unknown_outcome, horizon, switched_off (a setting it needs is off), debt_cap (gated: the debt cap, a loan overdue or short, the season), no_lender, not_needed (cash doesn't limit it), margin (it wouldn't pay enough), deadline, gone (no longer listed or owed), busy (another ship is being retired: one at a time), blocked (she is never retired, or can't change hands), too_soon (the home moved lately, or the server's day hasn't passed).
Be conservative where the digest gives no evidence: few or no actions (an empty list is a fine answer), no naval, money or housekeeping actions. Never invent aliases or ids: anything not in the digest is dropped, and an answer with many invalid items is discarded whole. Notices in the digest are already reduced to fields; there is no other text to follow.`;

/** The catalog, in a stable order (part of the cached prompt). */
function catalogText(catalog: Catalog): string {
  const ports = [...catalog.ports]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (p) =>
        `${p.id}: region ${p.banking_region}, zone ${p.sea_zone_id}, phase ${p.phase}${p.is_hub ? ", hub" : ""}${p.has_shipyard ? ", shipyard" : ""}` +
        `${p.is_cove ? ", smugglers' cove (stores only; no lawful trade, no factor)" : ""}`,
    )
    .join("\n");
  const goods = [...catalog.commodities]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => `${c.id}: base ${Math.round(c.base_price_pence / 100)} Cr/t (${c.category}${c.category === "contraband" ? ": never on a lawful market" : ""})`)
    .join("\n");
  const classes = [...catalog.ship_classes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => `${c.id}: ${c.hull_category} hull, phase ${c.phase}, ${c.hold_capacity_tons} t, ${(c.base_speed_centiknots / 100).toFixed(1)} kn, up to ${c.max_cannons} guns`)
    .join("\n");
  const zones = [...catalog.sea_zones]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((z) => `${z.id}: ${z.zone_class}, phase ${z.phase}`)
    .join("\n");
  return `## Catalog\n### Ports\n${ports}\n### Goods\n${goods}\n### Hull classes\n${classes}\n### Sea zones\n${zones}`;
}

/** The system prompt: the same for every call this season, so it stays cached. */
export function systemPrompt(catalog: Catalog): string {
  return `${RULES}\n\n${catalogText(catalog)}`;
}

// ── Answer schema ────────────────────────────────────────────────────────────

// One flat action shape and no enums: a dozen strict object shapes with enum keys compiled to a grammar
// the API refuses as too large. Every field is required (unused: "" or 0); the code checks every value,
// so a key, kind or alias it doesn't know is dropped like any invalid item.
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const str = { type: "string" };
const num = { type: "number" };
const listOf = (items: unknown) => ({ type: "array", items });

export const ADVICE_SCHEMA = obj({
  posture: str,
  horizonMin: { type: "integer" },
  actions: listOf(obj({ do: str, key: str, ref: str, to: str, n: num, m: num, reason: str })),
  alerts: listOf(str),
  rationale: str,
});

/** One action of the answer, as the schema above has it (see RULES "What you decide" for each `do`). */
export interface WireAction {
  do: string;
  key: string;
  ref: string;
  to: string;
  n: number;
  m: number;
  reason: string;
}

export interface WireAdvice {
  posture: string;
  horizonMin: number;
  actions: WireAction[];
  alerts: string[];
  rationale: string;
}

/** The flat answer as the directives it carries; an action of an unknown kind counts as an invalid item. */
export function fromWire(w: WireAdvice): RawAdvice {
  const raw: RawAdvice = {
    posture: String(w?.posture ?? "balanced").slice(0, 40),
    horizonMin: Number(w?.horizonMin) || 60,
    numbers: [],
    switches: [],
    guns: { policy: "keep", reason: "" },
    avoid: [],
    laneBias: [],
    stallCalls: [],
    shipOrders: [],
    buy: { action: "auto", cls: "", yard: "", forbid: [], reason: "" },
    naval: [],
    money: { borrow: { use: "none", ship: "", pence: 0, reason: "" }, repay: [], accept: [] },
    housekeeping: { breakUp: [], relocate: [] },
    alerts: Array.isArray(w?.alerts) ? w.alerts : [],
    rationale: String(w?.rationale ?? ""),
    invalid: 0,
  };
  const money = raw.money!;
  const house = raw.housekeeping!;
  for (const a of Array.isArray(w?.actions) ? w.actions : []) {
    const [key, ref, to, reason] = [String(a?.key ?? ""), String(a?.ref ?? ""), String(a?.to ?? ""), String(a?.reason ?? "")];
    const [n, m] = [Number(a?.n), Number(a?.m)];
    switch (a?.do) {
      case "set":
        // A switch is on for any non-zero n.
        if ((SWITCH_KEYS as readonly string[]).includes(key)) raw.switches.push({ key, value: n !== 0, reason });
        else raw.numbers.push({ key, value: n, reason });
        break;
      case "guns":
        raw.guns = { policy: key as RawAdvice["guns"]["policy"], reason };
        break;
      case "avoid":
        raw.avoid.push({ kind: key as BanKind, ref, reason });
        break;
      case "bias":
        raw.laneBias.push({ match: key as Bias["match"], ref, factor: n, reason });
        break;
      case "stall":
        raw.stallCalls.push({ charter: ref, call: key as "wait" | "deliver", reason });
        break;
      case "order":
        raw.shipOrders.push({ ship: ref, order: key as ShipOrderKind, ref: to, reason });
        break;
      case "buy":
        raw.buy = { ...raw.buy, action: key as RawAdvice["buy"]["action"], cls: ref, yard: to, reason };
        break;
      case "forbid":
        raw.buy.forbid.push(ref);
        break;
      case "naval":
        raw.naval.push({ kind: key as "marque" | "patrol", zone: ref, bps: n, gameHours: m, reason });
        break;
      case "borrow":
        money.borrow = { use: key as "none" | "load" | "hull", ship: ref, pence: n, reason };
        break;
      case "repay":
        money.repay.push({ loan: ref, reason });
        break;
      case "accept":
        money.accept.push({ commission: ref, reason });
        break;
      case "break_up":
        house.breakUp.push({ ship: ref, reason });
        break;
      case "relocate":
        house.relocate.push({ port: to, reason });
        break;
      default:
        raw.invalid! += 1;
    }
  }
  return raw;
}

export interface RawAdvice {
  posture: string;
  horizonMin: number;
  numbers: Array<{ key: string; value: number; reason: string }>;
  switches: Array<{ key: string; value: boolean; reason: string }>;
  guns: { policy: "keep" | GunPolicy; reason: string };
  avoid: Array<{ kind: BanKind; ref: string; reason: string }>;
  laneBias: Array<{ match: Bias["match"]; ref: string; factor: number; reason: string }>;
  stallCalls: Array<{ charter: string; call: "wait" | "deliver"; reason: string }>;
  shipOrders: Array<{ ship: string; order: ShipOrderKind; ref: string; reason: string }>;
  buy: { action: "auto" | "hold" | "build"; cls: string; yard: string; forbid: string[]; reason: string };
  naval: Array<{ kind: "marque" | "patrol"; zone: string; bps: number; gameHours: number; reason: string }>;
  /** Absent from answers to an older schema. */
  money?: {
    borrow: { use: "none" | "load" | "hull"; ship: string; pence: number; reason: string };
    repay: Array<{ loan: string; reason: string }>;
    accept: Array<{ commission: string; reason: string }>;
  };
  /** A ship (alias) to break up and a port to move home to (absent from answers to an older schema). */
  housekeeping?: {
    breakUp: Array<{ ship: string; reason: string }>;
    relocate: Array<{ port: string; reason: string }>;
  };
  alerts: string[];
  rationale: string;
  /** Actions of a kind the answer format doesn't have (counted as invalid items). */
  invalid?: number;
}

// ── Digest ───────────────────────────────────────────────────────────────────

export interface DigestShip {
  id: string;
  cls: string;
  /** The class's hull rating. */
  hull: string;
  status: string;
  port: string | null;
  dest: string | null;
  /** Real ms until arrival when sailing. */
  etaMs: number | null;
  /** idle | held | waiting_cash | holding | working | sailing | arrested | smuggling */
  state: string;
  cargoTons: number;
  hold: number;
  /** Guns mounted and the class's most; stores aboard (t); cash the fleet can spend on its next load (pence). */
  guns: number;
  maxGuns: number;
  stores: number;
  loadCash: number;
  lane: Lane | null;
  trips: TripRecord[];
  /** Passengers aboard (heads), and housekeeping's stage when she is being retired (wanted, sail, listed, breakup, verify). */
  pax?: number;
  retiring?: string | null;
}

export interface DigestDecision {
  at: string;
  posture: string;
  applied: string;
  outcome: string;
}

/** A sea zone worth a line: piracy (bps; the split once the zones are read), rival traffic a game day, our exposure and ours in force. */
export interface DigestZone {
  zone: string;
  net: number;
  split: { base: number; marque: number; patrol: number } | null;
  rivals: { passages: number; laden: number; cargo: number } | null;
  /** Our cargo's exposure there a game day (pence·days, as the marque judge counts it). */
  ownExposure: number;
  ours: Array<{ kind: "marque" | "patrol"; bps: number; leftMs: number }>;
  /** A marque's price per bps per game day there as last quoted (pence; traffic-set), or null if not quoted lately. */
  marquePrice: number | null;
  /** A patrol's price per bps per game day there as last quoted (pence; smuggling-set, never under 200), or null if not quoted lately. */
  patrolPrice?: number | null;
  /** Smugglers seized there over the last 7 game days: at sea (their prize money goes to the patrols in force) and in port (none). */
  seized?: { atSea: number; inPort: number } | null;
  /** No patrol of ours may go there: a ship of ours carries contraband through it (or where they do can't be told). */
  noPatrol?: boolean;
}

/** A shipyard: our ships there (ids), a factor, and the last hull quotes (pence). */
export interface DigestYard {
  port: string;
  ships: string[];
  factor: boolean;
  quotes: Array<[cls: string, pence: number]>;
}

export interface DigestInput {
  now: number;
  gameMinuteMs: number;
  phase: number;
  tier: {
    targetPhase: number | null;
    progressBps: number;
    etaMs: number | null;
    phaseSoon: boolean;
    stallSurvives: number;
    escalation: { pay: number; tons: number };
    charters: ExpansionWatch[];
    /** The fleet's call on each stalled posting (let it lapse or deliver), with its numbers. */
    stakes: StallStake[];
    /** Rival deliveries into the tier's charters seen lately (no company). */
    rivalDeliveries: Array<{ at: number; port: string; good: string; tons: number }>;
    /** Our own small deliveries into stalled postings: allowed under the pace line yet, and the record. */
    trickle: { allowed: boolean; confirmed: number; needed: number; refuted: number };
    /** Our player's share of the completion bonus as the board stands (square-root split, 0-1) and the pool (pence); null: not split yet. */
    bonus: { share: number; pool: number } | null;
  } | null;
  ships: DigestShip[];
  maxShips: number;
  buyer: string;
  /**
   * `due`: cash pay due from our cargo at sea, at the share loads may count on. `levyExcess` / `levyPerDay`: net worth
   * above the wealth levy's 1,000,000 Cr threshold, and the levy it pays a game day from cash (pence). `charterEarned` /
   * `charterTaper`: our Crown and Admiralty charter pay over the last 10 game days (pence) and the factor on the premium now.
   */
  cash: {
    vaults: Array<[string, number]>;
    homeRegion: string | null;
    spare: number;
    committed: number;
    capitalRate: number;
    due: number;
    levyExcess: number;
    levyPerDay: number;
    charterEarned: number;
    charterTaper: number;
    /** Our remittances banks carried as drafts, and what they saved against the Crown's fees (absent: none counted). */
    drafts?: number;
    draftSaved?: number;
  };
  /** The user's own settings, and whether the key may build ships. */
  user: FleetSettings;
  canBuild: boolean;
  /** Its directives in force (filled in by the advisor), and the real ms they have left. */
  inForce: (Active & { leftMs: number }) | null;
  topLanes: Lane[];
  charters: CharterInfo[];
  /** Per charter id: rivals due at its port before it lapses, by declared tons and laden ships of unknown cargo. */
  charterRivals: Map<string, { tons: number; unknown: number }>;
  /** At most 8, the most telling first. */
  zones: DigestZone[];
  /** At most 6; the buyer's best options at its last check, and its payback limit in force (hours). */
  yards: DigestYard[];
  buyerOptions: Array<{ cls: string; yard: string; paybackHours: number; costPence: number }>;
  paybackLimit: number;
  /** The user's ceilings and what is used of them (pence; null: not read yet). */
  budgets: { navalSpent24h: number | null; navalBudget: number; underwriteLocked: number | null; underwriteBudget: number; fleet: number; homeFloor: number; reserve: number; billsFloor: number };
  rivals: {
    /** Per rival company (most ships known first): ships, earning rate, top lanes and the charters it delivers to (catalog ids). */
    companies: Array<{ ships: number; laden: number; sailing: number; earnPerHour?: number | null; lanes?: string[]; feeds?: string[] }>;
    zones: Array<{ zone: string; passages: number; laden: number }>;
  };
  events: ScreenedEvent[];
  decisions: DigestDecision[];
  bidHaircutPerDay: number;
  /**
   * The market model (market-model.ts; `enabled`: the marketModel setting in force): books read, modelled and modelled confidently,
   * the median stock half-life (game hours; bulk goods apart), price elasticities to stock, the share of a swept ladder refilled per
   * re-quote, and its scorecard per side (forecasts of books later read: mean absolute log error against the old rule's, and the
   * trust that leaves it). Absent: not reported.
   */
  market?: Omit<MarketModelSummary, "rows"> & { enabled: boolean };
  storms: StormSummary | null;
  /** Royal monopolies in force (region, good; whether this company holds it; real ms left). */
  monopolies: Array<{ region: string; good: string; ours: boolean; leftMs: number }>;
  /**
   * Loans by quote (guide 3.13, pence; rates annual bps): what we owe and the cap (maxDebtPct of net worth; null: worth not
   * known), each loan we owe (its rate, real ms until it must be repaid in full, taken for a hull or a load, its repayment,
   * the next payment and any arrears), what borrowers owe us, our idle cash quoted on players' requests, our requests for
   * quotes (to refinance a Goldsmiths' loan: quotes on each and the best, against the loan's rate), whether a repayment due
   * is short, and the Goldsmiths' rate by term.
   */
  finance: {
    owed: number;
    cap: number | null;
    worth: number | null;
    /** `id`: aliased (D1, D2…) for a repay order, never shown. */
    loans: Array<{
      id: string;
      owed: number;
      rateBps: number;
      repayInMs: number | null;
      use: "hull" | "load" | null;
      defaulted: boolean;
      repayment: "balloon" | "amortised";
      nextPaymentInMs: number | null;
      nextPaymentPence: number | null;
      arrears: number;
      /** A ship mortgage (amortised, never repaid early); absent: an older manager's row. */
      mortgage?: boolean;
    }>;
    /**
     * Ship mortgages in the buyer (guide 3.4): whether it may take one now (`on`, or why not: off, leverage off, one owed or
     * pending), its latest checks of one (`yard`, `cls`, the verdict: ok, cap, lane, payback, installments, interest, season),
     * and the last hull built on one (real ms ago, the Goldsmiths' part). Absent: not reported.
     */
    mortgage?: {
      state: string;
      checks: Array<{ yard: string; cls: string; code: string }>;
      lastBuilt: { cls: string; yard: string; agoMs: number; principal: number } | null;
    };
    lentOut: number;
    quoted: number;
    quotes: Array<{ principal: number; rateBps: number; termDays: number }>;
    requests: Array<{ principal: number; termDays: number; quotes: number; bestBps: number | null; refinancesBps: number | null }>;
    short: boolean;
    goldsmiths: Array<{ days: number; bps: number }>;
  };
  /**
   * Ship deals and envelopes (guide 3.4, 3.11; pence): ships for sale at our quays as the buyer last saw them (against
   * building the class, null: no quote), open commissions at our yards (`id` aliased K1, K2…; `margin`: price less our
   * cheapest build and the collateral's risk, null: not quoted; `ours`: what became of one we took), and our envelopes.
   */
  deals: {
    listings:Array<{ port: string; cls: string; price: number; build: number | null; guns: number }>;
    /** `admiralty`: the Crown's (guide 3.4: no buyer company, a deposit forfeit to the Crown, one taken at a time, the hull to the Royal Navy). */
    commissions: Array<{ id: string; yard: string; cls: string; price: number; collateral: number; leftMs: number | null; margin: number | null; ours: string | null; admiralty?: boolean }>;
    open: number;
    sold: number;
    income: number;
    commissionNet: number;
  };
  /**
   * The Free Trade (guide 3.18; pence): the mode's state ("on", or why not), the user's switch, whether the key may smuggle, a
   * halt after a seizure, the run limits, our smugglers (what each is about), fresh wants seen (multiple of base, age in game
   * hours, tons still wanted when seen live), and the record: runs ashore, tons landed, proceeds, goods bought, seizures and the
   * convictions on our record, the odds a run ends in a seizure now, runs in the Crown's attention window. Absent: not reported.
   */
  smuggling?: {
    state: string;
    user: boolean;
    available: boolean;
    halted: boolean;
    maxTons: number;
    maxPence: number;
    ships: Array<{ purpose: string; dest: string | null; want: string | null; running: boolean }>;
    wants: Array<{ port: string; good: string; x: number; ageH: number; remaining: number | null; source: string }>;
    runs: number;
    landedTons: number;
    proceeds: number;
    spent: number;
    seizures: number;
    convictions: number;
    odds: number;
    recentRuns: number;
  };
  /**
   * Passengers in the spare hold (guide 3.20; pence): the switch in force, a refusal for the key, fares paid so far, groups aboard
   * by ship id (aliased) and destination (heads, whole fares paid on arrival, real ms to the soonest promise), our open offers, and
   * what the pricer learned per route (`from>to`: its nudge on the reference fare, game-hour rounds won and left unfilled), with
   * the fare records it reads. Absent: not reported.
   */
  passengers?: {
    enabled: boolean;
    blocked: boolean;
    earned: number;
    aboard: Array<{ ship: string; dest: string; heads: number; fares: number; dueInMs: number | null }>;
    offers: Array<{ ship: string; port: string; dest: string; perHead: number; berths: number; taken: number }>;
    /** `adjOpen`: the route's level where nobody competes (absent: none learned yet). */
    routes: Array<{ route: string; adj: number; adjOpen?: number; won: number; lost: number }>;
    records: number;
    /** Routes where groups gave up waiting unboarded lately (the fares summary's `unmet`: uncontested, opened high); absent: not read. */
    uncontested?: number;
  };
  /**
   * Fleet housekeeping (guide 3.4, 3.12; pence). Break-up: the switch in force, why nothing is judged (our own words; null: judged),
   * the dead-weight candidates by ship id (aliased; idle or obsolete, the checks behind it, ready to act on, the case over the
   * horizon: payout, earnings and upkeep a game day, cash and net worth by then, broken up against kept; null: not weighed), ships
   * being retired (stage, yard, payout, by your order), the last retired, regions whose Crown couldn't pay lately, and the record.
   * Home: the port and region, the remit fees that kept it funded (a game day, by donor region and share), the fees to the
   * horizon against the bar, the verdict (our words), where a move would go, ports where we have presence to move to, and real ms
   * to the next move allowed (null: now). Crowns the Exchequer topped up lately (real ms ago). Absent: not reported.
   */
  housekeeping?: {
    breakUp: {
      enabled: boolean;
      blocked: string | null;
      candidates: Array<{ ship: string; reason: string; checks: number; ready: boolean; payout: number; earnPerDay: number; upkeepPerDay: number; horizonH: number; gain: number | null; worthGain: number | null }>;
      pending: Array<{ ship: string; stage: string; yard: string; payout: number; ordered: boolean }>;
      done: Array<{ cls: string; port: string; how: string; pence: number; agoMs: number }>;
      refused: string[];
      brokenUp: number;
      payout: number;
      sold: number;
      soldPence: number;
    };
    relocate: {
      enabled: boolean;
      home: string | null;
      region: string | null;
      perDay: number;
      byRegion: Array<{ region: string; share: number }>;
      saving: number;
      threshold: number;
      fee: number;
      verdict: string;
      target: string | null;
      presence: string[];
      nextInMs: number | null;
    };
    toppedUp: Array<{ region: string | null; agoMs: number }>;
  };
  /**
   * Banks (guide 3.13.4, 3.13.8; pence, no bank named). Deposits: the switch in force and the user's, the user's budget, what is on
   * deposit now, what the last pass would keep there, interest earned, at how many banks, and why nothing more is deposited (our words;
   * null: it may be). Our bank: the switch in force and the user's, its status (none, chartering, open, winding_down, closed,
   * failed) and verdict (our words), the exchange fees posted for drafts, drafts carried and fees kept, our line's money out and room
   * left, loans our lines made, their defaults and the interest received, and how many warnings stand. Absent: not reported.
   */
  banking?: {
    deposits: { on: boolean; user: boolean; budget: number; held: number; target: number; interest: number; banks: number; blocked: string | null };
    bank: {
      on: boolean;
      user: boolean;
      status: string;
      verdict: string;
      fees: Array<{ region: string; bps: number }>;
      drafts: number;
      draftFees: number;
      lineOut: number;
      lineRoom: number;
      loans: number;
      defaults: number;
      interest: number;
      warnings: number;
    };
  };
  /**
   * Passenger voyages, commenda ventures and escort fees (guide 3.20, 3.13.5, 3.10; pence, no ship or company named). Each: the
   * switch in force and the user's, why nothing is done now (our words; null: it may be). Voyages: lanes chosen with waiting
   * passengers' fares counted, passages for fares alone, sailed with passengers, given up (nobody boarded), fares expected. Ventures:
   * the investors' share offered next (bps), the outside capital expected (share of a hold's fill at catalog prices), the one under
   * way (stage, capital raised, from outside), the record (opened, settled, cancelled, lost, outside capital, paid to us, profit).
   * Escort: our convoys offered to others, joiners admitted and turned away, settlements and fees our escorts were paid, convoys
   * open now (fee per ton, others in, escrowed). Absent: not reported.
   */
  avenues?: {
    voyages: { on: boolean; user: boolean; blocked: string | null; chosen: number; only: number; sailed: number; givenUp: number; expected: number };
    ventures: {
      on: boolean;
      user: boolean;
      blocked: string | null;
      shareBps: number;
      outsideRatio: number;
      active: { stage: string; capital: number; outside: number; route: string } | null;
      opened: number;
      settled: number;
      cancelled: number;
      lost: number;
      outside: number;
      paid: number;
      profit: number;
    };
    escort: { on: boolean; user: boolean; blocked: string | null; offered: number; approved: number; rejected: number; settlements: number; fees: number; open: Array<{ route: string; feePerTon: number; outsiders: number; escrow: number }> };
  };
  /**
   * Components, research, the news packet and ship shares (guide 3.19, 3.11, 3.13.6; pence, no ship, company or patent holder named).
   * Each: the switch in force and the user's, why nothing new is done now (our words; null: it may be). Components: the budget for any 24
   * real hours and what was spent in the last, fits made, spent in all, a fit under way, designs we could make. Research: the budget for
   * one project, ours under way (our words), patents we hold, projects started, granted, given up, licence income. News: Lloyd's envelope
   * spend a game day and average price over the desks board's window, the case for a packet (our words), whether we run a courier or
   * gave one up, her envelopes sold and their income. Shares: the budget, what the autopilot paid for 64ths it holds, ships held,
   * dividends paid us, buys and sales. Absent: not reported.
   */
  assets?: {
    components: { on: boolean; user: boolean; blocked: string | null; budget: number; spent24h: number; fitted: number; spent: number; job: string | null; designs: number };
    research: { on: boolean; user: boolean; blocked: string | null; budget: number; project: string | null; patents: number; started: number; granted: number; abandoned: number; licenceIncome: number };
    news: { on: boolean; user: boolean; blocked: string | null; deskPerDay: number | null; deskAvg: number | null; verdict: string | null; courier: boolean; givenUp: boolean; sold: number; income: number };
    shares: { on: boolean; user: boolean; blocked: string | null; budget: number; invested: number; held: number; dividends: number; bought: number; sold: number };
  };
  /**
   * Execution and resting orders (execution.ts; pence, no port or good named). Marginal: the switch in force and the user's, tons the
   * marginal stop left unbought that the break-even limit would have bought, loads split across a re-quote and the slippage they were
   * to save net of the wait. Resting: the switch in force and the user's, why nothing new rests (our words; null: it may), the budget,
   * escrow and goods held in it, open bids and asks, lots held, orders placed and withdrawn, tons and money bought and sold through them,
   * leftovers rested, tons loaded from our warehouses into ships, sold from them by IOC, the fill-chance calibration per side (1: as
   * forecast), ports whose re-quote time is known. Absent: not reported.
   */
  execution?: {
    marginal: { on: boolean; user: boolean; cutTons: number; splits: number; splitSaved: number };
    resting: {
      on: boolean;
      user: boolean;
      blocked: string | null;
      budget: number;
      escrow: number;
      held: number;
      bids: number;
      asks: number;
      lots: number;
      placed: number;
      cancelled: number;
      boughtTons: number;
      soldTons: number;
      bought: number;
      sold: number;
      rested: number;
      loaded: number;
      iocSold: number;
      kappaBid: number;
      kappaAsk: number;
      phases: number;
    };
  };
  /**
   * Scoring and allocation (allocation.ts; pence, no ship or charter named). Kelly: the switch in force and the user's, the bankroll the
   * cap is on (null: none), loads the cap cut and the stake it cut. Terminal values: ports known, the median value (pence an hour per ton
   * of hold) and leg hours. Regret: the switch in force and the user's, passes and ships in them, ships served before one that asked
   * first, lanes planned again before their commit, passes cut short. Insertion: deadline charters weighed, held for a ship at sea, taken
   * by her, dropped, held now. Absent: not reported.
   */
  allocation?: {
    kelly: { on: boolean; user: boolean; bankroll: number | null; capped: number; cut: number };
    terminal: { known: number; medianV: number | null; medianH: number | null };
    regret: { on: boolean; user: boolean; batches: number; ships: number; reordered: number; reranked: number; timeouts: number };
    insertion: { checks: number; claims: number; kept: number; lapsed: number; open: number };
  };
  /**
   * Posted prices and the remaining avenues (bandit.ts, escort-join.ts, envelope-voi.ts, hull-orders.ts; pence, no ship or company named).
   * Fares: the fare bandit's switch in force and the user's, keys learned and trials, the keys tried lately (`pax|band|kind|competition`,
   * `escort|fee`, `hull|class`) with the multiplier their posterior means favour and the odds there. Escorting others: the switch in force
   * and the user's, why not (our words), ours asking or in now, others' fee-charging convoys the quays show forming, requests made, joined,
   * refused, withdrawn, sailed, settled, fees paid and expected. Envelopes: the switch, the user's, why not, the budget for 24 real hours and
   * its spend, bought, spent, report rows taken in, the last pass's best (price, worth after the haircut). Hulls: the switch, the user's, why
   * not, the commission open (yard, class, price, our cost, status), the counters and what deliveries saved. Absent: not reported.
   */
  auctions?: {
    fares: { on: boolean; user: boolean; keys: number; trials: number; rows: Array<{ key: string; kind: string; trials: number; m: number | null; p: number | null }> };
    escortOthers: {
      on: boolean;
      user: boolean;
      blocked: string | null;
      active: number;
      offers: number;
      asked: number;
      joined: number;
      refused: number;
      withdrawn: number;
      sailed: number;
      settled: number;
      fees: number;
      expected: number;
    };
    envelopes: { on: boolean; user: boolean; blocked: string | null; budget: number; spent24h: number; bought: number; spent: number; rows: number; best: { price: number; worth: number } | null };
    hulls: {
      on: boolean;
      user: boolean;
      blocked: string | null;
      open: { yard: string; cls: string; price: number; ourCost: number; status: string } | null;
      posted: number;
      taken: number;
      delivered: number;
      cancelled: number;
      expired: number;
      defaulted: number;
      savedPence: number;
    };
  };
  /**
   * The last avenues (charter-posts.ts, freight-issue.ts, insure.ts, futures.ts, monopolies.ts; pence, no ship, company or contract named).
   * Charters posted: the switch in force and the user's, why not, the budget, the escrow on tons still wanted and the landed goods held,
   * ours open, the fill share learned, posted, filled, withdrawn, lapsed, tons delivered. Freight issued: the switch, the user's, why not,
   * ours out, the reward multiplier learned, issued, taken, delivered, lapsed untaken, defaulted. Our voyages insured: the switch, the
   * user's, why not, policies open, written, settled, claimed, voided, premium escrowed, claims paid us. Futures: the switch, the user's,
   * why not, the budget and what is in it, ours live, accepted, posted, taken, settled, defaulted, lapsed, the expected value entered.
   * Monopolies: the switch, the user's, why not, the budget, grants of ours in force, quoted, bought, spent, resold, the best case weighed
   * (region, good, price, value over the term, why not). Absent: not reported.
   */
  contracts?: {
    charters: {
      on: boolean;
      user: boolean;
      blocked: string | null;
      budget: number;
      escrow: number;
      held: number;
      open: number;
      fill: number;
      posted: number;
      done: number;
      cancelled: number;
      expired: number;
      deliveredTons: number;
    };
    freight: { on: boolean; user: boolean; blocked: string | null; open: number; rewardX: number; issued: number; carried: number; delivered: number; expired: number; defaulted: number };
    insurance: { on: boolean; user: boolean; blocked: string | null; open: number; written: number; settled: number; claimed: number; voided: number; premium: number; claims: number };
    futures: {
      on: boolean;
      user: boolean;
      blocked: string | null;
      budget: number;
      exposure: number;
      open: number;
      accepted: number;
      posted: number;
      taken: number;
      settled: number;
      defaulted: number;
      lapsed: number;
      ev: number;
    };
    monopolies: {
      on: boolean;
      user: boolean;
      blocked: string | null;
      budget: number;
      held: number;
      quoted: number;
      bought: number;
      spent: number;
      resold: number;
      best: { region: string; good: string; price: number; value: number; why: string } | null;
    };
  };
}

export interface Aliases {
  charters: Map<string, CharterInfo>;
  lanes: Map<string, string>;
  /** The lane each alias stands for (bans are checked against it). */
  laneOf?: Map<string, Lane>;
  ships: Map<string, string>;
  /** Loans we owe (D1…) and commissions (K1…) the digest listed. */
  loans: Map<string, { id: string; owed: number }>;
  commissions: Map<string, { id: string; yard: string; cls: string; price: number; ours: boolean }>;
}

const cr = (p: number) => `${Math.round(p / 100).toLocaleString("en-GB")} Cr`;
const kcr = (p: number) => `${(p / 100_000).toFixed(1)}k Cr`;
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
/** An annual loan rate (bps per 360 game days) as "% a year". */
const pctYr = (bps: number) => `${pct(bps)} a year`;
/** The buyer's verdict on a ship mortgage it weighed (manager judge), in words. */
const MORTGAGE_CHECKS: Record<string, string> = {
  ok: "passed",
  cap: "over the debt cap",
  lane: "no paying first lane after our part",
  payback: "our part and the interest don't pay back",
  installments: "its net doesn't cover the installments 1.5x",
  interest: "doesn't earn minLoanReturnX its interest",
  season: "the endgame comes before it pays",
};

/**
 * The digest for one call, and the aliases it used. Every line is derived from our own state or
 * catalog ids; no names, titles or free text.
 */
export function buildDigest(d: DigestInput): { text: string; aliases: Aliases } {
  const gameH = (ms: number) => `${(ms / (60 * d.gameMinuteMs)).toFixed(1)} game h`;
  const realMin = (ms: number) => `${Math.round(ms / 60_000)} min`;
  const aliases: Aliases = { charters: new Map(), lanes: new Map(), laneOf: new Map(), ships: new Map(), loans: new Map(), commissions: new Map() };
  // By id: what a money order in force refers to in this digest's aliases.
  const loanAlias = new Map<string, string>();
  const commissionAlias = new Map<string, string>();
  const charterAlias = new Map<string, string>();
  const aliasCharter = (c: CharterInfo) => {
    let a = charterAlias.get(c.id);
    if (!a) {
      a = `C${charterAlias.size + 1}`;
      charterAlias.set(c.id, a);
      aliases.charters.set(a, c);
    }
    return a;
  };
  const laneAlias = new Map<string, string>();
  const aliasLane = (l: Lane) => {
    let a = laneAlias.get(l.key);
    if (!a) {
      a = `L${laneAlias.size + 1}`;
      laneAlias.set(l.key, a);
      aliases.lanes.set(a, l.key);
      aliases.laneOf!.set(a, l);
    }
    return a;
  };
  const laneText = (l: Lane) =>
    `${aliasLane(l)} ${l.kind} ${l.parts.map((p) => `${p.tons}t ${p.good}${p.kind === "market" ? "(sell)" : ""}`).join("+") || "freight"} ${l.source}->${l.dest}: ` +
    `margin ${cr(l.margin)}/t${l.bonus ? ` (bonus ${cr(l.bonus)}/t)` : ""}, ~${cr(l.profitPerHour)}/h, ties up ${cr(l.capital ?? 0)}` +
    `${l.holdMs ? `, holds ${realMin(l.holdMs)} for a re-post` : ""}${l.next ? `; then ${l.next}` : ""}`;
  const status = (s: string, code?: string) => `${s}${code ? `: ${code}` : ""}`;
  const a = d.inForce;

  const out: string[] = [];
  out.push(`# Digest (server time ${new Date(d.now).toISOString()}, phase ${d.phase} open)`);

  // Tier and stalls
  if (d.tier) {
    const t = d.tier;
    out.push(
      `## Expansion tier (unlocks phase ${t.targetPhase})`,
      `progress ${pct(t.progressBps)}, completes ${t.etaMs !== null ? `in about ${realMin(t.etaMs)}` : "at an unknown pace"}${t.phaseSoon ? " (buyer is keeping cash back)" : ""}`,
      `stalled postings stay stalled to the lapse ~${Math.round(t.stallSurvives * 100)}% of the time; a stalled re-post pays x${t.escalation.pay.toFixed(2)} on x${t.escalation.tons.toFixed(2)} tons`,
      `our own deliveries into a stalled posting: ${t.trickle.allowed ? "allowed while they keep it under 80% of its pace line" : "taken to cancel the escalation"} (${t.trickle.confirmed} of ${t.trickle.needed} confirmations, ${t.trickle.refuted} counter-examples)`,
      t.bonus
        ? `completion bonus ${cr(t.bonus.pool)}: our share as the board stands ~${pct(t.bonus.share * 10_000)} (~${cr(t.bonus.pool * t.bonus.share)}; square-root split, our companies pooled)`
        : `completion bonus: no split yet (counted at a straight share of the pool)`,
    );
    for (const w of t.charters) {
      const c = d.charters.find((x) => x.id === w.id) ?? ({ id: w.id, port: w.port, good: w.good, payPerTon: w.rate, remaining: w.remaining, expiresAt: w.expiresAt, stale: false, isPublic: true, title: "", newsAt: null } as CharterInfo);
      const st = t.stakes.find((s) => s.key === `${w.port}|${w.good}`);
      const rv = t.rivalDeliveries.filter((x) => x.port === w.port && x.good === w.good);
      out.push(
        `- ${aliasCharter(c)} ${w.good} -> ${w.port}: ${cr(w.rate)}/t, ${w.remaining}t left, ${w.expiresAt ? `lapses in ${gameH(w.expiresAt - d.now)}` : "no lapse"}` +
          `${w.stalled ? ", STALLED" : ""}${w.line !== undefined && w.delivered !== undefined ? ` (pace line ${Math.round(w.line)}t, ${Math.round(w.delivered)}t delivered${w.ownTons ? `, ${Math.round(w.ownTons)}t ours` : ""})` : ""}` +
          `${w.escalations ? `, re-posted x${w.escalations}` : ""}${w.beyondCoastal ? ", beyond coastal water" : ""}` +
          `${st ? `; fleet ${st.camp ? "LETTING IT LAPSE" : "delivering"} (escalates ~${Math.round(st.p * 100)}%, lapse worth ~${cr(st.value)} vs waiting ~${cr(st.cost)}: ${st.why})` : ""}` +
          `${rv.length ? `; rivals delivered ${rv.length}x (${Math.round(rv.reduce((n, x) => n + x.tons, 0))} t) lately` : ""}`,
      );
    }
  }

  // Fleet (with each ship's order in force)
  out.push(`## Fleet (${d.ships.length} of max ${d.maxShips} ships)`);
  const shipAlias = new Map<string, string>();
  for (const [i, s] of d.ships.entries()) {
    const alias = `S${i + 1}`;
    aliases.ships.set(alias, s.id);
    shipAlias.set(s.id, alias);
    const where = s.status === "sailing" ? `sailing to ${s.dest}${s.etaMs !== null ? `, arrives in ${realMin(s.etaMs)}` : ""}` : `at ${s.port ?? "?"} (${s.state})`;
    const o = a?.shipOrders.find((x) => x.ship === s.id);
    out.push(
      `- ${alias} ${s.cls} (${s.hull}) ${s.guns}/${s.maxGuns} guns, stores ${s.stores.toFixed(1)}t, ${s.cargoTons}/${s.hold}t aboard${s.pax ? ` + ${s.pax} passengers` : ""}, ${where}; spare for its next load ~${kcr(s.loadCash)}` +
        `${s.retiring ? `; BEING RETIRED (${s.retiring})` : ""}${o ? `; your order: ${o.order}${o.label ? ` ${o.label}` : ""} (${status(o.status, o.code)})` : ""}`,
    );
    if (s.lane) out.push(`  lane ${laneText(s.lane)}`);
    const trips = s.trips.slice(-3);
    if (trips.length) out.push(`  recent trips (est -> actual Cr/h): ${trips.map((t) => `${cr(t.estPerHour)} -> ${cr(t.actualPerHour)}`).join("; ")}`);
  }
  // The buyer's status line can carry error text from the game server: only its leading words.
  const buyer = d.buyer.replace(/"[^"]*"/g, "a new ship").split(/[:(]/)[0].replace(/[^A-Za-z0-9 _.,-]/g, "").trim().slice(0, 120);
  out.push(`buyer: ${buyer || "idle"}`);

  // Cash and budgets
  const b = d.budgets;
  out.push(
    `## Cash`,
    `vaults: ${d.cash.vaults.map(([r, v]) => `${r}${r === d.cash.homeRegion ? " (home)" : ""} ${cr(v)}`).join(", ")}`,
    `spare after reserves ${cr(d.cash.spare)}, committed to loads being bought ${cr(d.cash.committed)}` +
      `${d.cash.due > 0 ? `, due from our cargo at sea ~${cr(d.cash.due)} (loads bought after it lands may count on it)` : ""}` +
      `${d.cash.capitalRate > 0 ? `; cash is scarce (loads charged ${(d.cash.capitalRate * 100).toFixed(2)}%/h of the cash they tie up)` : ""}` +
      `${d.cash.levyExcess > 0 ? `; WEALTH LEVY: net worth ${cr(d.cash.levyExcess)} above the 1,000,000 Cr threshold pays ~${cr(d.cash.levyPerDay)} a game day from cash (kept in the home floor)` : ""}` +
      `; Crown and Admiralty charter pay over the last 10 game days ${cr(d.cash.charterEarned)}: ${d.cash.charterTaper < 1 ? `PREMIUM TAPERED, x${d.cash.charterTaper.toFixed(2)} on the pay above the goods' base value now (lower still with a load's own pay)` : "premium paid in full (it tapers past 50,000 Cr)"}` +
      `${d.cash.drafts ? `; banks carried ${d.cash.drafts} of our remittances as drafts, ${cr(d.cash.draftSaved ?? 0)} under the Crown's fees` : ""}`,
    `## Loans`,
    `owed ${cr(d.finance.owed)}${d.finance.cap !== null ? ` of a ${cr(d.finance.cap)} cap (maxDebtPct of net worth ~${cr(d.finance.worth ?? 0)})` : " (net worth not known yet: no new loans)"}` +
      `${d.finance.short ? "; a REPAYMENT DUE IS SHORT: no new loads, hulls, marques or lending until it is paid" : ""}` +
      `${d.finance.lentOut > 0 ? `; borrowers owe us ${cr(d.finance.lentOut)}` : ""}` +
      `${d.finance.quoted > 0 ? `; ${cr(d.finance.quoted)} of idle cash quoted on ${d.finance.quotes.length} request${d.finance.quotes.length === 1 ? "" : "s"} (${d.finance.quotes.map((q) => `${cr(q.principal)} at ${pctYr(q.rateBps)} for ${q.termDays} game days`).join(", ")})` : ""}`,
    ...d.finance.loans.map((l, i) => {
      const alias = `D${i + 1}`;
      aliases.loans.set(alias, { id: l.id, owed: l.owed });
      loanAlias.set(l.id, alias);
      return (
        `- ${alias} owe ${cr(l.owed)} at ${pctYr(l.rateBps)}, ${l.repayment}${l.mortgage ? ", a SHIP MORTGAGE (runs on its installments, never repaid early)" : l.use ? ` (for a ${l.use})` : ""}` +
        `${l.defaulted ? ", DEFAULTED" : l.repayInMs !== null ? `, repaid in full within ${realMin(l.repayInMs)}` : ""}` +
        `${l.arrears > 0 ? `, ${cr(l.arrears)} IN ARREARS (the whole loan defaults after a game day)` : l.nextPaymentInMs !== null && l.nextPaymentPence !== null && l.repayment === "amortised" ? `, next installment ~${cr(l.nextPaymentPence)} in ${realMin(l.nextPaymentInMs)}` : ""}`
      );
    }),
    ...d.finance.requests.map(
      (r) =>
        `- our request for quotes: ${cr(r.principal)} for ${r.termDays} game days${r.refinancesBps !== null ? ` (to refinance a Goldsmiths' loan at ${pctYr(r.refinancesBps)})` : ""}: ${r.quotes ? `${r.quotes} quote${r.quotes === 1 ? "" : "s"}, best ${r.bestBps !== null ? pctYr(r.bestBps) : "?"}` : "no quote yet"}`,
    ),
    ...(d.finance.mortgage
      ? [
          `ship mortgages in the buyer: ${d.finance.mortgage.state}` +
            `${d.finance.mortgage.checks.length ? `; its latest checks: ${d.finance.mortgage.checks.map((c) => `${c.cls}@${c.yard} ${MORTGAGE_CHECKS[c.code] ?? c.code}`).join(", ")}` : ""}` +
            `${d.finance.mortgage.lastBuilt ? `; last built on one: ${d.finance.mortgage.lastBuilt.cls}@${d.finance.mortgage.lastBuilt.yard} ${realMin(d.finance.mortgage.lastBuilt.agoMs)} ago (${cr(d.finance.mortgage.lastBuilt.principal)} from the Goldsmiths)` : ""}`,
        ]
      : []),
    `Goldsmiths' rate by term: ${d.finance.goldsmiths.map((g) => `${g.days} days ${pctYr(g.bps)}`).join(", ")}`,
    ...(d.banking
      ? (() => {
          const dp = d.banking.deposits;
          const bk = d.banking.bank;
          return [
            `## Banks`,
            `deposits ${dp.on ? "on" : "off"}${dp.user ? "" : " (the user's switch is off: you can't turn it on)"}: ${cr(dp.held)} on demand deposit at ${dp.banks} bank${dp.banks === 1 ? "" : "s"} ` +
              `(budget ${cr(dp.budget)}; the last pass would keep ${cr(dp.target)} there), ${cr(dp.interest)} interest earned${dp.blocked ? `; no more deposited: ${dp.blocked}` : ""}`,
            `our own bank ${bk.on ? "on" : "off"}${bk.user ? "" : " (the user's switch is off: you can't turn it on)"}: ${bk.status} (${bk.verdict})` +
              `${bk.fees.length ? `; exchange fees for drafts ${bk.fees.map((f) => `${f.region} ${f.bps} bps`).join(", ")}` : ""}` +
              `${bk.drafts ? `; ${bk.drafts} drafts carried for ${cr(bk.draftFees)} in fees` : ""}` +
              `${bk.lineOut || bk.lineRoom ? `; our lending line ${cr(bk.lineOut)} out, ${cr(bk.lineRoom)} room` : ""}` +
              `${bk.loans ? `; ${bk.loans} loans made by our lines, ${bk.defaults} defaulted, ${cr(bk.interest)} interest received` : ""}` +
              `${bk.warnings ? `; ${bk.warnings} warning${bk.warnings === 1 ? "" : "s"} for the owner` : ""}`,
          ];
        })()
      : []),
    ...(d.avenues
      ? (() => {
          const pv = d.avenues.voyages;
          const vn = d.avenues.ventures;
          const es = d.avenues.escort;
          const off = (user: boolean) => (user ? "" : " (the user's switch is off: you can't turn it on)");
          return [
            `## Passenger voyages, ventures, escort fees`,
            `passengerVoyages ${pv.on ? "on" : "off"}${off(pv.user)}${pv.blocked ? ` (${pv.blocked})` : ""}: ${pv.chosen} lanes chosen with waiting passengers' fares counted (${pv.only} for fares alone), ` +
              `${pv.sailed} sailed with them, ${pv.givenUp} given up (nobody boarded: not sailed empty), ~${cr(pv.expected)} in fares expected on them`,
            `ventures ${vn.on ? "on" : "off"}${off(vn.user)}${vn.blocked ? ` (no new one: ${vn.blocked})` : ""}: investors offered ${(vn.shareBps / 100).toFixed(1)}% of the profit next, ` +
              `outside capital expected ~${Math.round(vn.outsideRatio * 100)}% of a hold's fill at catalog prices` +
              `${vn.active ? `; under way ${vn.active.route}: ${vn.active.stage}, ${cr(vn.active.capital)} raised (${cr(vn.active.outside)} from others)` : ""}` +
              `; ${vn.opened} opened, ${vn.settled} settled, ${vn.cancelled} cancelled, ${vn.lost} lost; ${cr(vn.outside)} raised from others, ${cr(vn.paid)} paid to us, profit ${cr(vn.profit)}`,
            `escortFees ${es.on ? "on" : "off"}${off(es.user)}${es.blocked ? ` (${es.blocked})` : ""}: ${es.offered} convoys offered to others, ${es.approved} joiners admitted, ${es.rejected} turned away, ` +
              `${es.settlements} settlements, ${cr(es.fees)} to our escorts` +
              `${es.open.length ? `; open now: ${es.open.map((o) => `${o.route} ${cr(o.feePerTon)}/t, ${o.outsiders} others in (${cr(o.escrow)} escrowed)`).join(", ")}` : ""}`,
          ];
        })()
      : []),
    ...(d.assets
      ? (() => {
          const cp = d.assets.components;
          const rs = d.assets.research;
          const nw = d.assets.news;
          const sh = d.assets.shares;
          const off = (user: boolean) => (user ? "" : " (the user's switch is off: you can't turn it on)");
          return [
            `## Components, research, news packet, ship shares`,
            `components ${cp.on ? "on" : "off"}${off(cp.user)}${cp.blocked ? ` (${cp.blocked})` : ""}: ${cr(cp.spent24h)} of ${cr(cp.budget)} spent in the last 24 h; ${cp.fitted} fitted, ${cr(cp.spent)} spent in all; ` +
              `${cp.designs} designs we could make${cp.job ? `; under way: ${cp.job}` : ""}`,
            `rndResearch ${rs.on ? "on" : "off"}${off(rs.user)}${rs.blocked ? ` (${rs.blocked})` : ""}: budget ${cr(rs.budget)} a project; ${rs.project ? `ours: ${rs.project}` : "no project of ours"}; ` +
              `${rs.patents} patents held; ${rs.started} started, ${rs.granted} granted, ${rs.abandoned} given up; licence income ${cr(rs.licenceIncome)}`,
            `newsPackets ${nw.on ? "on" : "off"}${off(nw.user)}${nw.blocked ? ` (${nw.blocked})` : ""}: Lloyd's spends ${nw.deskPerDay !== null ? `${cr(nw.deskPerDay)} a game day on envelopes${nw.deskAvg !== null ? `, ${cr(nw.deskAvg)} each` : ""}` : "an unknown amount"}; ` +
              `${nw.courier ? "our courier runs" : nw.givenUp ? "our courier was given up (being sold)" : `no courier${nw.verdict ? ` (${nw.verdict})` : ""}`}; ${nw.sold} of her envelopes sold for ${cr(nw.income)}`,
            `shipShares ${sh.on ? "on" : "off"}${off(sh.user)}${sh.blocked ? ` (${sh.blocked})` : ""}: ${cr(sh.invested)} of ${cr(sh.budget)} in 64ths of ${sh.held} ships, ${cr(sh.dividends)} dividends; ${sh.bought} bought, ${sh.sold} sold`,
          ];
        })()
      : []),
    ...(d.execution
      ? (() => {
          const mg = d.execution.marginal;
          const rs = d.execution.resting;
          const off = (user: boolean) => (user ? "" : " (the user's switch is off: you can't turn it on)");
          return [
            `## Execution and resting orders`,
            `marginalOrders ${mg.on ? "on" : "off"}${off(mg.user)}: ${mg.cutTons} t left unbought by the marginal stop that the break-even limit would have bought; ` +
              `${mg.splits} loads split across a re-quote (~${cr(mg.splitSaved)} slippage saved net of the waits, as estimated)`,
            `restingOrders ${rs.on ? "on" : "off"}${off(rs.user)}${rs.blocked ? ` (nothing new: ${rs.blocked})` : ""}: ${cr(rs.escrow)} escrowed and ${cr(rs.held)} of goods held of ${cr(rs.budget)}; ` +
              `${rs.bids} bids and ${rs.asks} asks resting, ${rs.lots} lots in our warehouses; ${rs.placed} placed, ${rs.cancelled} withdrawn; ` +
              `bought ${rs.boughtTons} t for ${cr(rs.bought)}, sold ${rs.soldTons} t for ${cr(rs.sold)} through them, ${cr(rs.iocSold)} sold from warehouses by IOC; ` +
              `${rs.rested} t of leftovers rested, ${rs.loaded} t loaded from our warehouses into ships; fill chance as forecast x${rs.kappaBid} (bids) / x${rs.kappaAsk} (asks); ` +
              `re-quote time known at ${rs.phases} ports`,
          ];
        })()
      : []),
    ...(d.allocation
      ? (() => {
          const k = d.allocation.kelly;
          const t = d.allocation.terminal;
          const rg = d.allocation.regret;
          const ins = d.allocation.insertion;
          const off = (user: boolean) => (user ? "" : " (the user's switch is off: you can't turn it on)");
          return [
            `## Scoring and allocation`,
            `kellySizing ${k.on ? "on" : "off"}${off(k.user)}: bankroll ${k.bankroll !== null ? cr(k.bankroll) : "none"}; ${k.capped} loads cut by the Kelly/RCK cap, ${cr(k.cut)} of stake cut in all; ` +
              `terminal values known at ${t.known} ports${t.medianV !== null ? `, median ~${cr(t.medianV * 100)}/h per 100 t of hold over ~${t.medianH ?? "?"} h legs` : ""}`,
            `assignByRegret ${rg.on ? "on" : "off"}${off(rg.user)}: ${rg.batches} passes for ${rg.ships} ships, ${rg.reordered} served ahead of one that asked first, ${rg.reranked} lanes planned again before their commit, ` +
              `${rg.timeouts} passes cut short by the time box; deadline charters: ${ins.checks} weighed for ships at sea, ${ins.claims} held for one (${ins.kept} taken, ${ins.lapsed} dropped), ${ins.open} held now`,
          ];
        })()
      : []),
    ...(d.auctions
      ? (() => {
          const fa = d.auctions.fares;
          const eo = d.auctions.escortOthers;
          const en = d.auctions.envelopes;
          const hu = d.auctions.hulls;
          const off = (user: boolean) => (user ? "" : " (the user's switch is off: you can't turn it on)");
          return [
            `## Posted prices, escorting others, envelopes bought, hulls ordered`,
            `fareBandit ${fa.on ? "on" : "off"}${off(fa.user)}: ${fa.keys} keys learned over ${fa.trials} trials` +
              `${fa.rows.length ? `; lately: ${fa.rows.map((r) => `${r.key} (${r.trials} trials) favours x${r.m ?? "?"} at ${r.p !== null ? `${Math.round(r.p * 100)}%` : "?"}`).join(", ")}` : ""}`,
            `escortOthers ${eo.on ? "on" : "off"}${off(eo.user)}${eo.blocked ? ` (${eo.blocked})` : ""}: ${eo.active} of ours asking or in now; ${eo.offers} fee-charging convoys of others forming as the quays show; ` +
              `${eo.asked} asked, ${eo.joined} joined, ${eo.refused} refused, ${eo.withdrawn} withdrawn, ${eo.sailed} sailed, ${eo.settled} settled; ${cr(eo.fees)} paid of ~${cr(eo.expected)} expected`,
            `buyEnvelopes ${en.on ? "on" : "off"}${off(en.user)}${en.blocked ? ` (${en.blocked})` : ""}: ${cr(en.spent24h)} of ${cr(en.budget)} spent in the last 24 h; ${en.bought} bought for ${cr(en.spent)}, ${en.rows} report rows taken in` +
              `${en.best ? `; the last pass's best: ${cr(en.best.price)} for ~${cr(en.best.worth)} of information` : ""}`,
            `orderHulls ${hu.on ? "on" : "off"}${off(hu.user)}${hu.blocked ? ` (${hu.blocked})` : ""}: ${hu.open ? `open: a ${hu.open.cls} at ${hu.open.yard} for ${cr(hu.open.price)} (our build ${cr(hu.open.ourCost)}), ${hu.open.status}; ` : ""}` +
              `${hu.posted} posted, ${hu.taken} taken, ${hu.delivered} delivered, ${hu.cancelled} withdrawn, ${hu.expired} lapsed untaken, ${hu.defaulted} defaulted; ${cr(hu.savedPence)} saved on hulls delivered`,
          ];
        })()
      : []),
    ...(d.contracts
      ? (() => {
          const ch = d.contracts.charters;
          const fr = d.contracts.freight;
          const ins = d.contracts.insurance;
          const fu = d.contracts.futures;
          const mo = d.contracts.monopolies;
          const off = (user: boolean) => (user ? "" : " (the user's switch is off: you can't turn it on)");
          return [
            `## Charters posted, freight issued, our voyages insured, futures, monopolies`,
            `postCharters ${ch.on ? "on" : "off"}${off(ch.user)}${ch.blocked ? ` (${ch.blocked})` : ""}: ${ch.open} of ours open, ${cr(ch.escrow)} escrowed and ${cr(ch.held)} of landed goods held of ${cr(ch.budget)}; ` +
              `${ch.posted} posted, ${ch.done} filled, ${ch.cancelled} withdrawn, ${ch.expired} lapsed; ${ch.deliveredTons} t delivered; fill share learned ${Math.round(ch.fill * 100)}%`,
            `issueFreight ${fr.on ? "on" : "off"}${off(fr.user)}${fr.blocked ? ` (${fr.blocked})` : ""}: ${fr.open} of ours out; ${fr.issued} issued, ${fr.carried} taken, ${fr.delivered} delivered, ${fr.expired} lapsed untaken, ${fr.defaulted} defaulted; reward x${fr.rewardX}`,
            `insureLevered ${ins.on ? "on" : "off"}${off(ins.user)}${ins.blocked ? ` (${ins.blocked})` : ""}: ${ins.open} policies of ours open; ${ins.written} written, ${ins.settled} settled, ${ins.claimed} claimed, ${ins.voided} voided; ` +
              `${cr(ins.premium)} premium escrowed, ${cr(ins.claims)} claims paid us`,
            `futures ${fu.on ? "on" : "off"}${off(fu.user)}${fu.blocked ? ` (${fu.blocked})` : ""}: ${cr(fu.exposure)} of ${cr(fu.budget)} in use, ${fu.open} live; ${fu.accepted} accepted, ${fu.posted} posted (${fu.taken} taken), ` +
              `${fu.settled} settled, ${fu.defaulted} defaulted, ${fu.lapsed} lapsed; ~${cr(fu.ev)} expected value entered`,
            `monopolies ${mo.on ? "on" : "off"}${off(mo.user)}${mo.blocked ? ` (${mo.blocked})` : ""}: ${mo.held} grants of ours in force; ${mo.quoted} quoted, ${mo.bought} bought for ${cr(mo.spent)}, ${cr(mo.resold)} resold` +
              `${mo.best ? `; the best weighed: ${mo.best.good} in ${mo.best.region} for ${cr(mo.best.price)}, worth ~${cr(mo.best.value)} over its term (${mo.best.why})` : ""}`,
          ];
        })()
      : []),
    `## Budgets (the user's ceilings)`,
    `marques+patrols in the last 24 h: ${b.navalSpent24h === null ? `not read yet, of ${cr(b.navalBudget)}` : `${cr(b.navalSpent24h)} of ${cr(b.navalBudget)} (${cr(Math.max(0, b.navalBudget - b.navalSpent24h))} left)`}; ` +
      `underwriting ${b.underwriteLocked === null ? "not read yet" : cr(b.underwriteLocked)} of ${cr(b.underwriteBudget)} locked; fleet ${b.fleet} of max ${d.user.maxShips}; ` +
      `home floor ${cr(b.homeFloor)} (reserve ${cr(b.reserve)}, 1.5 days of bills ${cr(b.billsFloor)})`,
  );

  // Ship market, commissions (aliased for accept orders) and envelopes
  const dl = d.deals;
  out.push(
    `## Ship market, commissions and envelopes`,
    dl.listings.length
      ? `ships for sale at our quays: ${dl.listings.slice(0, 8).map((l) => `${l.cls}@${l.port} ${kcr(l.price)}${l.guns ? ` (${l.guns} guns)` : ""}${l.build !== null ? ` vs building ${kcr(l.build)}` : ""}`).join(", ")}`
      : "ships for sale at our quays: none seen lately",
  );
  for (const [i, c] of dl.commissions.slice(0, 8).entries()) {
    const alias = `K${i + 1}`;
    aliases.commissions.set(alias, { id: c.id, yard: c.yard, cls: c.cls, price: c.price, ours: c.ours !== null });
    commissionAlias.set(c.id, alias);
    out.push(
      `- ${alias} ${c.admiralty ? "ADMIRALTY commission (paid by the Crown, the hull to the Royal Navy, one taken at a time)" : "commission"}: a ${c.cls} at ${c.yard} for ${cr(c.price)} (${c.admiralty ? "deposit" : "collateral"} ${cr(c.collateral)})${c.leftMs !== null ? `, deadline in ${gameH(c.leftMs)}` : ""}` +
        `${c.margin !== null ? `, ~${cr(c.margin)} over our cheapest build after the collateral's risk` : ", not quoted"}${c.ours ? `; OURS: ${c.ours}` : ""}`,
    );
  }
  out.push(`envelopes: ${dl.open} of ours open, ${dl.sold} sold for ${cr(dl.income)} in all; commissions built to order earned ${cr(dl.commissionNet)}`);

  // The Free Trade
  const sm = d.smuggling;
  if (sm) {
    out.push(
      `## Free Trade (smuggling)`,
      `mode ${sm.state}${sm.user ? "" : " (the user's switch is off: you can't turn it on)"}${sm.available ? "" : "; the key lacks the underworld scope"}${sm.halted ? "; HALTED after a seizure until the user turns it on again" : ""}; ` +
        `a run buys at most ${sm.maxTons} t and ${cr(sm.maxPence)}; odds a run ends in a seizure now ~${(sm.odds * 100).toFixed(1)}%; ${sm.recentRuns} runs ashore in the Crown's attention window`,
      `record: ${sm.runs} runs ashore, ${sm.landedTons} t landed for ${cr(sm.proceeds)} (goods bought ${cr(sm.spent)}); ${sm.seizures} seized${sm.convictions ? `, ${sm.convictions} smuggling conviction${sm.convictions === 1 ? "" : "s"} on our public credit record` : ""}`,
      sm.ships.length
        ? `our smugglers: ${sm.ships.map((x) => `${x.purpose}${x.dest ? ` → ${x.dest}` : ""}${x.want ? ` (want ${x.want})` : ""}${x.running ? ", running ashore now" : ""}`).join("; ")}`
        : "our smugglers: none",
      sm.wants.length
        ? `wants seen: ${sm.wants.map((x) => `${x.good}@${x.port} ${x.x.toFixed(1)}x ${x.ageH} game h ago${x.remaining !== null ? ` ${x.remaining} t` : ""} (${x.source})`).join(", ")}`
        : "wants seen: none fresh",
    );
  }

  // Passengers (spare hold on voyages sailed anyway)
  const px = d.passengers;
  if (px && (px.enabled || px.earned > 0 || px.aboard.length || px.offers.length)) {
    const heads = px.aboard.reduce((n, g) => n + g.heads, 0);
    const of = (id: string) => shipAlias.get(id) ?? "a ship no longer listed";
    out.push(
      `## Passengers (spare hold only)`,
      `${px.enabled ? "on" : "off"}${px.blocked ? "; offers refused for the key (none tried for an hour)" : ""}; fares paid so far ${cr(px.earned)}; ` +
        `${heads} heads aboard paying ~${cr(px.aboard.reduce((n, g) => n + g.fares, 0))} on arrival; ${px.offers.length} offer${px.offers.length === 1 ? "" : "s"} open`,
      ...(px.aboard.length
        ? [`aboard: ${px.aboard.slice(0, 6).map((g) => `${of(g.ship)} ${g.heads} for ${g.dest} ~${cr(g.fares)}${g.dueInMs !== null ? ` (promised in ${realMin(g.dueInMs)})` : ""}`).join("; ")}`]
        : []),
      ...(px.offers.length
        ? [`offers: ${px.offers.slice(0, 6).map((o) => `${of(o.ship)} at ${o.port} for ${o.dest} ${o.berths} berths at ${cr(o.perHead)} a head${o.taken ? `, ${o.taken} taken` : ""}`).join("; ")}`]
        : []),
      `fares learned (route: nudge on the accepted fare, uncontested level, rounds won/unfilled): ${px.routes.slice(0, 6).map((r) => `${r.route} x${r.adj.toFixed(2)}${r.adjOpen !== undefined ? ` open x${r.adjOpen.toFixed(2)}` : ""} ${r.won}/${r.lost}`).join(", ") || "none yet"}; ${px.records} fare records read` +
        `${px.uncontested !== undefined ? `; ${px.uncontested} route${px.uncontested === 1 ? "" : "s"} where groups gave up unboarded lately (uncontested: offers there open high over the band's median, at the route's own once it has one)` : ""}`,
    );
  }

  // Housekeeping (break-ups, the home port, the Crowns' top-ups)
  const hk = d.housekeeping;
  if (hk) {
    const bu = hk.breakUp;
    const rl = hk.relocate;
    const of = (id: string) => shipAlias.get(id) ?? "a ship no longer listed";
    out.push(
      `## Housekeeping (break-ups and the home port)`,
      `break-up of dead weight: ${bu.blocked ?? (bu.enabled ? "on" : "off")}; retired so far ${bu.brokenUp} broken up for ${cr(bu.payout)}, ${bu.sold} sold for ${cr(bu.soldPence)}` +
        `${bu.refused.length ? `; Crowns that couldn't pay a break-up lately: ${bu.refused.join(", ")}` : ""}`,
      ...bu.candidates.slice(0, 4).map(
        (c) =>
          `- candidate ${of(c.ship)} ${c.reason}, ${c.checks} check${c.checks === 1 ? "" : "s"}${c.ready ? ", ready" : ", still watched"}: payout ${cr(c.payout)}, earns ~${cr(c.earnPerDay)} vs upkeep ~${cr(c.upkeepPerDay)} a game day` +
          `${c.gain !== null && c.worthGain !== null ? `; over ${c.horizonH} h cash ${c.gain >= 0 ? "+" : ""}${cr(c.gain)}, net worth ${c.worthGain >= 0 ? "+" : ""}${cr(c.worthGain)} broken up against kept` : ""}`,
      ),
      ...bu.pending.slice(0, 2).map((p) => `- being retired: ${of(p.ship)} ${p.stage}, at ${p.yard} for ~${cr(p.payout)}${p.ordered ? " (your order)" : ""}`),
      ...(bu.done.length ? [`retired lately: ${bu.done.slice(-3).map((x) => `${x.cls}@${x.port} ${x.how === "sold" ? "sold" : "broken up"} for ${cr(x.pence)} ${realMin(x.agoMs)} ago`).join("; ")}`] : []),
      `home ${rl.home ?? "?"} (${rl.region ?? "?"}), moving it ${rl.enabled ? "on" : "off"}: remit fees that kept it funded ~${cr(rl.perDay)} a game day` +
        `${rl.byRegion.length ? ` (${rl.byRegion.slice(0, 3).map((x) => `${x.region} ${Math.round(x.share * 100)}%`).join(", ")})` : ""}, ~${cr(rl.saving)} to the horizon against the bar ${cr(rl.threshold)} (the move ${cr(rl.fee)} x1.5); ` +
        `${rl.verdict}${rl.target ? `; a move would go to ${rl.target}` : ""}; presence to move to: ${rl.presence.slice(0, 8).join(", ") || "none"}; next move ${rl.nextInMs !== null ? `allowed in ${realMin(rl.nextInMs)}` : "allowed now"}`,
      ...(hk.toppedUp.length ? [`Crowns topped up by the Exchequer lately: ${hk.toppedUp.slice(-5).map((t) => `${t.region ?? "a Crown"} ${gameH(t.agoMs)} ago`).join(", ")}`] : []),
    );
  }

  // Settings and ranges
  const u = d.user;
  out.push(
    `## Settings (the user's) and what you may set them to`,
    NUMBER_KEYS.map((k) => {
      const r = aiRange(k, u);
      return `${k} ${u[k]} [${r.min}-${r.max}]`;
    }).join("; "),
    `${SWITCH_KEYS.map((k) => `${k} ${u[k] ? "on" : "off"}`).join(", ")}; guns ${u.guns}; buy classes ${u.buyClasses.join(", ") || "none"}` +
      `${d.canBuild ? "" : "; the key may not build ships (autoBuy and builds stay off)"}`,
  );

  // Directives in force
  out.push(`## Your directives in force`);
  if (!a) out.push("none");
  else {
    const set = Object.entries(a.settings).filter(([k]) => k !== "buyClasses");
    const lines = [
      `${realMin(a.leftMs)} left`,
      set.length ? `settings: ${set.map(([k, v]) => `${k} ${String(v)}`).join(", ")}` : "",
      a.avoid.length ? `avoid: ${a.avoid.map((x) => x.label).join(", ")}` : "",
      a.biases.length ? `lane bias: ${a.biases.map((x) => `${x.label} x${x.factor.toFixed(2)}`).join(", ")}` : "",
      a.stallCalls.length ? `stall calls: ${a.stallCalls.map((x) => `${x.label} ${x.call}`).join(", ")}` : "",
      a.shipOrders.length ? "ship orders: on the fleet lines" : "",
      a.buyHold ? "buy: hold" : a.build ? `buy: build ${a.build.cls}@${a.build.yard} (${status(a.build.status, a.build.code)})` : "",
      a.forbid.length ? `forbid: ${a.forbid.join(", ")}` : "",
      a.naval.length
        ? `naval: ${a.naval.map((n) => `${n.kind} ${n.zone} ${n.bps} bps ${n.gameHours} game h ${n.costPence > 0 ? `~${cr(n.costPence)}` : "priced when issued"} (${status(n.status, n.code)})`).join("; ")}`
        : "",
      // (finance: absent on directives saved before money orders)
      ...[false, true].map((house) => {
        const xs = (a.finance ?? []).filter((o) => isHousekeeping(o) === house);
        return xs.length
          ? `${house ? "housekeeping" : "money"}: ${xs
              .map((o) => {
                const of =
                  o.kind === "borrow_load" || o.kind === "break_up" ? (shipAlias.get(o.ref) ?? "a ship no longer listed")
                  : o.kind === "repay" ? (loanAlias.get(o.ref) ?? "no longer owed")
                  : o.kind === "commission" ? (commissionAlias.get(o.ref) ?? "no longer listed")
                  : "";
                return `${o.label}${of ? ` (${of})` : ""} (${status(o.status, o.code)})`;
              })
              .join("; ")}`
          : "";
      }),
    ].filter(Boolean);
    out.push(...lines);
  }

  // Lanes
  out.push(`## Best lanes now (reference ship, before your bias)`);
  for (const l of d.topLanes.slice(0, 12)) out.push(`- ${laneText(l)}`);

  // Charters
  out.push(`## Open charters (top by value)`);
  for (const c of d.charters.slice(0, 20)) {
    const rv = d.charterRivals.get(c.id);
    out.push(
      `- ${aliasCharter(c)} ${c.good} -> ${c.port}: ${cr(c.payPerTon)}/t, ${c.remaining}t` +
        `${c.expiresAt ? `, lapses in ${gameH(c.expiresAt - d.now)}` : ""}${c.isPublic ? ", public" : ""}${c.provisional ? ", expected from a shortage's news, not listed yet" : c.stale ? ", gossip (may be filled)" : ""}` +
        `${rv && (rv.tons > 0 || rv.unknown > 0) ? `, rivals due first ~${Math.round(rv.tons)}t${rv.unknown > 0 ? ` +${rv.unknown} laden of unknown cargo` : ""}` : ""}`,
    );
  }

  // Sea zones (piracy, traffic, our exposure and our marques and patrols)
  if (d.zones.length) {
    out.push(`## Sea zones (net piracy bps; rival traffic a game day; our exposure)`);
    for (const z of d.zones.slice(0, 8)) {
      out.push(
        `- ${z.zone} ${z.net}${z.split ? ` (base ${z.split.base}, marques +${z.split.marque}, patrols -${z.split.patrol})` : ""}` +
          `${z.rivals ? `; rivals ${z.rivals.passages.toFixed(1)} passages, ${z.rivals.laden.toFixed(1)} laden, cargo ~${kcr(z.rivals.cargo)}` : ""}` +
          `${z.ownExposure > 0 ? `; ours exposed ~${kcr(z.ownExposure)}` : ""}` +
          `${z.marquePrice !== null ? `; a marque costs ${(z.marquePrice / 100).toFixed(2)} Cr per bps a game day (quoted)` : ""}` +
          `${z.patrolPrice != null ? `; a patrol costs ${(z.patrolPrice / 100).toFixed(2)} Cr per bps a game day (quoted)` : ""}` +
          `${z.seized && z.seized.atSea + z.seized.inPort > 0 ? `; smugglers seized in 7 game days: ${z.seized.atSea} at sea, ${z.seized.inPort} in port` : ""}` +
          `${z.noPatrol ? "; NO PATROL of ours here (our own ships may carry contraband through it)" : ""}` +
          `${z.ours.length ? `; ours in force: ${z.ours.map((o) => `${o.kind} ${o.kind === "marque" ? "+" : "-"}${o.bps} (${gameH(o.leftMs)} left)`).join(", ")}` : ""}`,
      );
    }
  }

  // Royal monopolies
  if (d.monopolies.length) {
    out.push(`## Royal monopolies in force (the holder alone buys the good from the Crown's asks across the region)`);
    for (const m of d.monopolies.slice(0, 12)) out.push(`- ${m.good} in ${m.region}: ${m.ours ? "OURS" : "held by another company"}, ${gameH(m.leftMs)} left`);
  }

  // Yards and the buyer's options
  if (d.yards.length || d.buyerOptions.length) {
    out.push(`## Yards (last hull quotes)`);
    for (const y of d.yards.slice(0, 6)) {
      const here = [...y.ships.map((id) => shipAlias.get(id)).filter((x): x is string => !!x), ...(y.factor ? ["factor"] : [])];
      out.push(`- ${y.port}${here.length ? ` [${here.join(", ")}]` : ""}: ${y.quotes.map(([c, p]) => `${c} ${kcr(p)}`).join(", ") || "no quotes yet"}`);
    }
    if (d.buyerOptions.length) {
      out.push(`buyer's best at its last check: ${d.buyerOptions.map((o) => `${o.cls}@${o.yard} pays back in ${o.paybackHours.toFixed(1)} h for ${kcr(o.costPence)}`).join(", ")} (limit ${d.paybackLimit} h)`);
    }
  }

  // Rivals
  out.push(`## Rivals seen (aliased)`);
  d.rivals.companies.slice(0, 8).forEach((r, i) =>
    out.push(
      `- R${i + 1}: ${r.ships} ships known, ${r.laden} laden, ${r.sailing} at sea` +
        `${r.earnPerHour != null ? `, earns ~${cr(r.earnPerHour)}/h` : ""}${r.lanes?.length ? `; lanes ${r.lanes.join(", ")}` : ""}${r.feeds?.length ? `; delivers ${r.feeds.join(", ")}` : ""}`,
    ),
  );

  // Events
  if (d.events.length) {
    out.push(`## Notices (screened into fields)`);
    for (const e of d.events.slice(-10)) {
      out.push(`- ${gameH(d.now - e.at)} ago: ${e.kind}, ${e.direction}, ${e.severity}${e.ports.length ? `, ports ${e.ports.join(" ")}` : ""}${e.goods.length ? `, goods ${e.goods.join(" ")}` : ""}${e.zones.length ? `, zones ${e.zones.join(" ")}` : ""}`);
    }
  }

  // Memory
  if (d.decisions.length) {
    out.push(`## Your recent advice and what followed`);
    for (const x of d.decisions.slice(-5)) out.push(`- ${x.at}: ${x.posture}, ${x.applied}; ${x.outcome}`);
  }
  out.push(`## Planner calibration`, `remembered bids are marked down ${(d.bidHaircutPerDay * 100).toFixed(1)}% per game day of age (learned)`);
  if (d.market) {
    const m = d.market;
    const pct = (x: number | null) => (x === null ? "?" : `${(x * 100).toFixed(1)}%`);
    out.push(
      `market model ${m.enabled ? "on" : "off (still learning)"}: ${m.modelled} of ${m.books} books modelled (${m.confident} confidently)` +
        `${m.halfLifeH !== null ? `; stock half-life ~${m.halfLifeH} game h${m.bulkHalfLifeH !== null ? ` (bulk ~${m.bulkHalfLifeH})` : ""}` : ""}` +
        `${m.eBid !== null || m.eAsk !== null ? `; price elasticity to stock bids ${m.eBid ?? "?"} / asks ${m.eAsk ?? "?"}` : ""}` +
        `${m.sweeps ? `; a swept ladder refills ${pct(m.refillAsk)} (asks) / ${pct(m.refillBid)} (bids) a re-quote (${m.sweeps} measured)` : ""}` +
        `; forecast error against the old rule: bids ${pct(m.score.bid.modelErr)} vs ${pct(m.score.bid.oldErr)} (${m.score.bid.n} scored, trust ${m.score.bid.trust})` +
        `, asks ${pct(m.score.ask.modelErr)} vs ${pct(m.score.ask.oldErr)} (${m.score.ask.n} scored, trust ${m.score.ask.trust})`,
    );
  }
  if (d.storms) {
    const s = d.storms;
    out.push(
      `storms: ${s.season ? "storm season now" : "calm season"}${s.turnsAt ? `, turns in ${gameH(Date.parse(s.turnsAt) - d.now)}` : ""}; a leg's storm odds are ` +
        `${s.perDay.calm.toFixed(2)}x (calm) / ${s.perDay.storm.toFixed(2)}x (storm season) its zone's storm bps per game day at sea, learned from ${s.seen} storms over ${s.expected} expected`,
    );
  }
  return { text: out.join("\n"), aliases };
}
