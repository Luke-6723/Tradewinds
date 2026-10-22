"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNote } from "@/components/kibb/bits";
import { dash } from "@/lib/kibb/browser";

const HANDLE_RE = /^[A-Za-z0-9_.-]{3,32}$/;

export default function RegisterPage() {
  const router = useRouter();
  const [handle,     setHandle]     = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm,    setConfirm]    = useState("");
  const [error,      setError]      = useState<string | null>(null);
  const [loading,    setLoading]    = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!HANDLE_RE.test(handle)) {
      setError("Handle must be 3–32 characters: letters, numbers, _ . -");
      return;
    }
    if (passphrase.length < 8) {
      setError("Passphrase must be at least 8 characters.");
      return;
    }
    if (passphrase !== confirm) {
      setError("Passphrases don't match.");
      return;
    }
    setLoading(true);
    try {
      await dash.post("/api/kibb/auth/register", { handle, passphrase });
      router.push("/companies/new");
    } catch (err) {
      setError((err as Error).message || "Registration failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-6 shadow-lg">
      <h2 className="mb-5 font-semibold text-lg">Create account</h2>
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
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="8+ characters"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">Confirm passphrase</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        <ErrorNote error={error} />

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Creating account…" : "Create account"}
        </Button>
      </form>

      <p className="mt-4 text-center text-muted-foreground text-sm">
        Already have an account?{" "}
        <Link href="/login" className="text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
