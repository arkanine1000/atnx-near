import { loadMarketMeta } from "@/lib/bm/market-meta";
import { OnchainPortfolio } from "@/components/bm/OnchainPortfolio";
import { RoundsPortfolio, type PortfolioSeries } from "@/components/rounds/RoundsPortfolio";
import { NearRoundsPortfolio, type NearPortfolioSeries } from "@/components/rounds/NearRoundsPortfolio";
import { HousePortfolio, type HousePortfolioMarket } from "@/components/house/HousePortfolio";
import { referenceToUuid } from "@/lib/bm/house-types";
import { isHouseProduct, isNearChain, isNearHouseDeployed, isNearRoundsDeployed } from "@/lib/near/config";
import { houseContractMissing, houseViewer } from "@/lib/near/house";
import { listNearSeries } from "@/lib/near/registry";
import { listSeriesWithPubkey } from "@/lib/bm/rounds-registry";
import { listAll } from "@/lib/bm/registry";
import { BM_CHAINS, isRoundsDeployed } from "@/lib/bm/chains";
import type { BmMarketListing } from "@/lib/bm/listing";

export const dynamic = "force-dynamic";

// The wallet's shares, read from the chain in the browser. The server
// only supplies the registry (which on-chain market belongs to which
// atnx market), so the list is right even when the wallet changes.
async function loadListing(): Promise<BmMarketListing[]> {
  try {
    const rows = await listAll(200);
    const ids = Array.from(new Set(rows.map((r) => r.atnx_market_id)));
    const names = await loadMarketMeta(ids);
    return rows.map((r) => {
      const m = names.get(r.atnx_market_id);
      return {
        id: r.id,
        atnxMarketId: r.atnx_market_id,
        name: m?.name ?? "Unknown market",
        thumbnailUrl: m?.thumb ?? null,
        currentVi: m?.vi ?? 0,
        chain: r.chain,
        chainLabel: BM_CHAINS[r.chain as keyof typeof BM_CHAINS]?.label ?? r.chain,
        contractAddress: r.contract_address,
        onchainMarketId: r.onchain_market_id,
        state: r.state,
        startVi: Number(r.start_vi),
        lower: Number(r.lower_bound),
        upper: Number(r.upper_bound),
        resolvedSide: r.resolved_side,
        resolvedVi: r.resolved_vi === null ? null : Number(r.resolved_vi),
        createdAt: r.created_at,
      };
    });
  } catch (err) {
    console.error("[portfolio] listing failed", err);
    return [];
  }
}

// The running rounds series by on-chain key, with the market's name and
// picture, so a position found on chain can name its market, including
// positions in series that have since ended.
async function loadSeries(): Promise<PortfolioSeries[]> {
  if (!isRoundsDeployed()) return [];
  try {
    const rows = await listSeriesWithPubkey();
    const names = await loadMarketMeta(Array.from(new Set(rows.map((s) => s.atnx_market_id))));
    return rows.map((s) => {
      const m = names.get(s.atnx_market_id);
      return { seriesPubkey: s.series_pubkey!, atnxMarketId: s.atnx_market_id, name: m?.name ?? "Unknown market", thumb: m?.thumb ?? null, fast: s.fast };
    });
  } catch (err) {
    console.error("[portfolio] rounds series failed", err);
    return [];
  }
}

// The NEAR series by registry reference (positions_of names the series by
// its on-chain id; the ticket reads the reference back from the chain).
async function loadNearSeries(): Promise<NearPortfolioSeries[]> {
  if (!isNearRoundsDeployed()) return [];
  try {
    const rows = await listNearSeries();
    const names = await loadMarketMeta(Array.from(new Set(rows.map((s) => s.atnx_market_id))));
    return rows.map((s) => {
      const m = names.get(s.atnx_market_id);
      return { reference: s.reference, atnxMarketId: s.atnx_market_id, name: m?.name ?? "Unknown market", thumb: m?.thumb ?? null, fast: s.fast };
    });
  } catch (err) {
    console.error("[portfolio] NEAR rounds series failed", err);
    return [];
  }
}

