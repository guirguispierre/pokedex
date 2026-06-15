"use client";

import { useEffect, useState } from "react";
import { db } from "@/lib/firebase-client";
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
  type WhereFilterOp,
  type OrderByDirection,
  type DocumentData,
} from "firebase/firestore";

interface CollectionConstraints {
  where?: [string, WhereFilterOp, unknown][];
  orderBy?: [string, OrderByDirection?];
  limit?: number;
}

interface FirestoreResult<T> {
  data: T[];
  loading: boolean;
  error: Error | null;
}

interface DocumentResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export function useCollection<T = DocumentData>(
  collectionName: string,
  constraints?: CollectionConstraints
): FirestoreResult<T> {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const constraintsKey = JSON.stringify(constraints);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const queryConstraints = [];

    if (constraints?.where) {
      for (const [field, op, value] of constraints.where) {
        queryConstraints.push(where(field, op, value));
      }
    }

    if (constraints?.orderBy) {
      queryConstraints.push(orderBy(constraints.orderBy[0], constraints.orderBy[1]));
    }

    if (constraints?.limit) {
      queryConstraints.push(firestoreLimit(constraints.limit));
    }

    const q = query(collection(db, collectionName), ...queryConstraints);

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const docs = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        })) as T[];
        setData(docs);
        setLoading(false);
        setError(null);
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionName, constraintsKey]);

  return { data, loading, error };
}

export function useDocument<T = DocumentData>(
  collectionName: string,
  docId: string | null
): DocumentResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(docId !== null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!docId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    const docRef = doc(db, collectionName, docId);

    const unsubscribe = onSnapshot(
      docRef,
      (snapshot) => {
        if (snapshot.exists()) {
          setData({ id: snapshot.id, ...snapshot.data() } as T);
        } else {
          setData(null);
        }
        setLoading(false);
        setError(null);
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [collectionName, docId]);

  return { data, loading, error };
}
