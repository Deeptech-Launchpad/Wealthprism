import React, { useEffect, useState } from "react";
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { StatusBar } from "expo-status-bar";
import { Text } from "react-native";
import { session } from "./src/lib/api";
import { registerForPush, onNotificationTap } from "./src/lib/push";
import { LoginScreen } from "./src/screens/Login";
import { DashboardScreen } from "./src/screens/Dashboard";
import { HoldingsScreen } from "./src/screens/Holdings";
import { RealEstateScreen } from "./src/screens/RealEstate";
import { TasksScreen } from "./src/screens/Tasks";
import { ApprovalsScreen } from "./src/screens/Approvals";
import { MoreScreen } from "./src/screens/More";
import { PlansScreen } from "./src/screens/Plans";
const Tab = createBottomTabNavigator();
const navRef = createNavigationContainerRef<any>();
const icon = (glyph: string) => ({ color }: { color: string }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;
export default function App() {
  const [ready, setReady] = useState(false); const [authed, setAuthed] = useState(false);
  useEffect(() => { session.load().then((s) => { setAuthed(!!s); setReady(true); }); }, []);
  // after sign-in: register this device for push; a tapped task notification opens the Tasks tab
  useEffect(() => { if (!authed) return; registerForPush().catch(() => {}); return onNotificationTap(() => { if (navRef.isReady()) navRef.navigate("Tasks"); }); }, [authed]);
  if (!ready) return null;
  if (!authed) return <LoginScreen onDone={() => setAuthed(true)} />;
  return (
    <NavigationContainer ref={navRef}>
      <StatusBar style="light" />
      <Tab.Navigator screenOptions={{ headerStyle: { backgroundColor: "#12213A" }, headerTintColor: "#fff", tabBarActiveTintColor: "#12213A", tabBarInactiveTintColor: "#6B7686" }}>
        <Tab.Screen name="Dashboard" component={DashboardScreen} options={{ tabBarIcon: icon("◫") }} />
        <Tab.Screen name="Holdings" component={HoldingsScreen} options={{ tabBarIcon: icon("▤") }} />
        <Tab.Screen name="Property" component={RealEstateScreen} options={{ tabBarIcon: icon("⌂") }} />
        <Tab.Screen name="Approvals" component={ApprovalsScreen} options={{ tabBarIcon: icon("⚡") }} />
        <Tab.Screen name="Plans" component={PlansScreen} options={{ tabBarIcon: icon("◎") }} />
        <Tab.Screen name="Tasks" component={TasksScreen} options={{ tabBarIcon: icon("✓") }} />
        <Tab.Screen name="More" options={{ tabBarIcon: icon("⋯") }}>{() => <MoreScreen onSignOut={() => setAuthed(false)} />}</Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
  );
}
