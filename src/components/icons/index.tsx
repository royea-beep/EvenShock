import type { Choice } from '../../types/game';
import { RockIcon } from './RockIcon';
import { PaperIcon } from './PaperIcon';
import { ScissorsIcon } from './ScissorsIcon';

export { RockIcon, PaperIcon, ScissorsIcon };

export const CHOICE_ICONS: Record<Choice, (props: { className?: string }) => React.JSX.Element> = {
  rock: RockIcon,
  paper: PaperIcon,
  scissors: ScissorsIcon,
};
