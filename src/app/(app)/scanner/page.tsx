import { TokenListPage } from "@/components/features/TokenListPage";
import { requireUser } from "@/lib/auth";

export default async function ScannerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  return (
    <TokenListPage
      searchParams={await searchParams}
      basePath="/scanner"
      title="Scanner"
      subtitle="Every token the scanner has discovered — no result cap. Rows update as the background scanner runs."
      defaults={{ passing: "false", sort: "poolCreatedAt", showStage: true }}
    />
  );
}
