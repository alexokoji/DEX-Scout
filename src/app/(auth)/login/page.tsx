import { redirect } from "next/navigation";
import { AuthForm } from "@/components/features/AuthForm";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentUser()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <AuthForm mode="login" />
    </main>
  );
}
