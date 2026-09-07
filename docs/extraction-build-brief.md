# 見積依頼情報抽出 — Step 2 構築依頼・実装記録

2026-08-30。教材15327本文をログイン済みChromeの既存タブで確認した。MVPスコープ・共通入出力仕様・Step 1メモをもとに、以下を今回の構築依頼として具体化した。

追記（2026-08-31）：以下はStep 2当時の記録。現在の対象範囲判定・条件付きローカル代替・実行情報は[修正版1.3](extraction-item-scope-v13-2026-08-31.md)を参照。過去の検証記録は保持する。

## 1. 入力の形式

営業がブラウザでメール本文・依頼メモのテキストを貼り付ける。顧客名、受付日時（ISO 8601・タイムゾーン付き）、受付経路、案件種別、原文の商品数確認をフォーム入力する。

ユーザー決定：1依頼につき1商品。複数商品は依頼全体を保留。先頭商品だけの処理・自動分割をしない。

開発上の固定値：本文上限10,000 UTF-16コード単位、顧客名200コード単位、APIのJSON本文30,000コード単位。超過はエラーとし、サーバーで切り捨てない。これは業務承認済み上限ではなく、開発用の安全上限。

現段階では添付ファイル・件名・顧客IDは受け付けず、本文貼付の基本機能に限定する。添付確認テキストは将来、確認者・時刻・hashの紐付けと送信許可を整備して追加する。

## 2. 具体的な出力スキーマ

正本コード：`src/extraction-schema.mjs` の `OUTPUT_SCHEMA` と `MODEL_SCHEMA`。`GET /api/extraction/config` でも画面向けスキーマを取得できる。版は `extraction-1.0`（このプロトタイプ用の版であり、既存資料例mvp-1.0を承認済みとみなさない）。

HTTPの応答は `{output, execution, revision}` で包む。OUTPUT_SCHEMAはoutputに適用する。executionはローカル/実AIの区別、モデル・プロンプト・ルール版、実行者の開発用識別、開始完了時刻、外部送信試行回数を保持し、revisionは保存記録の版（整数、失敗時null）。修正保存時のみmessageを添える。これらの管理情報もAIではなくサーバーが生成する。

### 画面・DB用の固定JSON

| キー | 型 |
|---|---|
| schema_version | string、extraction-1.0 |
| request_id | string、サーバーが付けるUUID |
| status | processing / needs_review / confirmed / error。現在は正式認証未実装なのでconfirmedにしない |
| extracted_fields | 下記9項目を必ず持つobject |
| missing_fields | {field_name:string, reason:string, severity:info/warning/hold} のarray |
| warnings_and_holds | {code:string, severity:info/warning/hold, message:string, source:string, required_action:string} のarray |
| audit_log_id | stringまたはnull。記録保存失敗時はnull |

`extracted_fields`の固定キー：customer_name / product_name / product_code / quantity / quantity_unit / material / dimensions / tolerance / requested_delivery_date。

各項目の形：

```json
{
  "value": "ALBKT22",
  "source_quote": "ALBKT22",
  "source_location": {"source_id": "request_text", "start": 26, "end": 33},
  "confidence": null,
  "human_status": "pending"
}
```

- value：数量だけnumber/null、その他はstring/null。希望納期はYYYY-MM-DD/null。寸法・公差は単位・符号を含む文字列。
- source_quote：string/null。存在する連続原文を引用する。
- source_location：上記object/null。startは0始まり、endは終端を含まない。JavaScript文字列のUTF-16コード単位で数える。source_idはrequest_textまたはcustomer_name。位置はモデルではなくサーバーが引用から算出。
- confidence：0〜1またはnull。自己申告の信頼度であり正答確率ではない。ローカル簡易処理ではnull。
- human_status：pending/confirmed/corrected/rejectedを定義。現在はすべてpending。正式な利用者認証・確認処理ができるまで確認済みにしない。
- 型不正・欠落キー・追加キーは拒否。型の自動変換や不明値の0埋めはしない。

### Geminiへ要求するJSON

モデルには上記のうち候補生成だけを担当させる。scope（single/multiple/out_of_scope/uncertain）と、顧客名以外の8項目を持つfieldsを返させる。各項目はvalue、source_quote、confidence、ambiguous:boolean、candidate:string/nullを必須とする。

