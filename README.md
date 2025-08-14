ニュース要約アプリ（NewsAPI + OpenAI）

このアプリは、興味のあるトピックのニュースをNewsAPIから取得し、OpenAIで要約して表示します。Next.js App Routerで実装されています。

## セットアップ

1) 依存インストール

```bash
npm i
```

2) 環境変数を `.env.local` に設定

```
NEWSAPI_API_KEY=your_newsapi_key
OPENAI_API_KEY=your_openai_key
```

3) 起動

```bash
npm run dev
```

ブラウザで http://localhost:3000 を開きます。

## 使い方

- トップページでトピック、言語、日数、件数を入力し「取得して要約」を押すと、記事一覧の取得と要約結果が表示されます。

## 注意事項

- APIキーはサーバー側APIルート（`/api/summarize`）のみで使用しており、クライアントへ露出しません。
- NewsAPIの無料/有料プランや利用規約の制限に従ってください。
