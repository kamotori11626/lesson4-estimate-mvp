# メンター向けデモ公開準備

## 公開構成

- 非公開GitHubリポジトリからRender Web Serviceへ配置する。
- Render PostgreSQLの同一リージョン内部URLを`DATABASE_URL`へ参照設定する。
- 公開URLは`APP_ORIGIN`へ`https://...onrender.com`の形式で設定する。
- メンター1名をサーバー側で認証し、業務画面と業務APIを保護する。
- 外部AIは匿名化プレビューと1回ごとの同意がある場合だけGeminiへ送信する。
- メール送信機能・送信APIは設けない。

## 起動段階

通常のローカル運用では、次を独立して実行する。

1. `npm run db:migrate`：テーブル・索引・安全用メタデータを作成・更新する。
2. `npm run db:seed-demo`：5つの配布CSVを再投入する。再実行しても各データ件数は増殖しない。
3. `npm start`：アプリだけを起動する。

無料Render Web Serviceには対話シェルとワンオフジョブがないため、`npm run render:start`は起動時に次の段階を明示する。

1. migration
2. seed check（いずれかの主要テーブルが0件の場合だけ投入）
3. application

有料プランでpre-deploy commandを利用できる場合は、マイグレーションを`npm run db:migrate`へ分離し、通常起動を`npm start`にできる。模擬データ投入は初回だけ`npm run db:seed-demo`を実行する。

## 必須環境変数

秘密値はGitHubや`render.yaml`へ直接記入しない。

|変数|用途|秘密値|
|---|---|---|
|`APP_ENV=production`|本番安全設定|いいえ|
|`HOST=0.0.0.0`|Renderから到達可能にする|いいえ|
|`APP_ORIGIN`|許可するHTTPSオリジン|いいえ|
|`DATABASE_URL`|Render PostgreSQL内部URL|はい|
|`DATABASE_SSL_MODE=disable`|同一リージョンのRender内部ネットワークではTLS不要という明示|いいえ|
|`DEMO_DATA_ONLY=true`|実データ環境でリセットさせない安全スイッチ|いいえ|
|`DEMO_DATA_AS_OF`|画面のデータ基準日|いいえ|
|`DEMO_USERNAME`|メンターのログイン名|取り扱い注意|
|`DEMO_DISPLAY_NAME`|画面・監査表示名|いいえ|
|`DEMO_PASSWORD_HASH`|scryptパスワードハッシュ|取り扱い注意|
|`SESSION_SECRET`|セッショントークンのHMAC鍵|はい|
|`GEMINI_API_KEY`|Gemini API認証|はい|
|`GEMINI_MODEL`|利用モデル名|いいえ|

`DATABASE_SSL_MODE=disable`は外部接続を無検証にする設定ではない。Blueprintの`fromDatabase.connectionString`はRender内部URLであり、同一リージョンの私設ネットワーク通信に限定する。Render外から外部URLへ接続する場合は`verify-full`を使い、検証可能なCA構成を別途用意する。

## 認証情報の作成

`npm run auth:hash-password`を対話型ターミナルで実行する。入力文字は画面へ表示されず、出力された`scrypt$...`だけをRenderの`DEMO_PASSWORD_HASH`へ登録する。平文パスワードはリポジトリ、ログ、チャットへ保存しない。`SESSION_SECRET`はRenderに生成させる。

## デモデータのリセット範囲

認証後のPOSTだけを受け付け、確認文字列と`DEMO_DATA_ONLY=true`、DB内の`dataset_type=demo`の3条件を必要とする。

- 戻す：5つのCSV由来データ、検索索引。
- 削除する操作記録：抽出、回答根拠、名寄せ、類似検索、価格差、承認判定、メール下書き、DB書込確認。
- 保持する：CSV原本、認証セッション、リセットを含む全体監査ログ。

## 停止・削除・無効化

1. Render Web ServiceをSuspendして新規操作を停止する。
2. `DEMO_PASSWORD_HASH`と`SESSION_SECRET`を新しい値へ交換し、既存セッションを無効化する。完全停止ならWeb Serviceを削除する。
3. Gemini APIキーをGoogle側で無効化・削除する。
4. データ保持が不要ならRender PostgreSQLを削除する。削除前に必要な監査記録だけをエクスポートする。
5. GitHub連携を解除し、不要になった非公開リポジトリを削除する。

## 無料プランと費用上の注意

- 無料Web Serviceは無通信15分で停止し、復帰に時間がかかる。
- 無料PostgreSQLは作成から30日で期限切れになり、バックアップと管理接続プールがない。
- 無料利用枠を超えると、支払方法と上限設定によって追加料金または停止が起こり得る。
- 継続利用、安定稼働、バックアップ、pre-deploy commandが必要なら有料構成を事前に見積もる。
