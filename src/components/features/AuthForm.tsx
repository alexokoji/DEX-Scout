"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/form";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function post(url: string, body?: object) {
    setBusy(true);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j.issues?.[0]?.message ?? j.error ?? "Request failed");
        return;
      }
      router.replace("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 fade-in">
      <div className="mb-6">
        <div className="text-lg font-semibold tracking-tight">
          DEX <span className="text-accent">Scout</span>
        </div>
        <p className="mt-1 text-xs text-muted">Low-cap DEX scanner, signals and automated trading.</p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void post(`/api/auth/${mode}`, { email: f.get("email"), password: f.get("password"), ...(mode === "register" ? { name: f.get("name") || undefined } : {}) });
        }}
      >
        {mode === "register" && (
          <div>
            <Label>Name</Label>
            <Input name="name" autoComplete="name" />
          </div>
        )}
        <div>
          <Label>Email</Label>
          <Input name="email" type="email" required autoComplete="email" />
        </div>
        <div>
          <Label hint={mode === "register" ? "(min 10 characters)" : undefined}>Password</Label>
          <Input name="password" type="password" required autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </div>
        <Button className="w-full" disabled={busy}>
          {mode === "login" ? "Sign in" : "Create account"}
        </Button>
      </form>
      <p className="mt-4 text-center text-xs text-muted">
        {mode === "login" ? (
          <>
            No account? <Link className="text-accent" href="/register">Register</Link>
          </>
        ) : (
          <>
            Have an account? <Link className="text-accent" href="/login">Sign in</Link>
          </>
        )}
      </p>
      <p className="mt-4 text-[11px] leading-relaxed text-muted">
        DEX Scout never asks for seed phrases or private keys. Trading is non-custodial: your wallet signs every live transaction.
      </p>
    </div>
  );
}
