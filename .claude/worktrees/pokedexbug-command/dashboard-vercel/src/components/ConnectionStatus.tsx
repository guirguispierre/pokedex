"use client";

import { useEffect, useState } from "react";
import { db } from "@/lib/firebase-client";
import { collection, onSnapshot, limit, query } from "firebase/firestore";

type Status = "connected" | "reconnecting" | "disconnected";

export default function ConnectionStatus() {
  const [status, setStatus] = useState<Status>("reconnecting");

  useEffect(() => {
    const q = query(collection(db, "__connection_check"), limit(1));

    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (snapshot.metadata.fromCache) {
          setStatus("reconnecting");
        } else {
          setStatus("connected");
        }
      },
      () => {
        setStatus("disconnected");
      }
    );

    return () => unsubscribe();
  }, []);

  const config: Record<Status, { color: string; label: string }> = {
    connected: { color: "bg-discord-green", label: "Live" },
    reconnecting: { color: "bg-discord-yellow", label: "Reconnecting..." },
    disconnected: { color: "bg-discord-red", label: "Disconnected" },
  };

  const { color, label } = config[status];

  return (
    <div className="flex items-center gap-2 text-xs text-discord-text-muted">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label}
    </div>
  );
}
