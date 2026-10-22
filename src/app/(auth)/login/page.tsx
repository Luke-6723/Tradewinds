"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNote } from "@/components/kibb/bits";
import { dash } from "@/lib/kibb/browser";

export default function LoginPage() {
  const router = useRouter();
  const [handle,     setHandle]     = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error,      setError]      = useState<string | null>(null);
  const [loading,    setLoading]    = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await dash.post("/api/kibb/auth/login", { handle, passphrase });
      router.push("/companies");
    } catch (err) {
      setError((err as Error).message || "Sign-in failed. Check your handle and passphrase.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-6 shadow-lg">
      <h2 className="mb-5 font-semibold text-lg">Sign in</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="handle">Handle</Label>
          <Input
            id="handle"
            autoComplete="username"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="hawkins"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="passphrase">Passphrase</Label>
          <Input
            id="passphrase"
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="••••••••"
            required
          />
        </div>

        <ErrorNote error={error} />

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-muted-foreground text-xs">
          Your passphrase goes straight to kibb.io and is never saved. Logins are rate limited (12 a minute).
        </p>
      </form>

      <p className="mt-4 text-center text-muted-foreground text-sm">
        No account?{" "}
        <Link href="/register" className="text-primary underline-offset-4 hover:underline">
          Register
        </Link>
      </p>
    </div>
  );
}
