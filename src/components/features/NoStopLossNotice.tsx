export function NoStopLossNotice() {
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-xs leading-relaxed">
      <span className="font-semibold text-accent">No automatic stop loss.</span> A position that is down 5%, 10% or 20% stays open while there is no
      profit target reached and no emergency condition. Separately, optional <span className="font-semibold">emergency protection</span> watches for
      catastrophic events only (untradeable token, pool gone, sell simulation failing, severe liquidity collapse, critical security condition).
      Holding a loser can mean it never recovers — that risk is yours to manage.
    </div>
  );
}