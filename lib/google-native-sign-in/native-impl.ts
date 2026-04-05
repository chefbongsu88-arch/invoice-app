import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
import { Platform } from "react-native";

const GMAIL_SHEETS_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/spreadsheets",
];

export function configureGoogleSignInForGmail(webClientId: string) {
  GoogleSignin.configure({
    webClientId,
    scopes: GMAIL_SHEETS_SCOPES,
    offlineAccess: false,
  });
}

export async function signInWithGoogleForGmailAndSheets(): Promise<{
  accessToken: string;
  email: string;
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
  return { accessToken: tokens.accessToken, email };
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
