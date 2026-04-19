import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
import { Platform } from "react-native";

const GMAIL_SHEETS_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/spreadsheets",
];

type ConfigureOptions = {
  iosClientId?: string;
};

export async function configureGoogleSignInForGmail(
  webClientId: string,
  options?: ConfigureOptions,
) {
  const cfg: {
    webClientId: string;
    iosClientId?: string;
    scopes: string[];
    offlineAccess: boolean;
  } = {
    webClientId,
    scopes: GMAIL_SHEETS_SCOPES,
    offlineAccess: false,
  };
  const iosClientId = options?.iosClientId?.trim();
  if (iosClientId) {
    cfg.iosClientId = iosClientId;
  }
  await Promise.resolve(GoogleSignin.configure(cfg));
}

export async function signInWithGoogleForGmailAndSheets(): Promise<{
  accessToken: string;
  email: string;
  name?: string;
}> {
  if (Platform.OS === "android") {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  }

  const response = await GoogleSignin.signIn();
  if (response.type !== "success") {
    throw new Error("cancelled");
  }

  const tokens = await GoogleSignin.getTokens();
  if (!tokens.accessToken) {
    throw new Error(
      "Google Sign-In did not return an access token. Check OAuth client and scopes in Google Cloud.",
    );
  }

  const email = response.data.user.email;
  const rawName = response.data.user.name;
  const given = response.data.user.givenName;
  const family = response.data.user.familyName;
  const joined = [given, family].filter((p): p is string => typeof p === "string" && p.trim().length > 0).join(" ").trim();
  const name = (typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : joined) || undefined;
  return { accessToken: tokens.accessToken, email, name };
}

export function isGoogleSignInCancelled(err: unknown): boolean {
  if (err instanceof Error && err.message === "cancelled") return true;
  const code = (err as { code?: string })?.code;
  return code === statusCodes.SIGN_IN_CANCELLED;
}

export async function signOutGoogleNative(): Promise<void> {
  try {
    await GoogleSignin.signOut();
  } catch {
    /* noop */
  }
}