// The house's markets with their atnx.app names and pictures, so a position
// read from the chain can name its market (NEXT_PUBLIC_BM_NEAR_PRODUCT=
// house). Read from the contract's list_markets, 100 at a time; empty when
// the contract is not there yet.
async function loadHouseMarkets(): Promise<HousePortfolioMarket[]> {
  if (!isNearHouseDeployed()) return [];
  try {
    const v = houseViewer();
    const all = [];
    for (let from = 0; from < 10_000; from += 100) {
      const page = await v.listMarkets(from, 100);
      all.push(...page);
      if (page.length < 100) break;
    }
    const uuid = new Map(all.map((m) => [m.id, referenceToUuid(m.reference)]));
    const names = await loadMarketMeta(Array.from(new Set(uuid.values())));
    return all.map((m) => {
      const id = uuid.get(m.id)!;
      const meta = names.get(id);
      return { id: m.id, atnxMarketId: id, name: meta?.name ?? "Unknown market", thumb: meta?.thumb ?? null };
    });
  } catch (err) {
    if (!houseContractMissing(err)) console.error("[portfolio] house markets failed", err);
    return [];
  }
}

export default async function PortfolioPage() {
  if (isHouseProduct()) return <HousePortfolioPage />;
  if (isNearChain()) return <NearPortfolioPage />;
  const [markets, series] = await Promise.all([loadListing(), loadSeries()]);
  return (
    <section>
      <div className="mb-5">
        <h2 className="font-display text-xl sm:text-2xl font-bold text-primary tracking-tight">Portfolio</h2>
      </div>
      {isRoundsDeployed() && (
        <div className="mb-10">
          <h3 className="font-display text-lg font-bold text-primary mb-3">
            Rounds <span className="font-sans text-sm font-normal text-tertiary">· Solana devnet</span>
          </h3>
          <RoundsPortfolio series={series} />
        </div>
      )}
      {isRoundsDeployed() && (
        <h3 className="font-display text-lg font-bold text-primary mb-3">
          Bounded markets <span className="font-sans text-sm font-normal text-tertiary">· EVM testnets</span>
        </h3>
      )}
      <OnchainPortfolio markets={markets} />
    </section>
  );
}

// NEXT_PUBLIC_BM_CHAIN=near: the rounds on NEAR testnet, then the bounded
// markets as before.
async function NearPortfolioPage() {
  const [markets, series] = await Promise.all([loadListing(), loadNearSeries()]);
  const rounds = isNearRoundsDeployed();
  return (
    <section>
      <div className="mb-5">
        <h2 className="font-display text-xl sm:text-2xl font-bold text-primary tracking-tight">Portfolio</h2>
      </div>
      {rounds && (
        <div className="mb-10">
          <h3 className="font-display text-lg font-bold text-primary mb-3">
            Rounds <span className="font-sans text-sm font-normal text-tertiary">· NEAR testnet</span>
          </h3>
          <NearRoundsPortfolio series={series} />
        </div>
      )}
      {rounds && (
        <h3 className="font-display text-lg font-bold text-primary mb-3">
          Bounded markets <span className="font-sans text-sm font-normal text-tertiary">· EVM testnets</span>
        </h3>
      )}
      <OnchainPortfolio markets={markets} />
    </section>
  );
}

// NEXT_PUBLIC_BM_NEAR_PRODUCT=house: the house positions on NEAR testnet,
// alone, so the build shows one product.
async function HousePortfolioPage() {
  const markets = await loadHouseMarkets();
  return (
    <section>
      <div className="mb-5">
        <h2 className="font-display text-xl sm:text-2xl font-bold text-primary tracking-tight">Portfolio</h2>
      </div>
      <HousePortfolio markets={markets} />
    </section>
  );
}
