// NativeWind already applies `cssInterop(Pressable, …)` in react-native-css-interop.
// A second `remapProps(Pressable, …)` here overlapped that and caused iOS Fabric crashes:
// "Property 'Pressable' doesn't exist". Do not re-add remapProps on Pressable.
export {};
