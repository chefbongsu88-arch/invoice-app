import { Tabs } from "expo-router";
import { Platform, View } from "react-native";

import { HapticTab } from "@/components/haptic-tab";
import { OfflineBanner } from "@/components/offline-banner";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";

export default function TabLayout() {
  const colors = useColors();
  /**
   * Do not set height / paddingBottom from safe-area here — @react-navigation/bottom-tabs already
   * applies `insets.bottom` inside BottomTabBar. Adding both caused a visible empty strip under the bar on iOS.
   */
  const tabBarStyle =
    Platform.OS === "web"
      ? {
          paddingTop: 8,
          paddingBottom: 12,
          minHeight: 56 + 12,
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 0.5,
        }
      : {
          paddingTop: 6,
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 0.5,
        };

  return (
    <View style={{ flex: 1 }}>
      <OfflineBanner />
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarStyle,
        /** Equal width per tab so the bar doesn’t leave a dead zone on the right (iOS). */
        tabBarItemStyle: Platform.OS === "web" ? undefined : { flex: 1 },
        tabBarLabelStyle: {
          fontSize: 9,
          fontWeight: "600",
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="house.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="receipts"
        options={{
          title: "Receipts",
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="doc.text.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: "Scan",
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="camera.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="statistics"
        options={{
          title: "Stats",
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="chart.bar.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="gearshape.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="gmail"
        options={{
          title: "gmail",
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="envelope.fill" color={color} />,
        }}
      />
    </Tabs>
    </View>
  );
}
