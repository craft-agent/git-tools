import type { Translations } from "../words"

/** The translations of the rebase tools' words: their titles and intents, and the words their descriptions write. */
export const REBASE_TRANSLATIONS: Translations = {
  ja: {
    "Read the stack of the branch": "ブランチの stack を読む",
    "Rebase the stack": "stack を rebase する",
    "About to rebase the stack": "stack を rebase しようとしています",
    "About to rebase {branch} onto {onto}": "{branch} を {onto} に rebase しようとしています",
    "About to fold the fixups of {branch}": "{branch} の fixup を畳み込もうとしています",
    Layers: "レイヤー",
    After: "取り込み済み",
    Fixups: "fixup",
    "{fixups} to fold": "{fixups} 件を畳み込む",
    "Resume the stopped rebase": "止まった rebase を再開する",
    "About to resume the stopped rebase": "止まった rebase を再開しようとしています",
    "About to continue the rebase of {branch}": "{branch} の rebase を続行しようとしています",
    "About to skip {commit} in the rebase of {branch}": "{branch} の rebase で {commit} をスキップしようとしています",
    "About to abort the rebase of {branch}": "{branch} の rebase を中止しようとしています",
    "Cut the branch into layers": "ブランチをレイヤーに分割する",
    "About to cut the branch into layers": "ブランチをレイヤーに分割しようとしています",
    "About to cut {branch} into {layers} layers": "{branch} を {layers} 個のレイヤーに分割しようとしています",
    "About to add the layer {name} on {branch}": "{branch} の上にレイヤー {name} を追加しようとしています",
    "About to cut {branch} into {layers} layers and add {name} on top":
      "{branch} を {layers} 個のレイヤーに分割し、最上段に {name} を追加しようとしています",
    "{name} on top": "最上段に {name}",
    "{cuts}; {name} on top": "{cuts}、最上段に {name}",
  },
}
