# Phase 6 公開・引き渡し記録

## 公開先

- 公開URL: https://lesson4-estimate-demo.onrender.com
- GitHub: https://github.com/kamotori11626/lesson4-estimate-mvp
- GitHub公開範囲: Private
- Render Web Service: `lesson4-estimate-demo`（Free）
- Render PostgreSQL: `lesson4-estimate-demo-db`（Free）
- 公開コミット: `40165cf`（Allow safe cross-site demo navigation）
- メンター用ユーザー名: `mentor-demo`
- パスワード: macOS Keychainのサービス `lesson4-estimate-mvp-render-demo`、アカウント `mentor-demo` に保存。本文、GitHub、Renderログには記載しない。

## 公開時の処理

Render起動時に、次の順序で処理する。

1. `npm run db:migrate`
2. 模擬データの有無を確認し、未投入時だけ `npm run db:seed-demo`
3. `npm start`

2026-09-07のRenderログで、`migrate`、`seed check`、`application`の各段階と、`0.0.0.0:10000`での起動、HTTPS公開URLのLive状態を確認した。

## 公開環境テスト

確認日時: 2026-09-07 22:02 JST

| 確認項目 | 結果 |
| --- | --- |
| 未認証で業務画面へアクセス | `303`で`/login`へ遷移 |
| 未認証で業務APIへアクセス | `401`で拒否 |
| 許可外OriginからPOST | `403`で拒否 |
| 正常ケース | 7工程完了、承認不要、下書き品質合格 |
| 不足情報ケース | 7工程完了、4項目不足を検知、保留、下書き品質合格 |
| 承認要ケース | 7工程完了、承認必須、下書き品質合格 |
| DB保存・再表示 | 3ケースすべて一致 |
| 操作者の記録 | 認証済み利用者として記録 |
| Gemini実送信 | 0件 |
| メール自動送信 | なし |

## 秘密情報の管理

- `.env`、APIキー、DB接続情報、パスワード、セッション秘密鍵はGitHubへ登録しない。
- `.postgres`、`node_modules`、`.DS_Store`、ローカル検証用資格情報をGitHubへ登録しない。
- Gemini APIキーはRenderの秘密環境変数だけに保存する。
- メンター用パスワードはURLと同じメッセージに書かず、別経路で共有する。
- 公開検証はローカル抽出で行い、Geminiへの実送信は行わない。
- 公開準備中に表示された旧Gemini APIキーはRenderから除去し、Google Cloud側で削除済み。現在の有効キーは画面、ログ、チャットへ表示していない。

## メンターへの安全な伝達

1. 公開URLとユーザー名 `mentor-demo` を通常の連絡メッセージで伝える。
2. パスワードは別経路で伝える。ローカルでは「キーチェーンアクセス」でサービス名 `lesson4-estimate-mvp-render-demo` を検索し、アカウント `mentor-demo` のパスワードを表示できる。
3. メンター確認後、パスワードをローテーションするかWeb Serviceを停止する。

## 確認終了後の停止・無効化

1. Render Dashboardで`lesson4-estimate-demo`を選択し、Suspendを実行してWeb公開を停止する。
2. 再開する場合は同じサービスでResumeを実行する。
3. 認証情報だけを無効化する場合は、`DEMO_PASSWORD_HASH`と`SESSION_SECRET`を新しい値へローテーションして再デプロイする。
4. AI接続も不要になった場合は、Renderの`GEMINI_API_KEY`を削除し、Google AI Studio / Google Cloud側でも該当キーを無効化または削除する。
5. PostgreSQLを削除する場合はデータが復元できなくなるため、メンター確認完了と保存不要を確認してから別途実行する。今回の公開作業では削除しない。

## 無料構成の制約

- Free Web Serviceは無操作時に休止し、初回表示に時間がかかる場合がある。
- Free PostgreSQLには期限とバックアップ上の制約がある。今回はメンター確認日が期限内であることを確認済み。
- ローカルのプロジェクト、PostgreSQL、CSV、テスト成果物は削除しておらず、Render側の期限後もローカルで再確認できる。
