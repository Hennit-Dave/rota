import { View } from 'react-native';
import type { Member } from '../teams/teamResponses';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { InfoCard } from '../ui/InfoCard';
import { Text } from '../ui/Text';
import { reductionCopy } from './billingCopy';
import type { ReductionQuote } from './billingResponses';

interface Props {
  reduction: ReductionQuote;
  /** Everyone on the team as the server lists them. The Owner is never offered: the server refuses to deactivate them. */
  members: Member[];
  selected: string[];
  onToggle: (userId: string) => void;
  acceptFallback: boolean;
  onToggleFallback: () => void;
}

/**
 * Who becomes inactive when the period ends, and whether the Owner accepts "keep my current plan and price" if the team is still too big (ADR 0029).
 * The number to choose, the date and the fallback wording are the server's. The count shown is a count of people, never an amount.
 */
export function ReductionPicker({ reduction, members, selected, onToggle, acceptFallback, onToggleFallback }: Props) {
  const needed = reduction.membersToDeactivate;
  const choosable = members.filter((m) => m.role !== 'owner');
  return (
    <View style={{ gap: space[12] }}>
      {needed > 0 ? (
        <>
          <Text variant="label">{reductionCopy.chooseTitle}</Text>
          <Text variant="caption" tone="muted">{reductionCopy.chooseHelp(needed)}</Text>
          <View style={{ gap: space[8] }}>
            {choosable.map((m) => (
              <Button key={m.userId} label={`${m.name} · ${m.role}`} variant={selected.includes(m.userId) ? 'primary' : 'outline'} onPress={() => onToggle(m.userId)} testID={`reduce-member-${m.userId}`} />
            ))}
          </View>
          <Text variant="caption" tone="muted" testID="reduce-chosen">{reductionCopy.chosen(selected.length, needed)}</Text>
        </>
      ) : null}
      <InfoCard title={reductionCopy.fallbackTitle} body={reduction.fallbackWording} testID="reduce-fallback">
        <Button label={acceptFallback ? reductionCopy.fallbackOn : reductionCopy.fallbackOff} variant={acceptFallback ? 'primary' : 'outline'} onPress={onToggleFallback} testID="reduce-fallback-toggle" />
      </InfoCard>
    </View>
  );
}
