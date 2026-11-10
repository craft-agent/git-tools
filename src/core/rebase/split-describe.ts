import { commitsFact } from "../git-facts"
import { shortSha } from "../rewrite"
import type { CallDescription, CallFact, CallHeadline } from "../tool"
import type { SplitPlan } from "./split-plan"

/** The label of the fact that lists the branches the call creates. */
const NEW_BRANCHES_LABEL = "New branches"

/** The separator between the new branches of the `New branches` fact. */
const BRANCH_SEPARATOR = "; "

/** The `New branches` fact: each cut with where it starts, then the added layer; the description cuts a long value to fit. */
function newBranchesFact(plan: SplitPlan): CallFact {
  const cuts = plan.cuts.map((cut) => `${cut.name} at ${shortSha(cut.sha)} ${cut.subject}`).join(BRANCH_SEPARATOR)
  if (plan.add === undefined) return { label: NEW_BRANCHES_LABEL, value: cuts }
  if (cuts === "") return { label: NEW_BRANCHES_LABEL, value: { text: "{name} on top", values: { name: plan.add } } }
  return {
    label: NEW_BRANCHES_LABEL,
    value: { text: `{cuts}${BRANCH_SEPARATOR}{name} on top`, values: { cuts, name: plan.add } },
  }
}

/** The headline of a call: the cut, the added layer, or both. */
function headline(plan: SplitPlan): CallHeadline {
  const branch = plan.branch
  if (plan.cuts.length === 0)
    return { text: "About to add the layer {name} on {branch}", values: { name: plan.add!, branch } }
  const layers = String(plan.cuts.length + 1)
  return plan.add === undefined
    ? { text: "About to cut {branch} into {layers} layers", values: { branch, layers } }
    : {
        text: "About to cut {branch} into {layers} layers and add {name} on top",
        values: { branch, layers, name: plan.add },
      }
}

/**
 * What a call of `git_rebase_split` will do, for the person approving it: the
 * new branches and where each starts, and the commits of the layer being cut.
 * The pins are what the call must still find: HEAD and each cut's commit.
 */
export function splitDescription(plan: SplitPlan): CallDescription {
  const facts: CallFact[] = [newBranchesFact(plan)]
  if (plan.cuts.length > 0) facts.push(commitsFact(plan.commits.length))
  return {
    headline: headline(plan),
    facts,
    pins: { head: plan.head, ...Object.fromEntries(plan.cuts.map((cut, index) => [`cut_${index + 1}`, cut.sha])) },
  }
}
