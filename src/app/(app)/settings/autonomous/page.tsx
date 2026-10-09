import { AutonomousPanel } from "@/components/features/AutonomousPanel";
import { PageHeader } from "@/components/features/PageHeader";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AutonomousPage() {
  await requireUser();
  return (
    <div className="space-y-4">
      <PageHeader title="Unattended trading" subtitle="Let the bot trade with its own wallet, without asking you to sign each trade, toward a daily profit target and inside a daily loss limit." />
      <AutonomousPanel />
    </div>
  );
}
