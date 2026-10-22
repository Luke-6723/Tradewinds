"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNote, NativeSelect } from "@/components/kibb/bits";
import { useCatalog } from "@/hooks/use-catalog";
import { dash } from "@/lib/kibb/browser";
import type { CreateCompanyResult } from "@/lib/kibb/types";

/** Phase-1 coastal ports a company may be founded at. */
const STARTER_PORTS = ["le_havre", "portsmouth", "london", "dover", "calais", "dunkirk", "ostend", "amsterdam", "hamburg"];

export default function NewCompanyPage() {
  const { catalog, portName, goodName } = useCatalog();
  const [name,       setName]       = useState("");
  const [homePortId, setHomePortId] = useState("le_havre");
  const [shipName,   setShipName]   = useState("");
  const [error,      setError]      = useState<string | null>(null);
  const [loading,    setLoading]    = useState(false);

  const home = catalog?.ports.find((p) => p.id === homePortId);
  const makes = [...(home?.produces ?? []), ...(home?.manufactures ?? [])];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await dash.post<CreateCompanyResult>("/api/kibb/companies", {
        name: name.trim(),
        home_port_id: homePortId,
        starter_ship_name: shipName.trim() || undefined,
      });
      window.location.href = "/dashboard";
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-6 shadow-lg">
      <h2 className="mb-1 font-semibold text-lg">Found a company</h2>
      <p className="mb-5 text-muted-foreground text-sm">7,500 Cr and a hoy (4 guns, 8 t of stores). Names are unique server-wide.</p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name">Company name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hawkins Maritime" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="home">Home port</Label>
          <NativeSelect id="home" value={homePortId} onChange={(e) => setHomePortId(e.target.value)}>
            {STARTER_PORTS.map((id) => (
              <option key={id} value={id}>
                {portName(id)}
              </option>
            ))}
          </NativeSelect>
          <p className="text-muted-foreground text-xs">
            {homePortId === "le_havre"
              ? "Starts the hoy at the provisions source for the Portsmouth charter. "
              : ""}
            {makes.length > 0 && `Makes ${makes.map(goodName).join(", ")}.`}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ship">Starter ship name</Label>
          <Input id="ship" value={shipName} onChange={(e) => setShipName(e.target.value)} placeholder="Endeavour (optional)" />
        </div>

        <ErrorNote error={error} />

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" render={<Link href="/companies" />}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={loading || !name.trim()}>
            {loading ? "Founding…" : "Found company"}
          </Button>
        </div>
      </form>
    </div>
  );
}
