import { mergeTranslations, type Translations } from "./core"
import { COMMIT_TRANSLATIONS } from "./core/commit/words"
import { FACT_TRANSLATIONS } from "./core/facts"
import { GIT_FACT_TRANSLATIONS } from "./core/git-facts"
import { REBASE_TRANSLATIONS } from "./core/rebase/words"
import { REPO_TRANSLATIONS } from "./core/repo/words"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(
  FACT_TRANSLATIONS,
  GIT_FACT_TRANSLATIONS,
  REPO_TRANSLATIONS,
  COMMIT_TRANSLATIONS,
  REBASE_TRANSLATIONS,
)
