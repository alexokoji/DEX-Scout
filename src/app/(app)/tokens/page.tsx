import { TokenListPage } from "@/components/features/TokenListPage";
import { requireUser } from "@/lib/auth";

export default async function TokensPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  return (
    <TokenListPage
      searchParams={await searchParams}
      basePath="/tokens"
      title="Tokens"
      subtitle="Browse and search all tracked tokens. Open one for charts, safety analysis and the trade panel."
      defaults={{ passing: "true", sort: "marketCapUsd", trust: "TRUSTED" }}
    />
  );
}
