import { mergeTranslations, type Translations } from "./core"
import { FACT_TRANSLATIONS } from "./core/facts"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(FACT_TRANSLATIONS)
