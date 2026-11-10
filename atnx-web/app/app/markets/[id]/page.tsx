import { notFound } from "next/navigation";
import { getMarketDetail } from "@/lib/store";
import { getBoundedMarkets } from "@/lib/bm/registry";
import { loadMarketCreatedAt } from "@/lib/bm/market-meta";
import { getSeriesForMarket } from "@/lib/bm/rounds-registry";
import { isHouseProduct, isNearChain } from "@/lib/near/config";
import { getNearSeriesForMarket } from "@/lib/near/registry";
import { MarketDetailClient } from "./market-detail";

export const dynamic = "force-dynamic";
// The "Open UP/DOWN market" server action waits for a testnet receipt.
export const maxDuration = 60;

export default async function MarketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // NEXT_PUBLIC_BM_NEAR_PRODUCT=house: the house ticket reads the chain in
  // the browser; the page only needs when the market went live.
  if (isHouseProduct()) return <HouseMarketPage id={id} />;
  const [detail, bounded, rounds] = await Promise.all([
    getMarketDetail(id),
    getBoundedMarkets(id).catch((err) => {
      // The registry schema not being reachable must not take the page down.
      console.error("[market] bounded markets failed", err);
      return [];
    }),
    // The running rounds series on this market, if any, with its rounds:
    // on NEAR testnet (NEXT_PUBLIC_BM_CHAIN=near) the 'near:testnet' rows,
    // otherwise the Solana ones as before.
    (isNearChain() ? getNearSeriesForMarket(id) : getSeriesForMarket(id)).catch((err) => {
      console.error("[market] rounds series failed", err);
      return null;
    }),
  ]);
  if (!detail) notFound();

  return (
    <MarketDetailClient
      market={detail.market}
      neighbors={detail.neighbors}
      parent={detail.parent}
      childMarkets={detail.children}
      captures={detail.captures}
      trends={detail.trends}
      bounded={bounded}
      rounds={rounds}
    />
  );
}

async function HouseMarketPage({ id }: { id: string }) {
  const [detail, createdAt] = await Promise.all([
    getMarketDetail(id),
    loadMarketCreatedAt(id).catch((err) => {
      console.error("[market] created_at failed", err);
      return null;
    }),
  ]);
  if (!detail) notFound();
  return (
    <MarketDetailClient
      market={detail.market}
      neighbors={detail.neighbors}
      parent={detail.parent}
      childMarkets={detail.children}
      captures={detail.captures}
      trends={detail.trends}
      bounded={[]}
      rounds={null}
      createdAt={createdAt}
    />
  );
}
