import { commitsFact, forcePushFact } from "../git-facts"
import { shortSha } from "../rewrite"
import type { CallDescription, CallFact } from "../tool"
import { layersFact } from "./rebase-describe"
import type { StartPlan } from "./start-plan"

/** A commit id written out in full, which the headline shortens. */
const FULL_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

/**
 * What a call of `git_rebase_start` will do, for the person approving it: the
 * push it leaves needing a force, the branches it moves, what has landed, the
 * commits it replays and the fixups it folds. The pins are what the call must
 * still find: every moved branch's tip, the top, the commit it goes onto and
 * where the replayed range starts. The layers are one pin, so a tall stack
 * stays within the pins a description may carry.
 */
export function startDescription(plan: StartPlan): CallDescription {
  const facts: CallFact[] = []
  if (plan.rule?.needs_force_push) facts.push(forcePushFact())
  if (plan.moved.length > 0) facts.push(layersFact(plan.moved.map((tip) => tip.branch)))
  if (plan.after !== undefined) facts.push({ label: "After", value: plan.after })
  facts.push(commitsFact(plan.range.length))
  if (plan.fixups > 0) {
    facts.push({ label: "Fixups", value: { text: "{fixups} to fold", values: { fixups: plan.fixups } } })
  }

  const onto = plan.ontoRef !== null && FULL_SHA_PATTERN.test(plan.ontoRef) ? shortSha(plan.ontoRef) : plan.ontoRef
  return {
    headline:
      onto === null
        ? { text: "About to fold the fixups of {branch}", values: { branch: plan.top } }
        : { text: "About to rebase {branch} onto {onto}", values: { branch: plan.top, onto } },
    facts,
    pins: {
      layers: plan.moved.map((tip) => `${tip.branch} ${tip.sha}`).join("\n"),
      top: plan.topTip,
      onto: plan.ontoSha,
      upstream: plan.upstream,
    },
  }
}
