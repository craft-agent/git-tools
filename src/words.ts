import { mergeTranslations, type Translations } from "./core"
import { COMMIT_TRANSLATIONS } from "./core/commit/words"
import { FACT_TRANSLATIONS } from "./core/facts"
import { REPO_TRANSLATIONS } from "./core/repo/words"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(
  FACT_TRANSLATIONS,
  REPO_TRANSLATIONS,
  COMMIT_TRANSLATIONS,
)
