import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { describeAuthFailure, type FieldErrors } from '../auth/authFailure';
import { loginCopy, recoveryCopy } from '../auth/copy';
import { firstInvalidField, forgotFieldOrder, validateEmailOnly } from '../auth/validation';
import { goBackTo } from '../invites/goBackTo';
import { getRecoveryApi } from '../services';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { useFocusSink } from '../ui/FocusSink';
import { PageHeader } from '../ui/PageHeader';
import { Screen, Spacer } from '../ui/Screen';
import { TextField, type TextFieldHandle } from '../ui/TextField';
import { useOnline } from '../ui/useOnline';
import { FailureBanner, toShown } from './FailureBanner';
import { LinkSentView } from './LinkSentView';

/**
 * Forgot password (Figma 8:74): one address, "Send reset link". Then the "Check your inbox" layout. The request is a public POST that answers the
 * same for every address, so the screen never learns, and never says, whether an account exists. The address arrives from the login screen.
 */
export function ForgotPasswordScreen({ initialEmail }: { initialEmail: string }) {
  const online = useOnline();
  const focusSink = useFocusSink();
  const [email, setEmail] = useState(initialEmail);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ReturnType<typeof toShown>>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<TextFieldHandle>(null);

  async function submit() {
    if (submitting) return;
    const errors = validateEmailOnly({ email });
    setFieldErrors(errors);
    if (firstInvalidField(forgotFieldOrder, errors)) {
      emailRef.current?.focus();
      return;
    }
    focusSink();
    setSubmitting(true);
    setFailure(null);
    try {
      await getRecoveryApi().requestPasswordReset(email);
      setSentTo(email.trim());
    } catch (error) {
      const result = describeAuthFailure('reset', error);
      if (!result) return;
      if (result.kind === 'fields') {
        setFieldErrors(result.fields);
        emailRef.current?.focus();
      } else {
        setFailure(toShown(result));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (sentTo) {
    return (
      <LinkSentView
        kind="reset"
        email={sentTo}
        onResend={() => getRecoveryApi().requestPasswordReset(sentTo)}
        onBack={() => goBackTo(router, '/login')}
      />
    );
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={recoveryCopy.forgot.title} subtitle={recoveryCopy.forgot.subtitle} />
      <TextField
        label={loginCopy.emailLabel}
        value={email}
        onChangeText={(value) => {
          setEmail(value);
          setFieldErrors({});
        }}
        error={fieldErrors.email}
        disabled={submitting}
        inputRef={emailRef}
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        testID="forgot-email"
      />
      <FailureBanner failure={failure} online={online} />
      <Spacer />
      <Button
        label={recoveryCopy.forgot.submit}
        loading={submitting}
        loadingLabel={recoveryCopy.forgot.submitting}
        disabled={!online}
        onPress={() => void submit()}
        testID="forgot-submit"
      />
    </Screen>
  );
}
