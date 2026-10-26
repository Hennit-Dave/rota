import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { describeAuthFailure, type AuthFailure, type FieldErrors, type FieldName } from '../../auth/authFailure';
import { bannerCopy, fieldCopy, PASSWORD_HELPER_MIN, signupCopy } from '../../auth/copy';
import { firstInvalidField, signupFieldOrder, validateSignup } from '../../auth/validation';
import { inviteAuthParams, readInviteAuthParams, routeAfterAuth } from '../../invites/inviteAuthParams';
import { getAuthActions } from '../../services';
import { space } from '../../theme';
import { Button } from '../../ui/Button';
import { PageHeader } from '../../ui/PageHeader';
import { useFocusSink } from '../../ui/FocusSink';
import { Divider, Screen, Spacer } from '../../ui/Screen';
import { StatusBanner } from '../../ui/StatusBanner';
import { TextAction } from '../../ui/TextAction';
import { TextField, type TextFieldHandle } from '../../ui/TextField';
import { useOnline } from '../../ui/useOnline';

type Failure = Exclude<AuthFailure, { kind: 'fields' | 'credentials' }>;

/**
 * Sign up (Figma 8:27) and its states: loading 229:320, field errors 229:377, password too long 229:455, password
 * common 231:391, email in use 229:3432, rate limited 229:3535. Offline and the generic error have no signup frame in
 * Figma, so they reuse the login ones (agreed in the plan). Email in use is a banner and a link, never a field error.
 */
export default function SignupScreen() {
  const online = useOnline();
  const focusSink = useFocusSink();
  // Opened from an invitation: the invited address is filled in (editable), and there is no Create team step afterwards (ADR 0017).
  const invite = readInviteAuthParams(useLocalSearchParams<{ inviteToken?: string; inviteEmail?: string }>());
  const [name, setName] = useState('');
  const [email, setEmail] = useState(invite.email);
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<TextFieldHandle>(null);
  const emailRef = useRef<TextFieldHandle>(null);
  const passwordRef = useRef<TextFieldHandle>(null);

  const focusField = (field: FieldName | null) => {
    if (field === 'name') nameRef.current?.focus();
    if (field === 'email') emailRef.current?.focus();
    if (field === 'password') passwordRef.current?.focus();
  };

  async function submit() {
    if (submitting) return;
    const errors = validateSignup({ name, email, password });
    setFieldErrors(errors);
    const invalid = firstInvalidField(signupFieldOrder, errors);
    if (invalid) {
      focusField(invalid);
      return;
    }
    // The focused field is about to be disabled: park focus on the hidden sink first (closes the keyboard too).
    focusSink();
    setSubmitting(true);
    setFailure(null);
    try {
      await getAuthActions().register(name.trim(), email.trim(), password);
      // The account exists and the user is signed in. From an invitation this ends back on that invitation (the person joins the invited
      // team, so Create team is never shown, ADR 0017); otherwise on to the create-team step, then home.
      const next = routeAfterAuth('signup', invite);
      if (next.kind === 'invite') router.dismissTo({ pathname: '/invite/[token]', params: { token: next.token } });
      else router.replace('/create-team');
    } catch (error) {
      setSubmitting(false);
      const result = describeAuthFailure('signup', error);
      if (!result) return; // a result for a previous account: show nothing
      if (result.kind === 'fields') {
        setFieldErrors(result.fields);
        focusField(firstInvalidField(signupFieldOrder, result.fields));
      } else if (result.kind !== 'credentials') {
        setFailure(result);
      }
    }
  }

  const clearError = (field: FieldName) => setFieldErrors((current) => ({ ...current, [field]: undefined }));

  let banner: React.ReactNode = null;
  if (!online) {
    banner = <StatusBanner tone="warning" title={bannerCopy.offline} />;
  } else if (failure?.kind === 'email_in_use') {
    banner = <StatusBanner tone="error" title={signupCopy.emailInUse} />;
  } else if (failure?.kind === 'rate_limited') {
    banner = <StatusBanner tone="warning" title={failure.message} />;
  } else if (failure?.kind === 'generic') {
    banner = (
      <StatusBanner
        tone="error"
        title={failure.message}
        reference={failure.reference ? `${bannerCopy.referencePrefix}${failure.reference}` : undefined}
      />
    );
  } else if (failure?.kind === 'offline') {
    banner = <StatusBanner tone="warning" title={failure.message} />;
  }
  const emailInUse = online && failure?.kind === 'email_in_use';

  return (
    <Screen>
      <PageHeader title={signupCopy.title} subtitle={signupCopy.subtitle} />
      <View style={{ gap: space[16] }}>
        <TextField
          label={signupCopy.nameLabel}
          placeholder={signupCopy.namePlaceholder}
          value={name}
          onChangeText={(value) => {
            setName(value);
            clearError('name');
          }}
          error={fieldErrors.name}
          disabled={submitting}
          inputRef={nameRef}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          returnKeyType="next"
          onSubmitEditing={() => emailRef.current?.focus()}
          testID="signup-name"
        />
        <TextField
          label={signupCopy.emailLabel}
          value={email}
          onChangeText={(value) => {
            setEmail(value);
            clearError('email');
          }}
          error={fieldErrors.email}
          disabled={submitting}
          inputRef={emailRef}
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          testID="signup-email"
        />
        <TextField
          label={signupCopy.passwordLabel}
          // Display copy only: the real minimum is the server's, and error messages take their number from it.
          helper={fieldCopy.passwordTooShort(PASSWORD_HELPER_MIN)}
          value={password}
          onChangeText={(value) => {
            setPassword(value);
            clearError('password');
          }}
          error={fieldErrors.password}
          disabled={submitting}
          inputRef={passwordRef}
          secure
          autoCapitalize="none"
          autoComplete="new-password"
          autoCorrect={false}
          textContentType="newPassword"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          testID="signup-password"
        />
      </View>
      {banner}
      {emailInUse ? (
        <TextAction label={signupCopy.logInInstead} disabled={submitting} onPress={() => router.replace({ pathname: '/login', params: inviteAuthParams(invite) })} testID="signup-login-instead" />
      ) : null}
      <Button
        label={signupCopy.submit}
        loading={submitting}
        loadingLabel={signupCopy.submitting}
        disabled={!online}
        onPress={() => void submit()}
        testID="signup-submit"
      />
      <Spacer />
      {emailInUse ? null : (
        <View style={{ gap: space[8] }}>
          <Divider />
          <TextAction label={signupCopy.haveAccount} disabled={submitting} onPress={() => router.replace({ pathname: '/login', params: inviteAuthParams(invite) })} testID="signup-login" />
        </View>
      )}
    </Screen>
  );
}
