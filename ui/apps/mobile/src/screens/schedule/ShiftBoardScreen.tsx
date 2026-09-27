import { palette, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { FlatList, Text, TouchableOpacity, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useScheduleRepository } from '../../features/schedule/apiScheduleRepository';
import type { DutyShift, ShiftStatus } from '../../features/schedule/types';
import type { ScheduleStackParamList } from '../../navigation/ScheduleStack';

const STATUS_LABEL: Record<ShiftStatus, string> = {
  OPEN: 'Open',
  PARTIALLY_FILLED: 'Partially filled',
  FULL: 'Full',
  CANCELLED: 'Cancelled',
};

function formatShiftTime(startAt: number): string {
  return new Date(startAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ShiftBoardScreen() {
  const navigation = useNavigation<NavigationProp<ScheduleStackParamList>>();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useScheduleRepository();
  const [shifts, setShifts] = useState<DutyShift[]>([]);

  useEffect(() => {
    let cancelled = false;
    repository.getShifts().then((result) => {
      if (!cancelled) setShifts(result);
    });
    return () => {
      cancelled = true;
    };
  }, [repository]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <FlatList
        data={shifts}
        keyExtractor={(item) => item.shiftId}
        contentContainerStyle={{ padding: spacing.lg }}
        ListHeaderComponent={
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => navigation.navigate('TrainingEvents' as never)}
            style={{
              minHeight: touchTarget.baseline.ios,
              justifyContent: 'center',
              paddingBottom: spacing.md,
            }}
          >
            <Text
              style={{ color: tokens.accent, fontSize: typography.size.base, fontWeight: '600' }}
            >
              Training events
            </Text>
          </TouchableOpacity>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => navigation.navigate('ShiftDetail', { shiftId: item.shiftId })}
            style={{
              minHeight: touchTarget.baseline.ios,
              justifyContent: 'center',
              paddingVertical: spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: tokens.foreground + '22',
            }}
          >
            <Text
              style={{
                color: tokens.foreground,
                fontSize: typography.size.base,
                fontWeight: '600',
              }}
            >
              {item.stationId}
            </Text>
            <Text style={{ color: tokens.foreground, opacity: 0.7, fontSize: typography.size.sm }}>
              {formatShiftTime(item.startAt)}
            </Text>
            <Text
              style={{
                color: item.status === 'FULL' ? tokens.success : tokens.accent,
                fontSize: typography.size.sm,
                marginTop: 2,
              }}
            >
              {STATUS_LABEL[item.status]}
            </Text>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}
