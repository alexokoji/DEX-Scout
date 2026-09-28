import { redirect } from "next/navigation";
import { AuthForm } from "@/components/features/AuthForm";
import { currentUser } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await currentUser()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <AuthForm mode="register" mock={env().MOCK_PROVIDER} />
    </main>
  );
}
