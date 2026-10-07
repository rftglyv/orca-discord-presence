/**
 * Rotating one-liners for the card's details line. They carry no workspace,
 * branch, or project names, so they are safe at every privacy level except
 * `off`. Each stays within Discord's 2–128 character field limit.
 */
export const DEFAULT_TAGLINES: readonly string[] = [
  'Claude codes the best',
  'Codex is cooking',
  'Agents in parallel, coffee in hand',
  'Shipping while I sip',
  'My agents work harder than me',
  'Five worktrees, zero merge conflicts (so far)',
  'Pair programming with a fleet',
  'Delegating like a tech lead',
  'The agents are typing…',
  'Reviewing diffs at the speed of thought',
  'Running a small software company of bots',
  'Tests are green, vibes are greener',
  'Claude writes it, I take the credit',
  'One prompt away from greatness',
  'Orchestrating the orchestra',
  'Letting the robots refactor',
  'Agents go brrr',
  'Parallel universes, parallel worktrees',
  'Context window: full. Heart: also full',
  'Turning prompts into pull requests',
  'Debugging with a fleet of rubber ducks',
  'Coding at agent speed',
  'Ten hands on the keyboard, none of them mine',
  'Approving permission prompts like a pro',
  'Worktree whisperer',
  'Spinning up another agent, why not',
  'The fleet never sleeps',
  'Commit early, commit often, commit via agent',
  'Somewhere, a linter is crying',
  'Making the CI pipeline nervous',
  'Prompt engineer by day, also by night',
  'Agents assembled',
  'Tokens in, features out',
  'Writing specs, agents write code',
  'Supervising silicon interns',
  'It works on my agent’s machine',
  'Branch per idea, agent per branch',
  'Merging the multiverse',
  'Outsourcing bugs to the future',
  'Claude and Codex, sitting in a tree',
  'Fleet admiral of the codebase',
  'Waiting for the agents to cook',
  'Small prompts, big diffs',
  'Running on caffeine and context',
  'Refactoring at scale, nervously',
  'Building the thing that builds the thing',
  'Agent status: absolutely locked in',
  'Today’s standup: the bots did it',
  'No thoughts, just worktrees',
  'Powered by Orca, fueled by curiosity'
]

/**
 * Picks the line for a rotation tick. The order is a shuffle seeded per
 * worker, so consecutive ticks never repeat a line until the list wraps, and
 * two Orca users running the plugin do not show the same line in lockstep.
 */
export function pickTagline(
  taglines: readonly string[],
  tick: number,
  order: readonly number[]
): string | undefined {
  if (taglines.length === 0) {
    return undefined
  }
  const slot = order.length === taglines.length ? order[tick % order.length] : undefined
  return taglines[slot ?? tick % taglines.length]
}

/** Fisher–Yates over the indices, with an injectable source for tests. */
export function shuffledOrder(length: number, random: () => number = Math.random): number[] {
  const order = Array.from({ length }, (_, index) => index)
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const held = order[index] as number
    order[index] = order[swap] as number
    order[swap] = held
  }
  return order
}

/**
 * Accepts a configured list only if it has at least one usable line; blank,
 * non-string, and out-of-range entries are dropped rather than sent, since
 * Discord rejects the whole update over one bad field.
 */
export function sanitizeTaglines(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const lines = raw
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.trim())
    .filter((line) => line.length >= 2 && line.length <= 128)
  return lines.length > 0 ? lines : undefined
}
