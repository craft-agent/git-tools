import type { Translations } from "../words"

/** The translations of the commit tools' words: their titles and intents, and the words their descriptions write. */
export const COMMIT_TRANSLATIONS: Translations = {
  ja: {
    "Read the checks before a commit": "コミット前のチェックを読む",
    "Stage chosen hunks": "選んだハンクをステージする",
    "About to stage chosen hunks": "選んだハンクをステージしようとしています",
    "About to stage hunks of {file}": "{file} のハンクをステージしようとしています",
    Hunks: "ハンク",
    "{hunks} of {total}": "{total} 個中 {hunks} 個",
    "Hunks to stage": "ステージするハンク",
    "Commit the staged changes": "ステージした変更をコミットする",
    "About to commit the staged changes": "ステージした変更をコミットしようとしています",
    "Amend the last commit": "直前のコミットを修正する",
    "About to amend the last commit": "直前のコミットを修正しようとしています",
    "Check each commit of the branch": "ブランチの各コミットをチェックする",
    "About to run a check at each commit": "各コミットでチェックを実行しようとしています",
  },
}
