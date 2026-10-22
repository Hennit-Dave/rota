import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { describeAuthFailure, type AuthFailure, type FieldErrors, type FieldName } from '../../auth/authFailure';
import { bannerCopy, credentialsCopy, loginCopy } from '../../auth/copy';
import { firstInvalidField, loginFieldOrder, validateLogin } from '../../auth/validation';
import { getAuthActions } from '../../services';
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
  const [email, setEmail] = useState('');
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
  const openPlaceholder = (feature: 'forgot-password' | 'magic-link') =>
    router.push({ pathname: '/coming-soon', params: { feature } });

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
      <View style={{ gap: space[16] }}>
        {emailField}
        <View style={{ gap: space[8] }}>
          {passwordField}
          <TextAction
            label={loginCopy.forgotPassword}
            disabled={submitting}
            onPress={() => openPlaceholder('forgot-password')}
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
        <TextAction label={loginCopy.magicLink} disabled={submitting} onPress={() => openPlaceholder('magic-link')} testID="login-magic" />
      </View>
      <Spacer />
      <View style={{ gap: space[8] }}>
        <Divider />
        <TextAction
          label={loginCopy.createAccount}
          disabled={submitting}
          onPress={() => router.replace('/signup')}
          testID="login-signup"
        />
      </View>
    </Screen>
  );
}
