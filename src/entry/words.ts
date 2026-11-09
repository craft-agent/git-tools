import { mergeTranslations, translator, type Translations, type Translator } from "../core"
import { visible } from "./visible"

/**
 * The plugin's own words of a prompt, in one language: the Details heading,
 * the Target label, and the notice of facts left out with its `{count}`
 * placeholder. Only a card with a budget leaves facts out, so `more` is for
 * the cards drawn outside TypeScript, which get it from the command line.
 */
export type PromptWords = { details: string; target: string; more: string }

/** The prompt's own words in English. */
export const ENGLISH_PROMPT_WORDS: PromptWords = { details: "Details", target: "Target", more: "(+{count} more)" }

/** The translations of the plugin's own words. */
export const PLUGIN_TRANSLATIONS: Translations = {
  ja: {
    [ENGLISH_PROMPT_WORDS.details]: "詳細",
    [ENGLISH_PROMPT_WORDS.target]: "対象",
    [ENGLISH_PROMPT_WORDS.more]: "（ほか {count} 件）",
  },
}

/** The plugin's own words through a translator, each made `visible`. */
export function promptWords(t: Translator): PromptWords {
  return {
    details: visible(t.word(ENGLISH_PROMPT_WORDS.details)),
    target: visible(t.word(ENGLISH_PROMPT_WORDS.target)),
    more: visible(t.template(ENGLISH_PROMPT_WORDS.more)),
  }
}

/** The translator for a prompt language over a package's translations and the plugin's own (the package's words win). */
export function promptTranslator(translations: Translations, language: string | undefined): Translator {
  return translator(mergeTranslations(translations, PLUGIN_TRANSLATIONS), language)
}