顧客名は入力フォームの値を内部で保持する。案件ID・監査ID・処理状態・人間確認状態はモデルに生成させない。

`ambiguous=true`ならvalue=null。candidateは原文内の要確認表現だけを警告表示する。曖昧な納期から具体的な日付を推測しない。

## 3. 入力例と出典

以下は12_見積依頼ログ.csvのRFQ-00003（データ行3、ヘッダーを含む4行目）のproduct_text=ALBKT22、quantity=100、received_date=2025-06-08、requested_delivery_date=2025-06-20を参考に再構成した例。元のメール本文ではない。顧客名は架空、数量の「個」と挨拶文は試験用に追加。金額・粗利・担当者・受注結果は使用しない。

```text
検証用顧客Aです。お見積りをお願いします。
品番: ALBKT22
数量: 100個
希望納期: 2025-06-20
よろしくお願いいたします。
```

期待値：品番ALBKT22、数量100、単位「個」、希望納期2025-06-20。品名・材質・寸法・公差はnull。顧客名は内部フォームと照合する。

受付日時は2025-06-08T09:00:00+09:00とする。過去ログの試験なので希望日の過去判定は「受付日より前か」で評価し、試験を行う今日と比較しない。受付日の時刻部分は試験用の仮定。

その他、RFQ-00001参考の公差不明、RFQ-00004加工の曖昧な納期、架空の複数商品、業務外の計5例を `src/extraction-samples.mjs` に収録。サンプル選択だけでは送信しない。

## 4. 判断が難しい場合のルール

| 状況 | 処理 |
|---|---|
| 未記載 | value=nullとし、不足一覧に表示。全項目必須とは決めず、必要性は人間が確認 |
| 複数解釈・前回同様・来月半ば | value=null、原文の候補表現と要確認警告。最もありそうな値を確定しない |
| 原文にない引用・値 | 候補を棄却し、EVIDENCE_INVALIDを表示 |
| 数量0・負数／日付不正 | 候補を採用しない |
| 希望日が受付日より前 | nullとPAST_DELIVERYを表示 |
| 複数商品 | MULTIPLE_ITEMS、全項目未採用、全体needs_review。修正保存からも解除不可 |
| 商品数不明・複数の数量表現 | ITEM_COUNT_UNCERTAINとして全体保留 |
| 明らかな業務外 | OUT_OF_SCOPEとして対象外を記録 |
| 新規特注・緊急等 | OUT_OF_MVPとして既存の人手処理へ戻す |
| JSON不正・AIエラー・監査失敗 | error。自動再試行・確定・後工程への引渡しをしない |

商品数は画面で人間が確認する。加えてローカルの明示パターン検知とモデルのscope判定を行う。自然文の全パターンを規則だけで識別できるわけではない。商品数検知の実AI精度も未検証。

## 5. 採用アーキテクチャに合わせた実装

```text
ブラウザ：本文貼付・入力例・候補/根拠/不足/保留の表示・修正下書き
   ↓ 同一オリジンのJSON API
Node.js：入力検証 → 対象範囲 → 送信制御 → 抽出 → スキーマ/根拠検査
   ├ ローカル簡易抽出（AIなし。品番: 等のラベル付き入力の参考動作）
   ├ サーバー側Gemini API（匿名サンプルのみ・同意ごと1回）
   └ PostgreSQL：抽出記録・監査イベント・修正下書き履歴
```

