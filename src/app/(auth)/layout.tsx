import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight">⚓ Tradewinds</h1>
          <p className="mt-1 text-sm text-muted-foreground">The trading seas await</p>
        </div>
        {children}
      </div>
    </div>
  );
}
