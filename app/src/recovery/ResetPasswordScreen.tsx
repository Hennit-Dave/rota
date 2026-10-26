import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { describeAuthFailure, type FieldErrors, type FieldName } from '../auth/authFailure';
import { fieldCopy, PASSWORD_HELPER_MIN, recoveryCopy } from '../auth/copy';
import { firstInvalidField, resetFieldOrder, validateNewPassword } from '../auth/validation';
import { getRecoveryApi, signOutLocal } from '../services';
import { useSessionStore } from '../state/sessionStore';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { useFocusSink } from '../ui/FocusSink';
import { createLatch } from '../ui/latch';
import { PageHeader } from '../ui/PageHeader';
import { Screen, Spacer } from '../ui/Screen';
import { TextField, type TextFieldHandle } from '../ui/TextField';
import { useOnline } from '../ui/useOnline';
import { FailureBanner, toShown } from './FailureBanner';
import { LinkUnavailableView } from './LinkUnavailableView';

/**
 * The new-password screen (Figma reset-new 8:86): a new password with the signup helper line, a confirmation, "Save password". Opening the link only
 * shows this screen; the POST that uses the link up happens when the button is tapped. Length and the common-password list are the server's call and
 * come back as field errors; the app only checks that the two entries match. The password lives in this screen's state until the request is sent.
 * Success ends every session on the server, so nobody is signed in by it: the person goes to the login screen.
 */
export function ResetPasswordScreen({ token }: { token: string | null }) {
  const copy = recoveryCopy.resetNew;
  const online = useOnline();
  const focusSink = useFocusSink();
  const session = useSessionStore((s) => s.status);
  const latch = useRef(createLatch()).current;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ReturnType<typeof toShown>>(null);
  const [submitting, setSubmitting] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const passwordRef = useRef<TextFieldHandle>(null);
  const confirmRef = useRef<TextFieldHandle>(null);

  if (!token || unavailable) return <LinkUnavailableView kind="reset" signedIn={session === 'signedIn'} />;

  const focusField = (field: FieldName | null) => {
    if (field === 'password') passwordRef.current?.focus();
    if (field === 'confirm') confirmRef.current?.focus();
  };

  async function submit() {
    if (!token || submitting) return;
    const errors = validateNewPassword({ password, confirm });
    setFieldErrors(errors);
    const invalid = firstInvalidField(resetFieldOrder, errors);
    if (invalid) {
      focusField(invalid);
      return;
    }
    if (!latch.tryAcquire()) return;
    focusSink();
    setSubmitting(true);
    setFailure(null);
    try {
      await getRecoveryApi().submitPasswordReset(token, password);
      setPassword('');
      setConfirm('');
      // The server ended every session, this phone's too. Do the local sign-out now, so the next request is not what finds out.
      if (session === 'signedIn') await signOutLocal('none');
      router.replace({ pathname: '/login', params: { passwordReset: '1' } });
    } catch (error) {
      const result = describeAuthFailure('reset', error);
      if (!result) return;
      if (result.kind === 'link_unavailable') setUnavailable(true);
      else if (result.kind === 'fields') {
        setFieldErrors(result.fields);
        focusField(firstInvalidField(resetFieldOrder, result.fields));
      } else setFailure(toShown(result));
    } finally {
      latch.release();
      setSubmitting(false);
    }
  }

  const clear = (field: FieldName) => setFieldErrors((current) => ({ ...current, [field]: undefined }));

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={copy.title} />
      <TextField
        label={copy.passwordLabel}
        value={password}
        onChangeText={(value) => {
          setPassword(value);
          clear('password');
        }}
        error={fieldErrors.password}
        helper={fieldCopy.passwordTooShort(PASSWORD_HELPER_MIN)}
        disabled={submitting}
        inputRef={passwordRef}
        secure
        autoCapitalize="none"
        autoComplete="new-password"
        autoCorrect={false}
        textContentType="newPassword"
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
        testID="reset-password"
      />
      <TextField
        label={copy.confirmLabel}
        value={confirm}
        onChangeText={(value) => {
          setConfirm(value);
          clear('confirm');
        }}
        error={fieldErrors.confirm}
        disabled={submitting}
        inputRef={confirmRef}
        secure
        autoCapitalize="none"
        autoComplete="new-password"
        autoCorrect={false}
        textContentType="newPassword"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        testID="reset-confirm"
      />
      <FailureBanner failure={failure} online={online} />
      <Spacer />
      <Button
        label={copy.submit}
        loading={submitting}
        loadingLabel={copy.submitting}
        disabled={!online}
        onPress={() => void submit()}
        testID="reset-submit"
      />
    </Screen>
  );
}
