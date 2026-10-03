import { IntegrationsPanel } from "@/components/features/IntegrationsPanel";
import { PageHeader } from "@/components/features/PageHeader";
import { requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { integrationViews } from "@/lib/integrations";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  await requireUser();
  return (
    <div className="space-y-4">
      <PageHeader title="Integrations" subtitle="Every external service in one place: what's active, what's using a free built-in, and exactly where to get an optional key. Keys are set as environment variables on your host (Vercel → Settings → Environment Variables); values are never shown here." />
      <IntegrationsPanel items={integrationViews()} mock={env().MOCK_PROVIDER} />
    </div>
  );
}
