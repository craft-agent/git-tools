import type { Translations } from "../words"

/** The translations of the push tools' words: their titles and intents, and the words their descriptions write. */
export const PUSH_TRANSLATIONS: Translations = {
  ja: {
    "Read what a push would send": "push で送られる内容を読む",
    "Push the previewed branches": "プレビューしたブランチを push する",
    "About to push branches": "ブランチを push しようとしています",
    "About to push {branch} to {remote}": "{branch} を {remote} に push しようとしています",
    "About to push {count} branches to {remote}": "{count} 本のブランチを {remote} に push しようとしています",
    Branches: "送るブランチ",
    "{create} (new)": "{create}（新規）",
    "{fast_forward} (fast forward)": "{fast_forward}（fast-forward）",
    "{force} (force)": "{force}（force push）",
    "{create} (new); {fast_forward} (fast forward)": "{create}（新規）、{fast_forward}（fast-forward）",
    "{create} (new); {force} (force)": "{create}（新規）、{force}（force push）",
    "{fast_forward} (fast forward); {force} (force)": "{fast_forward}（fast-forward）、{force}（force push）",
    "{create} (new); {fast_forward} (fast forward); {force} (force)":
      "{create}（新規）、{fast_forward}（fast-forward）、{force}（force push）",
  },
}
