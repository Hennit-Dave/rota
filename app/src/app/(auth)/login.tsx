import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { describeAuthFailure, type AuthFailure, type FieldErrors, type FieldName } from '../../auth/authFailure';
import { bannerCopy, credentialsCopy, loginCopy, recoveryCopy } from '../../auth/copy';
import { firstInvalidField, forgotFieldOrder, loginFieldOrder, validateEmailOnly, validateLogin } from '../../auth/validation';
import { inviteAuthParams, readInviteAuthParams, routeAfterAuth } from '../../invites/inviteAuthParams';
import { getAuthActions, getRecoveryApi } from '../../services';
import { space } from '../../theme';
import { Button } from '../../ui/Button';
import { PageHeader } from '../../ui/PageHeader';
import { useFocusSink } from '../../ui/FocusSink';
import { Divider, Screen, Spacer } from '../../ui/Screen';
import { StatusBanner } from '../../ui/StatusBanner';
import { TextAction } from '../../ui/TextAction';
import { Text } from '../../ui/Text';
import { TextField, type TextFieldHandle } from '../../ui/TextField';
import { useOnline } from '../../ui/useOnline';

type Failure = Exclude<AuthFailure, { kind: 'fields' }>;

/**
 * Login (Figma 8:6) and its states: loading 229:269, wrong credentials 8:158, rate limited 229:3485, generic error
 * 229:3586, offline 229:3636. Button behaviour follows the note 232:415: disabled only while loading or offline;
 * enabled on every error, where a tap re-validates, shows errors and focuses the first invalid field.
 */
