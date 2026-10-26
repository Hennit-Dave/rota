import { useState } from 'react';
import { describeAuthFailure } from '../auth/authFailure';
import { recoveryCopy } from '../auth/copy';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { InfoCard } from '../ui/InfoCard';
import { PageHeader } from '../ui/PageHeader';
import { Screen, Spacer } from '../ui/Screen';
import { StatusBanner } from '../ui/StatusBanner';
import { TextAction } from '../ui/TextAction';
import { useOnline } from '../ui/useOnline';
import { FailureBanner, toShown } from './FailureBanner';

interface Props {
  kind: 'magic' | 'reset';
  email: string;
  /** Asks for another link. The answer is the same whether or not the address has an account. */
  onResend: () => Promise<void>;
  onBack: () => void;
}

/**
 * "Check your inbox" (magic, Figma 8:47): the address the link was requested for, Resend link, Back to log in. The reset request reuses this
 * layout (it has no "sent" frame; the wording is 8:74's, listed in the pull request). It never says whether an account exists.
 */
export function LinkSentView({ kind, email, onResend, onBack }: Props) {
  const copy = recoveryCopy.sent;
  const online = useOnline();
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof toShown>>(null);

  async function resend() {
    if (resending) return;
    setResending(true);
    setResent(false);
    setFailure(null);
    try {
      await onResend();
      setResent(true);
    } catch (error) {
      const result = describeAuthFailure('reset', error);
      if (result) setFailure(toShown(result));
    } finally {
      setResending(false);
    }
  }

  return (
    <Screen gap={space[24]}>
      <PageHeader title={copy.title} subtitle={kind === 'magic' ? copy.magicSubtitle : copy.resetSubtitle} />
      <InfoCard title={copy.cardTitle} body={kind === 'magic' ? copy.magicBody(email) : copy.resetBody(email)} testID="link-sent-card" />
      <FailureBanner failure={failure} online={online} />
      {resent && !failure ? <StatusBanner tone="info" title={copy.resent} testID="link-resent" /> : null}
      <Spacer />
      <Button
        label={copy.resend}
        variant="secondary"
        loading={resending}
        loadingLabel={copy.resending}
        disabled={!online}
        onPress={() => void resend()}
        testID="link-resend"
      />
      <TextAction label={copy.backToLogin} disabled={resending} onPress={onBack} testID="link-back" />
    </Screen>
  );
}
