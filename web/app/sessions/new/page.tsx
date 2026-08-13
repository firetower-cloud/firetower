"use client";

import { Suspense } from "react";
import { Booting } from "@/components/Booting";

export default function NewSessionPage() {
  return (
    <Suspense fallback={null}>
      <Booting />
    </Suspense>
  );
}
