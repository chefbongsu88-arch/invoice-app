/** Web: OAuth is handled in `gmail.tsx` via WebBrowser — no native Google Sign-In module. */

export function configureGoogleSignInForGmail(_webClientId: string) {}

export async function signInWithGoogleForGmailAndSheets(): Promise<{
  accessToken: string;
  email: string;
}> {
  throw new Error("Use web OAuth flow on web");
}

export function isGoogleSignInCancelled(_err: unknown): boolean {
  return false;
}

export async function signOutGoogleNative(): Promise<void> {}
