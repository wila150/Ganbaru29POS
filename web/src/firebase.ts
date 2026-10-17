import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, GoogleAuthProvider } from "firebase/auth";
import { connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { connectStorageEmulator, getStorage } from "firebase/storage";

const env = import.meta.env;

/** 從主畫面開啟的 App（iPad / iPhone）—— 沒有彈出視窗，Google 登入改用同網域的轉址登入。 */
export const isStandalone = typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
const sameOriginAuth = isStandalone && /\.(web\.app|firebaseapp\.com)$/.test(location.hostname);

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: sameOriginAuth ? location.hostname : env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

// Offline cache so the catalogue and today's records still show when the shop wifi drops.
export const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
export const storage = getStorage(app);
export const functions = getFunctions(app, "asia-east1");

if (env.VITE_USE_EMULATORS === "true") {
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "localhost", 8080);
  connectFunctionsEmulator(functions, "localhost", 5001);
  connectStorageEmulator(storage, "localhost", 9199);
}

/** Call a Cloud Function and turn its error into a readable Chinese message. */
export async function call<T = unknown>(name: string, data?: unknown): Promise<T> {
  try {
    const res = await httpsCallable(functions, name, { timeout: 540_000 })(data);
    return res.data as T;
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    if (!navigator.onLine || err.code === "functions/unavailable" || err.code === "functions/deadline-exceeded") throw new Error("網路連不上，請檢查連線後再試");
    throw new Error(err.message || "發生錯誤");
  }
}
