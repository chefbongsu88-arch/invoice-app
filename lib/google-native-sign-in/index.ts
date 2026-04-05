import Constants from "expo-constants";
import { Platform, TurboModuleRegistry } from "react-native";

import * as WebStub from "./web-stub";

/** Thrown when native RNGoogleSignin is not in the binary — fall back to WebBrowser OAuth. */
export const NATIVE_GOOGLE_SIGNIN_UNAVAILABLE = "NATIVE_GOOGLE_SIGNIN_UNAVAILABLE";

type NativeImpl = typeof import("./native-impl");

let nativeImpl: NativeImpl | null | undefined;

function shouldUseNativeGoogleSignIn(): boolean {
  if (Platform.OS === "web") return false;
  if (Constants.executionEnvironment === "storeClient") return false;
  return true;
}

/** If missing, the native binary was built without @react-native-google-signin — never require() the JS package (getEnforcing throws). */
function hasRngoogleSigninNativeModule(): boolean {
  if (Platform.OS === "web") return false;
  try {
    return TurboModuleRegistry.get("RNGoogleSignin") != null;
  } catch {
    return false;
  }
}

function getNativeImpl(): NativeImpl | null {
  if (!shouldUseNativeGoogleSignIn()) return null;
  if (nativeImpl !== undefined) return nativeImpl;
  if (!hasRngoogleSigninNativeModule()) {
    nativeImpl = null;
    return null;
  }
  try {
    // Must not be named index.native.ts — Metro would resolve the package to that file and skip this wrapper.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeImpl = require("./native-impl") as NativeImpl;
  } catch {
    nativeImpl = null;
  }
  return nativeImpl;
}

export function configureGoogleSignInForGmail(webClientId: string) {
  getNativeImpl()?.configureGoogleSignInForGmail(webClientId);
}

export async function signInWithGoogleForGmailAndSheets(): Promise<{
  accessToken: string;
  email: string;
}> {
  const impl = getNativeImpl();
  if (!impl) {
    throw new Error(NATIVE_GOOGLE_SIGNIN_UNAVAILABLE);
  }
  return impl.signInWithGoogleForGmailAndSheets();
}

export function isGoogleSignInCancelled(err: unknown): boolean {
  if (err instanceof Error && err.message === NATIVE_GOOGLE_SIGNIN_UNAVAILABLE) {
    return false;
  }
  const impl = getNativeImpl();
  if (!impl) return WebStub.isGoogleSignInCancelled(err);
  return impl.isGoogleSignInCancelled(err);
}

export async function signOutGoogleNative(): Promise<void> {
  const impl = getNativeImpl();
  if (!impl) {
    await WebStub.signOutGoogleNative();
    return;
  }
  await impl.signOutGoogleNative();
}
