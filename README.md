# 来場者数管理アプリ

イベント会場スタッフ向けの来場者数管理アプリです。  
Linux 上で `Docker Compose + SQLite + cloudflared` を使って動かし、スマホから来場者数の加算、訂正、メモ記録、時間帯別確認、CSV 出力ができます。

## 構成

- `app`: Express アプリ
- `cloudflared`: Cloudflare Tunnel

## 主な機能

- 共通パスワードでログイン
- `+1`, `+5`, 任意人数の加算
- 誤入力時の訂正記録
- 時刻付きメモ
- 現在累計の表示
- 時間帯別来場数の表示
- 操作ログ一覧
- CSV 出力

## 初期設定

1. `.env.example` を `.env` にコピーして値を設定します。
2. 少なくとも以下を必ず変更します。

```env
APP_PASSWORD=strong-password
SESSION_SECRET=long-random-secret
PUBLIC_HOSTNAME=visitor.example.com
SQLITE_PATH=/data/visitor.sqlite
CLOUDFLARE_TUNNEL_TOKEN=your-tunnel-token
```

3. Cloudflare Zero Trust 側で Tunnel と Access 保護を設定します。

## 起動

```bash
docker compose up -d --build
```

起動後の確認:

```bash
docker compose ps
docker compose logs -f app
```

ローカル確認:

```bash
curl http://127.0.0.1:1315/health
```

ブラウザでも `http://localhost:1315` で開けます。  
Cloudflare Tunnel を使っていても、同じマシン上では localhost から直接確認できます。

補足:
アプリはコンテナ内では `3000` 番で待ち受け、ホスト側だけ `1315` に公開します。

## Cloudflare 側の想定

- Tunnel の公開先は `app:3000`
- 公開 URL は `PUBLIC_HOSTNAME`
- Cloudflare Access を有効化し、メールまたはワンタイム認証で制限する
- アプリ側の共通パスワード認証と二重化する

## バックアップ

SQLite ファイルのバックアップ例:

```bash
docker compose cp app:/data/visitor.sqlite ./visitor.sqlite.backup
```

復元例:

```bash
docker compose cp ./visitor.sqlite.backup app:/data/visitor.sqlite
```

## テスト

ローカルテスト:

```bash
npm install
npm test
```

## データモデル

- `event_settings`: イベント設定とパスワードハッシュ
- `count_events`: 加算/訂正のイベントログ
- `notes`: 現場メモ

合計値は保持せず、`count_events` の累積から再計算します。
