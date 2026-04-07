/** Web: OAuth is handled in `gmail.tsx` via WebBrowser — no native Google Sign-In module. */

export async function configureGoogleSignInForGmail(
  _webClientId: string,
  _options?: { iosClientId?: string },
) {}

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
