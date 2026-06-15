import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import {
  getFirestore,
  type Firestore,
} from "firebase-admin/firestore";

let _app: App | undefined;
let _db: Firestore | undefined;

function getAdminApp(): App {
  if (_app) return _app;
  if (getApps().length > 0) {
    _app = getApps()[0];
    return _app;
  }
  _app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID!,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
  return _app;
}

/** Lazily initialised Firestore admin instance. */
export function getAdminDb(): Firestore {
  if (_db) return _db;
  _db = getFirestore(getAdminApp());
  return _db;
}

// Re-export a getter-based proxy so existing `adminDb` imports keep working
// at runtime but don't trigger initialization at build/import time.
export const adminDb = new Proxy({} as Firestore, {
  get(_target, prop, receiver) {
    const db = getAdminDb();
    const value = Reflect.get(db, prop, receiver);
    if (typeof value === "function") {
      return value.bind(db);
    }
    return value;
  },
});
