import { PageHeader } from "@/components/features/PageHeader";
import { TradingSettingsForm } from "@/components/features/TradingSettingsForm";
import { requireUser } from "@/lib/auth";
import { liveTradingAllowed } from "@/lib/env";
import { getSettings } from "@/services/settings";

export default async function TradingSettingsPage() {
  const user = await requireUser();
  const { id: _id, userId: _uid, ...settings } = await getSettings(user.id);
  void _id;
  void _uid;
  return (
    <div className="space-y-4">
      <PageHeader title="Trading settings" subtitle="Capital limits, entry rules, scanner filters, profit targets and emergency protection." />
      <TradingSettingsForm initial={settings} liveEnabled={liveTradingAllowed()} />
    </div>
  );
}