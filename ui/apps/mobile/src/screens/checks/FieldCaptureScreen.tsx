import { radius, spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Text, TextInput, View } from 'react-native';
import { Button, Card, Screen, useTheme } from '../../components/ui';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { DeliveryStatus, deliveryAnnouncement } from '../../sync/DeliveryStatus';
import { capturePhoto, type CapturedPhoto } from '../../sync/photoCapture';
import * as syncManager from '../../sync/syncManager';
import { useOutboxItem } from '../../sync/useOutboxItem';

interface ViolationDraft {
  readonly key: number;
  readonly code: string;
  readonly description: string;
}

// Stable per capture (F7.7 / N3.4): the outbox row id and the body's idempotencyKey, reused by
// every drain-time retry so the server records the capture once.
function newIdempotencyKey(): string {
  return `fc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// inspections-service stores photos under <dept>/INSPECTION_RECORD/<inspectionId>/<filename>
// and accepts only [A-Za-z0-9._-]{1,200}; prefixing the capture key keeps two captures of one
// inspection from overwriting each other's photo.
function uploadFilename(idempotencyKey: string, fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${idempotencyKey}-${safe}`.slice(0, 200);
}

// The API rejects '#' in either id and '/' or '..' in the inspection id (it becomes a path
// segment); catching that here keeps a typo from sitting in the outbox until the server refuses.
function idProblem(value: string, isPathSegment: boolean): string | null {
  if (value.includes('#')) return "can't contain #";
  if (isPathSegment && (value.includes('/') || value.includes('..'))) {
    return "can't contain / or ..";
  }
  return null;
}

function LabeledInput({
  label,
  value,
  onChangeText,
  error,
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  error?: string | null;
  multiline?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ color: theme.fg, fontSize: typeScale.label.size, fontWeight: '600' }}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error ?? undefined}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        style={{
          minHeight: multiline ? targetSize.field * 2 : targetSize.field,
          borderWidth: error ? 2 : 1,
          borderColor: error ? theme.status.danger : theme.border,
          borderRadius: radius.default,
          paddingHorizontal: spacing.md,
          paddingVertical: multiline ? spacing.sm : 0,
          color: theme.fg,
          backgroundColor: theme.surface,
          fontSize: typeScale.body.size,
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
      {error ? (
        <Text style={{ color: theme.status.danger, fontSize: typeScale.label.size }}>
          {label} {error}
        </Text>
      ) : null}
    </View>
  );
}