- 既存のHTML/CSS/JavaScript・Node.js HTTP API・PostgreSQLを継続。新しいフレームワーク・ライブラリは追加していない。
- Geminiは既存.envのGEMINI_MODELを使用。キーやモデルをこの作業で変更していない。
- [Google公式API仕様](https://ai.google.dev/api/generate-content)に従いresponseMimeTypeとresponseJsonSchemaを指定。JSONの意味的な正しさは別途、サーバーと人間が検証する。
- 既存の固定文接続テストはそのまま残す。抽出試験とは別機能。
- PostgreSQLの既存配布CSVテーブルは変更・再取込しない。抽出用3テーブルを追加する。
- 副作用を限定：顧客送信、価格確定、Hanbai-One書戻し、添付取得、後工程への自動引渡しは実装しない。

## 6. 外部送信と開発限定の境界

今回、自由入力した実業務文を外部送信できる仕組みにはしていない。画面の同意だけで業務上の送信許可が得られたとはみなさない。

- Geminiで試せるのは、サーバーに用意した匿名サンプルと本文・顧客欄・受付情報等が完全一致する入力だけ。
- 送信時に架空顧客名も[CUSTOMER]へ置換。送信するのは匿名化本文と固定プロンプト・スキーマのみ。
- 自由入力やサンプルへの追記はEXTERNAL_DATA_NOT_APPROVEDで遮断。正規表現だけで一般の機密情報を完全除去できるとは主張しない。
- 画面に送信先・設定モデル・実際に送る本文を表示。送信同意は入力変更・1回の処理完了で解除。
- 外部APIは最大1回・待機上限30秒・リダイレクト禁止。APIキー、プロバイダーの生エラー、レスポンス全体は画面やログに出さない。
- サーバーは127.0.0.1のみで待ち受ける。抽出APIは他Origin/Hostやフォーム形式のPOSTを拒否する。
- 認証未実装のためexecution_user_idはlocal-development、identity_modeはunauthenticated_localと明記。実在の担当者が確認済みとは記録しない。
- 修正下書きをDB保存してもneeds_review/pendingを維持。認証・必須業務ルールが整うまでは正式確認と後工程連携を実装しない。
- 本番のアクセス制御・バックアップ・保持期間・承認された実業務文の送信範囲は、この段階の合格対象外。

## 7. 起動・確認手順

普段の4173番サーバーを起動したターミナルでControl+Cを押し、次を実行する。

```sh
cd /Users/shohei/work/Codex/2026-07-31/lesson4-mvp
npm run db:prepare-extraction
npm run dev
```

DB準備は繰返し実行可能で、CSVは再取込しない。すでにDB準備済みならnpm run devだけでよい。DB未起動の場合は先にnpm run db:start。

1. http://127.0.0.1:4173 を再読み込みする。
2. 「明確な依頼」サンプルを選ぶ。方式は最初「ローカル簡易抽出」のまま。
3. 「抽出する」を押す。品番ALBKT22・数量100・希望日2025-06-20と不足項目を確認。
4. 「複数商品」を選び直す。「抽出する」でMULTIPLE_ITEMS・全値未採用になることを確認。
5. 実AI試験へ進むときだけ「Gemini抽出」を選ぶ。送信先・本文・モデルを確認し、同意後に「抽出する」を押す。

抽出Geminiの設定変更は不要（既存接続設定を使用）。設定モデルが対応する構造化出力で正常応答すること、および実AI抽出精度はまだ未確認。503等が返っても自動再試行せず、停止結果を確認する。

## 8. 検証結果と残作業

- 自動テスト：`npm test`で35件成功（既存12、新規23）。実APIはテスト用応答に差し替え、外部通信なし。日本語のHTTP分割受信、JSON・文字コード・入力上限も確認。
- 異なる3例で9項目・共通5属性の固定形式、不足・曖昧値のnull、根拠照合を確認。
- 複数商品・対象外・商品数不明・偽の確認済み出力・監査失敗・API失敗・同意なし・非許可入力・同時実行・古い版の修正をテスト。
- Chromeでローカル画面の抽出・原文表示・PostgreSQL保存・再読出し、複数商品保留を確認。確認用サーバーは4174番・AI_PROVIDER=mock。通常4173番サーバーは停止していない。
- 画面試験の匿名記録7件、開始イベント7件、完了イベント7件、修正下書き保存イベント1件をDBで読出し確認。外部送信試行の合計は0回。試験記録は追跡用に残した。4174番の確認用サーバーは試験終了後に停止。
- 配布データの件数は顧客200・商品200・過去見積2,000・見積依頼1,000・外注先86のまま。
- 残作業：実Geminiで3件以上の入力を試し、正解表と照合するStep 3。業務観点のStep 4、80%初回確認合格率、本番の漏洩ゼロやログ完全性の達成を、この試験だけで宣言しない。

Step 2の基本実装と通信なしの動作確認まで。教材Chapter全体の完了ではない。