export default function LoginScreen() {
  const online = useOnline();
  const focusSink = useFocusSink();
  // Opened from an invitation: the invited address is filled in (editable), "Create an account" keeps the invitation, and signing in
  // returns to it (ADR 0017).
  const params = useLocalSearchParams<{ inviteToken?: string; inviteEmail?: string; passwordReset?: string }>();
  const invite = readInviteAuthParams(params);
  // Back from a successful password reset (ADR 0020): say so, once, above the form. Not in Figma yet.
  const passwordUpdated = params.passwordReset === '1';
  const [email, setEmail] = useState(invite.email);
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<TextFieldHandle>(null);
  const passwordRef = useRef<TextFieldHandle>(null);

  const focusField = (field: FieldName | null) => {
    if (field === 'email') emailRef.current?.focus();
    if (field === 'password') passwordRef.current?.focus();
  };

  async function submit() {
    if (submitting) return;
    const errors = validateLogin({ email, password });
    setFieldErrors(errors);
    const invalid = firstInvalidField(loginFieldOrder, errors);
    if (invalid) {
      focusField(invalid);
      return;
    }
    // The focused field is about to be disabled: park focus on the hidden sink first (closes the keyboard too).
    focusSink();
    setSubmitting(true);
    try {
      // On success the session store flips to signed in and the signed-in side replaces this screen.
      await getAuthActions().login(email.trim(), password);
      // Starting the session threw away this screen and Expo Router put Home on top of the invitation screen it came from. From an invitation,
      // go back to THAT screen (dismissTo, not a new copy: a second copy would leave the first running underneath, ADR 0017).
      const next = routeAfterAuth('login', invite);
      if (next.kind === 'invite') router.dismissTo({ pathname: '/invite/[token]', params: { token: next.token } });
    } catch (error) {
      setSubmitting(false);
      const result = describeAuthFailure('login', error);
      if (!result) return; // a result for a previous account: show nothing
      if (result.kind === 'fields') {
        setFailure(null);
        setFieldErrors(result.fields);
        focusField(firstInvalidField(loginFieldOrder, result.fields));
      } else {
        setFailure(result);
      }
    }
  }

  const clearError = (field: FieldName) => setFieldErrors((current) => ({ ...current, [field]: undefined }));
  const openForgotPassword = () => router.push({ pathname: '/forgot-password', params: { email: email.trim() } });

  /**
   * "Email me a sign-in link" uses the address already typed above (Figma magic 8:47 shows it as "requested for ..."). The request answers the same
   * for every address; the next screen is "Check your inbox" either way.
   */
  async function requestMagicLink() {
    if (submitting) return;
    const errors = validateEmailOnly({ email });
    setFieldErrors(errors);
    if (firstInvalidField(forgotFieldOrder, errors)) {
      focusField('email');
      return;
    }
    focusSink();
    setSubmitting(true);
    setFailure(null);
    try {
      await getRecoveryApi().requestMagicLink(email);
      router.push({ pathname: '/magic-sent', params: { email: email.trim() } });
    } catch (error) {
      const result = describeAuthFailure('login', error);
      if (!result) return;
      if (result.kind === 'fields') {
        setFieldErrors(result.fields);
        focusField(firstInvalidField(forgotFieldOrder, result.fields));
      } else {
        setFailure(result);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const credentialsLayout = online && failure?.kind === 'credentials';

  const emailField = (
    <TextField
      label={loginCopy.emailLabel}
      value={email}
      onChangeText={(value) => {
        setEmail(value);
        clearError('email');
      }}
      error={fieldErrors.email}
      disabled={submitting}
      inputRef={emailRef}
      autoCapitalize="none"
      autoComplete="username"
      autoCorrect={false}
      keyboardType="email-address"
      textContentType="username"
      returnKeyType="next"
      onSubmitEditing={() => passwordRef.current?.focus()}
      testID="login-email"
    />
  );
  const passwordField = (
    <TextField
      label={loginCopy.passwordLabel}
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
      autoComplete="current-password"
      autoCorrect={false}
      textContentType="password"
      returnKeyType="go"
      onSubmitEditing={() => void submit()}
      testID="login-password"
    />
  );

  // Wrong credentials is its own layout (8:158): the same two fields, a banner and no field marked, and one button.
  if (credentialsLayout) {
    return (
      <Screen gap={space[16]}>
        <PageHeader eyebrowGap={16} title={credentialsCopy.title} subtitle={credentialsCopy.subtitle} />
        <View style={{ gap: space[16] }}>
          {emailField}
          {passwordField}
          <StatusBanner tone="error" title={credentialsCopy.bannerTitle} body={credentialsCopy.bannerBody} />
        </View>
        <Spacer />
        <Button
          label={credentialsCopy.submit}
          loading={submitting}
          loadingLabel={loginCopy.submitting}
          onPress={() => void submit()}
          testID="login-submit"
        />
      </Screen>
    );
  }

  let banner: React.ReactNode = null;
  if (!online) {
    banner = <StatusBanner tone="warning" title={bannerCopy.offline} />;
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

  return (
    <Screen>
      <PageHeader title={loginCopy.title} subtitle={loginCopy.subtitle} />
      {passwordUpdated ? <StatusBanner tone="info" title={recoveryCopy.passwordUpdated.title} body={recoveryCopy.passwordUpdated.body} testID="login-password-updated" /> : null}
      <View style={{ gap: space[16] }}>
        {emailField}
        <View style={{ gap: space[8] }}>
          {passwordField}
          <TextAction
            label={loginCopy.forgotPassword}
            disabled={submitting}
            onPress={openForgotPassword}
            testID="login-forgot"
          />
        </View>
      </View>
      {banner}
      <Button
        label={loginCopy.submit}
        loading={submitting}
        loadingLabel={loginCopy.submitting}
        disabled={!online}
        onPress={() => void submit()}
        testID="login-submit"
      />
      <View>
        <Text variant="caption" tone="muted">
          {loginCopy.alternativePrompt}
        </Text>
        <TextAction label={loginCopy.magicLink} disabled={submitting} onPress={() => void requestMagicLink()} testID="login-magic" />
      </View>
      <Spacer />
      <View style={{ gap: space[8] }}>
        <Divider />
        <TextAction
          label={loginCopy.createAccount}
          disabled={submitting}
          onPress={() => router.replace({ pathname: '/signup', params: inviteAuthParams(invite) })}
          testID="login-signup"
        />
      </View>
    </Screen>
  );
}
