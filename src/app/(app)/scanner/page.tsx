import { TokenListPage } from "@/components/features/TokenListPage";
import { requireUser } from "@/lib/auth";

export default async function ScannerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  return (
    <TokenListPage
      searchParams={await searchParams}
      basePath="/scanner"
      title="Scanner"
      subtitle="Tokens the scanner has discovered and independent checks have cleared. Switch the Trust filter to see the rest. Rows update as the background scanner runs."
      defaults={{ passing: "false", sort: "poolCreatedAt", showStage: true, trust: "TRUSTED" }}
    />
  );
}
