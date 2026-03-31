import { Pressable, StyleSheet, Text, View } from "react-native";
import { useOfflineSync } from "@/hooks/use-offline-sync";

export function OfflineBanner() {
  const { isOnline, uploadStatus, retryUpload } = useOfflineSync();

  if (!isOnline) {
    return (
      <View style={[styles.banner, styles.offline]}>
        <Text style={styles.text}>
          You're offline — Invoice saved locally. Will upload automatically when connected.
        </Text>
      </View>
    );
  }

  if (uploadStatus === "uploading") {
    return (
      <View style={[styles.banner, styles.uploading]}>
        <Text style={styles.text}>Uploading offline invoices...</Text>
      </View>
    );
  }

  if (uploadStatus === "success") {
    return (
      <View style={[styles.banner, styles.success]}>
        <Text style={styles.text}>✅ Offline invoices uploaded successfully</Text>
      </View>
    );
  }

  if (uploadStatus === "failed") {
    return (
      <Pressable style={[styles.banner, styles.error]} onPress={retryUpload}>
        <Text style={styles.text}>
          ❌ Failed to upload offline invoices. Tap to retry.
        </Text>
      </Pressable>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: "center",
  },
  offline:   { backgroundColor: "#DC2626" },
  uploading: { backgroundColor: "#2563EB" },
  success:   { backgroundColor: "#16A34A" },
  error:     { backgroundColor: "#B91C1C" },
  text: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "500",
    textAlign: "center",
    lineHeight: 18,
  },
});
