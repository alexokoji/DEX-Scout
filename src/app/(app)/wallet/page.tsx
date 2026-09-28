import { PageHeader } from "@/components/features/PageHeader";
import { PendingApprovals } from "@/components/features/PendingApprovals";
import { WalletPanel } from "@/components/features/WalletPanel";
import { Badge } from "@/components/ui/badges";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/card";
import { CHAINS } from "@/core/chains";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { shortAddr, usd } from "@/lib/format";
import { portfolio, walletBalances } from "@/services/queries";

export default async function WalletPage() {
  const user = await requireUser();
  const [wallets, pf, wb] = await Promise.all([
    db.wallet.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }),
    portfolio(user.id, liveTradingAllowed() ? "LIVE" : "PAPER"),
    walletBalances(user.id),
  ]);
  return (
    <div className="space-y-4">
      <PageHeader title="Wallets" subtitle="Non-custodial and multi-chain (Solana + EVM). Your wallet signs every live transaction; DEX Scout never sees keys or seed phrases." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Connected wallet balance" value={pf.wallet?.balanceUsd != null ? usd(pf.wallet.balanceUsd) : "—"} sub={pf.wallet ? pf.wallet.summary || "empty" : "no linked wallet"} />
        <Stat label="Trading allocation" value={usd(pf.capital.capitalUsd)} sub="cap for the bot" />
        <Stat label="Open position value" value={usd(pf.openPositionValueUsd)} />
        <Stat label="Available capital" value={usd(pf.capital.availableUsd)} />
      </div>
      <PendingApprovals />
      <WalletPanel linked={wallets.map((w) => ({ address: w.address, family: w.chain }))} />
      <Card>
        <CardHeader title="Linked wallets" />
        <div className="divide-y divide-border">
          {wallets.map((w) => (
            <div key={w.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="num">{shortAddr(w.address)}</span>
              <span className="flex items-center gap-2">
                <Badge>{w.chain === "evm" ? "EVM (all EVM chains)" : "Solana"}</Badge>
                <Badge tone="blue">verified</Badge>
              </span>
            </div>
          ))}
          {!wallets.length && <div className="px-4 py-6 text-center text-xs text-muted">No wallets linked yet.</div>}
        </div>
      </Card>
      {wb.balances.length > 0 && (
        <Card>
          <CardHeader title="Native balances by chain" sub="Gas/native token only; not part of your trading allocation." />
          <div className="divide-y divide-border text-sm">
            {wb.balances.map((b) => (
              <div key={`${b.address}:${b.chain}`} className="flex items-center justify-between px-4 py-2">
                <span>{CHAINS[b.chain as keyof typeof CHAINS].name}</span>
                <span className="num">{b.amount.toFixed(4)} {b.symbol} <span className="text-muted">({usd(b.usd)})</span></span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <CardHeader title="How wallet authorization works" />
        <CardBody className="space-y-2 text-xs leading-relaxed text-muted">
          <p><span className="text-foreground">No keys, no withdrawals.</span> The server stores only your public addresses. It never receives a seed phrase, private key or wallet password.</p>
          <p><span className="text-foreground">Manual LIVE trades:</span> the server validates limits and builds an unsigned swap for the token&apos;s chain (Jupiter on Solana, 0x on EVM chains); your wallet shows it and you approve or reject it. On EVM the wallet may first ask for a token approval.</p>
          <p><span className="text-foreground">Auto LIVE trades:</span> the bot prepares unsigned transactions and places them in the approval queue above. They execute only after your wallet signs. There is no delegated authority that could withdraw funds.</p>
          <p><span className="text-foreground">Paper trading</span> needs no wallet and moves no funds; every paper trade is labelled and has no transaction signature.</p>
          <p>LIVE mode is {liveTradingAllowed() ? "enabled on this server." : "disabled on this server (requires LIVE_TRADING_ENABLED=true and MOCK_PROVIDER=false)."}</p>
        </CardBody>
      </Card>
    </div>
  );
}
