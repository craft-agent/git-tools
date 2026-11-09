import { MAX_HEADLINE_LENGTH, templatePlaceholders } from "./describe"

/** One language's words: each English word or template as the code writes it, mapped to its translation. */
export type Words = Readonly<Record<string, string>>

/** A package's translations: the words of each language, keyed by a lower-case language tag (`ja`, `zh-hant`). */
export type Translations = Readonly<Record<string, Words>>

/** Looks a tool's or a plugin's English words up in one language. */
export type Translator = {
  /**
   * The translation of a plain word (a title, a label), else the English one.
   * A translation longer than `limit` code points is never cut: the English
   * word stands in its place.
   */
  word(english: string, limit?: number): string
  /**
   * The translation of a template (`Create the note {name}`), else the English
   * one. A translation is used only when it is well formed, within `limit`
   * code points (the headline budget by default) and holds exactly the
   * placeholders of the English one.
   */
  template(english: string, limit?: number): string
}

/** The translator that keeps every word in English. */
export const ENGLISH: Translator = {
  word: (english) => english,
  template: (english) => english,
}

/** The own string value of a table for an English word, else `undefined`; an inherited key never resolves. */
function lookup(words: Words, english: string): string | undefined {
  if (!Object.hasOwn(words, english)) return undefined
  const value: unknown = words[english]
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/** Whether two sets hold the same names. */
function sameNames(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((name) => right.has(name))
}

/**
 * The language of the package's translations a tag selects, else `undefined`,
 * which is English. The tag is trimmed, lower-cased and read with `_` as `-`;
 * it matches the table of the whole tag, else the one of its first subtag
 * (`ja-JP` and `ja_JP` are `ja`, `zh-Hant` is `zh-hant` or else `zh`). A blank
 * or missing tag, and a language with no table, give `undefined`.
 */
export function languageOf(tag: string | undefined, translations: Translations): string | undefined {
  const normalized = tag?.trim().toLowerCase().replaceAll("_", "-") ?? ""
  if (normalized === "") return undefined
  if (Object.hasOwn(translations, normalized)) return normalized
  const primary = normalized.split("-")[0] ?? ""
  return Object.hasOwn(translations, primary) ? primary : undefined
}

/**
 * Joins translation tables into one, language by language. When several
 * tables give the same English word of a language, the first table wins. The
 * tables are not changed.
 */
export function mergeTranslations(...tables: Translations[]): Translations {
  const merged = new Map<string, Map<string, string>>()
  for (const table of tables) {
    for (const [language, words] of Object.entries(table)) {
      const target = merged.get(language) ?? new Map<string, string>()
      merged.set(language, target)
      for (const [english, translation] of Object.entries(words)) {
        if (!target.has(english)) target.set(english, translation)
      }
    }
  }
  return Object.fromEntries([...merged].map(([language, words]) => [language, Object.fromEntries(words)]))
}

/**
 * A translator for the language a tag selects among the translations, which
 * is `ENGLISH` when the tag selects none. A word without a usable translation
 * stays English, and a translated template that would move the line between
 * the tool's words and the call's data (other placeholders, malformed, too
 * long, blank) is dropped for the English one.
 */
export function translator(translations: Translations, tag: string | undefined): Translator {
  const language = languageOf(tag, translations)
  if (language === undefined) return ENGLISH
  const words = translations[language] as Words

  return {
    word(english, limit) {
      const translation = lookup(words, english)
      if (translation === undefined) return english
      return limit === undefined || Array.from(translation).length <= limit ? translation : english
    },
    template(english, limit = MAX_HEADLINE_LENGTH) {
      const translation = lookup(words, english)
      if (translation === undefined || Array.from(translation).length > limit) return english
      const expected = templatePlaceholders(english)
      const actual = templatePlaceholders(translation)
      return expected && actual && sameNames(expected, actual) ? translation : english
    },
  }
}
