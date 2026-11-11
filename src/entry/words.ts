import { mergeTranslations, translator, type Translations, type Translator } from "../core"
import { visible } from "./visible"

/**
 * The plugin's own words of a prompt, in one language: the Details heading,
 * the Target label, the notice of facts left out with its `{count}`
 * placeholder, and the notices of characters left out of a cut text or value,
 * in the singular and the plural, with the same placeholder. Every prompt
 * counts the facts a description drops past its eighth with `more`, and a
 * card with a budget counts the facts it leaves out with it too; every prompt
 * may leave characters out of a cut text or value. They are in snake case
 * because the command line hands the words to the Hermes plugin as JSON.
 */
export type PromptWords = {
  details: string
  target: string
  more: string
  more_character: string
  more_characters: string
}

/** The prompt's own words in English. */
export const ENGLISH_PROMPT_WORDS: PromptWords = {
  details: "Details",
  target: "Target",
  more: "(+{count} more)",
  more_character: "(+{count} more character)",
  more_characters: "(+{count} more characters)",
}

/** The translations of the plugin's own words. */
export const PLUGIN_TRANSLATIONS: Translations = {
  ja: {
    [ENGLISH_PROMPT_WORDS.details]: "詳細",
    [ENGLISH_PROMPT_WORDS.target]: "対象",
    [ENGLISH_PROMPT_WORDS.more]: "（ほか {count} 件）",
    [ENGLISH_PROMPT_WORDS.more_character]: "（ほか {count} 文字）",
    [ENGLISH_PROMPT_WORDS.more_characters]: "（ほか {count} 文字）",
  },
}

/** The plugin's own words through a translator, each made `visible`. */
export function promptWords(t: Translator): PromptWords {
  return {
    details: visible(t.word(ENGLISH_PROMPT_WORDS.details)),
    target: visible(t.word(ENGLISH_PROMPT_WORDS.target)),
    more: visible(t.template(ENGLISH_PROMPT_WORDS.more)),
    more_character: visible(t.template(ENGLISH_PROMPT_WORDS.more_character)),
    more_characters: visible(t.template(ENGLISH_PROMPT_WORDS.more_characters)),
  }
}

/** The notice of `count` facts left out, with `{count}` replaced by the number as it is. */
export function factsLeftOut(count: number, words: PromptWords): string {
  return words.more.replaceAll("{count}", String(count))
}

/** The notice of `count` characters left out of a cut text or value: the singular word for one, else the plural, with `{count}` replaced by the number as it is. */
export function charactersLeftOut(count: number, words: PromptWords): string {
  const notice = count === 1 ? words.more_character : words.more_characters
  return notice.replaceAll("{count}", String(count))
}

/** The translator for a prompt language over a package's translations and the plugin's own (the package's words win). */
export function promptTranslator(translations: Translations, language: string | undefined): Translator {
  return translator(mergeTranslations(translations, PLUGIN_TRANSLATIONS), language)
}
