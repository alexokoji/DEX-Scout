import { Shell } from "@/components/layout/Shell";
import { WalletProviders } from "@/components/layout/WalletProviders";
import { requireUser } from "@/lib/auth";
import { env, liveTradingAllowed } from "@/lib/env";
import { getSettings } from "@/services/settings";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const settings = await getSettings(user.id);
  const mode = settings.autoTradingEnabled ? settings.environment : "MANUAL";
  return (
    <WalletProviders>
      <Shell mock={env().MOCK_PROVIDER} liveEnabled={liveTradingAllowed()} email={user.email} mode={mode}>
        {children}
      </Shell>
    </WalletProviders>
  );
}
