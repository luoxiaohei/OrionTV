import React, { useCallback } from "react";
import { View, Switch, StyleSheet, Pressable, Animated, Platform, TouchableOpacity } from "react-native";
import { useTVEventHandler } from "react-native";
import { ThemedText } from "@/components/ThemedText";
import { SettingsSection } from "./SettingsSection";
import { useSettingsStore } from "@/stores/settingsStore";
import { useButtonAnimation } from "@/hooks/useAnimation";
import { Colors } from "@/constants/Colors";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";

interface SourceOptimizationSectionProps {
  onChanged: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export const SourceOptimizationSection: React.FC<SourceOptimizationSectionProps> = ({
  onChanged,
  onFocus,
  onBlur,
}) => {
  const enabled = useSettingsStore((s) => s.enableSourceOptimization);
  const setEnabled = useSettingsStore((s) => s.setEnableSourceOptimization);
  const [isFocused, setIsFocused] = React.useState(false);
  const animationStyle = useButtonAnimation(isFocused, 1.2);
  const deviceType = useResponsiveLayout().deviceType;

  const handleToggle = useCallback(
    (next: boolean) => {
      setEnabled(next);
      onChanged();
    },
    [setEnabled, onChanged],
  );

  const handleSectionFocus = () => {
    setIsFocused(true);
    onFocus?.();
  };

  const handleSectionBlur = () => {
    setIsFocused(false);
    onBlur?.();
  };

  const handlePress = () => handleToggle(!enabled);

  const handleTVEvent = React.useCallback(
    (event: any) => {
      if (isFocused && event.eventType === "select") {
        handleToggle(!enabled);
      }
    },
    [isFocused, enabled, handleToggle],
  );

  useTVEventHandler(handleTVEvent);

  return (
    <SettingsSection
      focusable
      onFocus={handleSectionFocus}
      onBlur={handleSectionBlur}
      {...(Platform.isTV || deviceType !== "tv" ? undefined : { onPress: handlePress })}
    >
      <Pressable style={styles.settingItem} onFocus={handleSectionFocus} onBlur={handleSectionBlur}>
        <View style={styles.settingInfo}>
          <ThemedText style={styles.settingName}>自动选择最优播放源</ThemedText>
          <ThemedText style={styles.settingDescription}>
            进入详情后并发测速所有源的分辨率/下载速度/延迟，自动切到综合得分最高的源。
            从收藏或历史进入时尊重你之前的选择，不会切换。
          </ThemedText>
        </View>
        <Animated.View style={animationStyle}>
          {Platform.OS === "ios" && Platform.isTV ? (
            <TouchableOpacity activeOpacity={0.8} onPress={handlePress} style={styles.statusLabel}>
              <ThemedText style={styles.statusValue}>{enabled ? "已启用" : "已禁用"}</ThemedText>
            </TouchableOpacity>
          ) : (
            <Switch
              value={enabled}
              onValueChange={() => {}}
              trackColor={{ false: "#767577", true: Colors.dark.primary }}
              thumbColor={enabled ? "#ffffff" : "#f4f3f4"}
              pointerEvents="none"
            />
          )}
        </Animated.View>
      </Pressable>
    </SettingsSection>
  );
};

const styles = StyleSheet.create({
  settingItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
  },
  settingInfo: {
    flex: 1,
    paddingRight: 12,
  },
  settingName: {
    fontSize: 16,
    fontWeight: "bold",
    marginBottom: 4,
  },
  settingDescription: {
    fontSize: 13,
    color: "#888",
    lineHeight: 18,
  },
  statusLabel: {
    fontSize: 14,
    color: "#ccc",
  },
  statusValue: {
    fontSize: 14,
  },
});
