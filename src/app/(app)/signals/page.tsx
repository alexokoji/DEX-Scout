import { TokenListPage } from "@/components/features/TokenListPage";
import { requireUser } from "@/lib/auth";

export default async function SignalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  return (
    <TokenListPage
      searchParams={await searchParams}
      basePath="/signals"
      title="Signals"
      subtitle="Active BUY and WATCH signals. Scores are analytical rankings, not probabilities of profit. Every trade is your decision in Manual mode."
      defaults={{ passing: "true", signal: "ANY", sort: "opportunityScore" }}
    />
  );
}
