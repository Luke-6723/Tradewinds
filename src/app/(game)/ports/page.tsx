"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { worldApi } from "@/lib/api/world";
import type { Port } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { MapPinIcon } from "lucide-react";

export default function PortsPage() {
  const [ports, setPorts] = useState<Port[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    worldApi.getPorts().then(setPorts).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Ports</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ports.map((port) => (
          <Link key={port.id} href={`/ports/${port.id}`}>
            <Card className="cursor-pointer transition-colors hover:bg-accent/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPinIcon className="size-4 text-muted-foreground" />
                  {port.name}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{port.shortcode}</Badge>
                  {port.is_hub && <Badge variant="outline">Hub</Badge>}
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
