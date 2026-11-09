/**
 * The facts the git tools share in a call's description, in the form of
 * `facts.ts`: a function that takes what the tool resolved and returns a
 * `CallFact`, and a table that translates its label and value template.
 */
import type { CallFact } from "./tool"
import type { Translations } from "./words"

/** The `Lines` fact: how many lines a change adds and removes, as `3 added, 1 removed`. */
export function linesFact(added: number, removed: number): CallFact {
  return { label: "Lines", value: { text: "{added} added, {removed} removed", values: { added, removed } } }
}

/** The `Files` fact: how many files a change touches, as `1 file` or `3 files`. */
export function filesFact(count: number): CallFact {
  return { label: "Files", value: { text: count === 1 ? "{files} file" : "{files} files", values: { files: count } } }
}

/** The `Branch` fact: the branch a change lands on. */
export function branchFact(name: string): CallFact {
  return { label: "Branch", value: name }
}

/** The `Commits` fact: how many commits a call covers, as `1 commit` or `3 commits`. */
export function commitsFact(count: number): CallFact {
  return {
    label: "Commits",
    value: { text: count === 1 ? "{commits} commit" : "{commits} commits", values: { commits: count } },
  }
}

/** The translations of the labels and the value templates of the facts above. */
export const GIT_FACT_TRANSLATIONS: Translations = {
  ja: {
    Branch: "ブランチ",
    Lines: "行数",
    "{added} added, {removed} removed": "追加 {added} 行、削除 {removed} 行",
    Files: "ファイル数",
    "{files} file": "{files} 個",
    "{files} files": "{files} 個",
    Commits: "コミット数",
    "{commits} commit": "{commits} 件",
    "{commits} commits": "{commits} 件",
  },
}