export function FieldCaptureScreen() {
  const navigation = useNavigation();
  const theme = useTheme();
  const { isOnline } = useOptionalConnectivity();
  const [occupancyId, setOccupancyId] = useState('');
  const [inspectionId, setInspectionId] = useState('');
  const [violations, setViolations] = useState<ViolationDraft[]>([]);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [queuedId, setQueuedId] = useState<string | null>(null);
  const nextViolationKey = useRef(0);
  const delivery = useOutboxItem(queuedId);
  const label = `Field capture — ${occupancyId.trim()}`;

  // Announce each delivery transition: the status sits below the fold for a sighted user too,
  // and a gloved user in a moving truck may not be looking at the screen when it lands.
  useEffect(() => {
    if (queuedId && delivery.state !== 'NOT_QUEUED') {
      AccessibilityInfo.announceForAccessibility(deliveryAnnouncement(delivery.state, isOnline));
    }
  }, [queuedId, delivery.state, isOnline]);

  const occupancyError = idProblem(occupancyId.trim(), false);
  const inspectionError = idProblem(inspectionId.trim(), true);
  const incompleteViolation = violations.some(
    (violation) => !violation.code.trim() || !violation.description.trim(),
  );
  const canSave =
    occupancyId.trim().length > 0 &&
    inspectionId.trim().length > 0 &&
    !occupancyError &&
    !inspectionError &&
    !incompleteViolation &&
    !saving;

  const updateViolation = (key: number, patch: Partial<Omit<ViolationDraft, 'key'>>) => {
    setViolations((current) =>
      current.map((violation) => (violation.key === key ? { ...violation, ...patch } : violation)),
    );
  };

  const handleAddPhoto = async () => {
    setPhotoError(null);
    const result = await capturePhoto();
    if (result.status === 'captured') {
      setPhoto(result.photo);
      AccessibilityInfo.announceForAccessibility('Photo attached');
    } else if (result.status === 'error') {
      setPhotoError(result.message);
      AccessibilityInfo.announceForAccessibility(`Photo capture failed: ${result.message}`);
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    const photoFilename = photo ? uploadFilename(idempotencyKey, photo.fileName) : null;
    try {
      await syncManager.enqueueFieldCapture(
        idempotencyKey,
        occupancyId.trim(),
        {
          occupancyId: occupancyId.trim(),
          inspectionId: inspectionId.trim(),
          idempotencyKey,
          photoFilenames: photoFilename ? [photoFilename] : [],
          violations: violations.map((violation) => ({
            code: violation.code.trim(),
            description: violation.description.trim(),
            status: 'open',
          })),
          // When it was captured, not when it reached the server. Whole seconds, so a phone clock
          // a few hundred ms ahead of the server's is not refused as a future time.
          conductedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
        },
        photo?.uri,
      );
      setQueuedId(idempotencyKey);
    } catch (error) {
      // Only a local storage failure lands here - the network is never awaited - so nothing
      // was saved and the form stays filled in for another attempt.
      const message = `Could not save on this phone: ${
        error instanceof Error ? error.message : String(error)
      }`;
      setSaveError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSaving(false);
    }
  };

  const handleNewCapture = () => {
    setOccupancyId('');
    setInspectionId('');
    setViolations([]);
    setPhoto(null);
    setPhotoError(null);
    setIdempotencyKey(newIdempotencyKey());
    setQueuedId(null);
  };

  if (queuedId) {
    return (
      <Screen>
        <View style={{ gap: spacing.lg }}>
          <Text
            accessibilityRole="header"
            style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
          >
            Capture saved
          </Text>
          <Card>
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
              Occupancy {occupancyId.trim()} · inspection {inspectionId.trim()}
            </Text>
            <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
              {violations.length === 0
                ? 'No violations'
                : `${violations.length} violation${violations.length === 1 ? '' : 's'}`}
              {photo ? ' · 1 photo' : ' · no photo'}
            </Text>
            <DeliveryStatus
              itemId={queuedId}
              label={label}
              state={delivery.state}
              lastError={delivery.lastError}
              isOnline={isOnline}
            />
          </Card>
          <Button label="New capture" variant="secondary" fullWidth onPress={handleNewCapture} />
          <Button label="Done" fullWidth onPress={() => navigation.goBack()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <Text
            accessibilityRole="header"
            style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
          >
            Field capture
          </Text>
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            Saved on this phone first, then sent when you have signal.
          </Text>
        </View>

        <LabeledInput
          label="Occupancy ID"
          value={occupancyId}
          onChangeText={setOccupancyId}
          error={occupancyError}
        />
        <LabeledInput
          label="Inspection ID"
          value={inspectionId}
          onChangeText={setInspectionId}
          error={inspectionError}
        />

        <View style={{ gap: spacing.sm }}>
          <Text
            accessibilityRole="header"
            style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '600' }}
          >
            Violations
          </Text>
          {violations.length === 0 ? (
            <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
              None recorded.
            </Text>
          ) : null}
          {violations.map((violation, index) => (
            <Card key={violation.key} title={`Violation ${index + 1}`}>
              <LabeledInput
                label={`Violation ${index + 1} code`}
                value={violation.code}
                onChangeText={(code) => updateViolation(violation.key, { code })}
              />
              <LabeledInput
                label={`Violation ${index + 1} description`}
                value={violation.description}
                onChangeText={(description) => updateViolation(violation.key, { description })}
                multiline
              />
              <Button
                label="Remove"
                variant="secondary"
                accessibilityLabel={`Remove violation ${index + 1}`}
                onPress={() =>
                  setViolations((current) => current.filter((item) => item.key !== violation.key))
                }
              />
            </Card>
          ))}
          {incompleteViolation ? (
            <Text style={{ color: theme.status.caution, fontSize: typeScale.label.size }}>
              Each violation needs a code and a description.
            </Text>
          ) : null}
          <Button
            label="Add violation"
            variant="secondary"
            onPress={() => {
              nextViolationKey.current += 1;
              setViolations((current) => [
                ...current,
                { key: nextViolationKey.current, code: '', description: '' },
              ]);
            }}
          />
        </View>

        <View style={{ gap: spacing.sm }}>
          <Button
            label={photo ? 'Retake photo' : 'Add photo'}
            variant="secondary"
            onPress={() => void handleAddPhoto()}
          />
          {photo ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Text style={{ color: theme.status.ok, fontSize: typeScale.body.size, flex: 1 }}>
                Photo attached: {photo.fileName}
              </Text>
              <Button label="Remove photo" variant="secondary" onPress={() => setPhoto(null)} />
            </View>
          ) : null}
          {photoError ? (
            <Text
              accessibilityRole="alert"
              style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
            >
              {photoError}
            </Text>
          ) : null}
        </View>

        {saveError ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size, fontWeight: '600' }}
          >
            {saveError}
          </Text>
        ) : null}
        <Button
          label="Save capture"
          fullWidth
          disabled={!canSave}
          loading={saving}
          onPress={() => void handleSave()}
        />
      </View>
    </Screen>
  );
}
