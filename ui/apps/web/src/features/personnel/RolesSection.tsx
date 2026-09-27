import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { KNOWN_ROLES, type Role } from '../../auth/roles';
import { ApiError } from '../../lib/apiClient';
import { ConfirmDialog } from '../../components/ui/Dialog';
import { updateMemberRoles } from './api';
import type { Member } from './types';

/** "Grant OFFICER, remove TRAINING" - what the confirm step names before anything is sent. */
export function describeRoleChange(before: readonly Role[], after: readonly Role[]): string {
  const granted = after.filter((role) => !before.includes(role));
  const removed = before.filter((role) => !after.includes(role));
  const parts = [
    granted.length > 0 ? `Grant ${granted.join(', ')}` : null,
    removed.length > 0 ? `${granted.length > 0 ? 'remove' : 'Remove'} ${removed.join(', ')}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(', ');
}

function currentRoles(member: Member): Role[] {
  return KNOWN_ROLES.filter((role) => role === 'MEMBER' || (member.roles ?? []).includes(role));
}

/**
 * F2.7 role assignment. CHIEF/ADMIN may change another member's roles, never their own (the
 * server refuses both anyway). MEMBER is always held. A change reaches the member's app at
 * its next silent session refresh - nobody is signed out.
 */
export function RolesSection({ member, canEdit }: { member: Member; canEdit: boolean }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const saved = currentRoles(member);
  const savedKey = saved.join(',');
  const [draft, setDraft] = useState<Role[]>(saved);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isSelf = member.memberId === auth.user?.profile.sub;
  const name = `${member.firstName} ${member.lastName}`;

  // A fresh load (or a save) of the member resets the checkboxes to what the server holds.
  useEffect(() => {
    setDraft(KNOWN_ROLES.filter((role) => savedKey.split(',').includes(role)));
  }, [savedKey]);

  const saveRoles = useMutation({
    mutationFn: (roles: Role[]) => updateMemberRoles(auth, member.memberId, roles),
    onSuccess: (result) => {
      queryClient.setQueryData<Member>(['personnel', 'members', member.memberId], (prev) =>
        prev ? { ...prev, roles: result.roles } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['personnel', 'members'] });
      setMessage(
        result.changed
          ? `Roles saved. ${result.takesEffect}`
          : 'Roles already matched. Nothing changed.',
      );
    },
  });

  const summary = describeRoleChange(saved, draft);

  async function confirmSave(): Promise<void> {
    try {
      await saveRoles.mutateAsync(draft);
    } catch (error) {
      // The dialog shows this inline and stays open; the server's own words, not its title.
      if (error instanceof ApiError) {
        throw new Error(error.problem.detail ?? error.problem.title, { cause: error });
      }
      throw error;
    }
  }

  const heading = <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Roles</h2>;

  if (!canEdit || isSelf) {
    return (
      <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
        {heading}
        <p>{saved.join(', ')}</p>
        {canEdit ? <p>You cannot change your own roles. Another chief or admin must.</p> : null}
      </section>
    );
  }

  return (
    <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
      {heading}
      <form
        aria-label="Member roles"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!summary) {
            setMessage('No changes to save.');
            return;
          }
          setMessage(null);
          setConfirmOpen(true);
        }}
      >
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ padding: 0 }}>Roles held by {name}</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--boxalarm-spacing-sm)' }}>
            {KNOWN_ROLES.map((role) => (
              <label
                key={role}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 44,
                  minWidth: 44,
                  padding: '0 12px',
                }}
              >
                <input
                  type="checkbox"
                  checked={draft.includes(role)}
                  disabled={role === 'MEMBER'}
                  aria-describedby={role === 'MEMBER' ? 'member-role-note' : undefined}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setMessage(null);
                    setDraft((prev) =>
                      KNOWN_ROLES.filter((r) => (r === role ? checked : prev.includes(r))),
                    );
                  }}
                  style={{ width: 20, height: 20 }}
                />
                {role}
              </label>
            ))}
          </div>
          <p id="member-role-note" style={{ margin: 0, fontSize: 13 }}>
            Every member keeps MEMBER.
          </p>
        </fieldset>
        <button type="submit" style={{ minHeight: 44, marginTop: 'var(--boxalarm-spacing-sm)' }}>
          Review role changes
        </button>
      </form>
      {/* Always mounted: several screen readers skip a live region that appears already
          filled, so the message is swapped into an existing one. */}
      <p role="status">{message ?? ''}</p>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Change roles for ${name}?`}
        consequence={`${summary}. This takes effect within an hour, when ${member.firstName}'s app next refreshes.`}
        confirmLabel="Save roles"
        onConfirm={confirmSave}
      />
    </section>
  );
}
