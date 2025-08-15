import { NextResponse } from "next/server";
import OpenAI from "openai";
import cheerio from "cheerio";

export const runtime = "nodejs"; // OpenAI SDKを使うためNode.jsランタイムを明示

type SummarizeRequest = {
  query?: string;
  language?: string; // ja | en | ...
  days?: number; // 何日分遡るか
  pageSize?: number; // 取得件数（上限: NewsAPIの制限に依存）
  preferDiverseSources?: boolean; // ソース多様性を優先
};

type Article = {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
  // サーバーで抽出した全文（可能なら）。クライアントにも返す
  extractedText?: string | null;
};

type NewsApiArticle = {
  source?: { id?: string | null; name?: string | null } | null;
  author?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  urlToImage?: string | null;
  publishedAt?: string | null;
  content?: string | null;
};

type NewsApiResponse = {
  status?: string;
  totalResults?: number;
  articles?: NewsApiArticle[];
};

type OutputContent = { type?: string; text?: string };
type OutputItem = { content?: OutputContent[] };
type ResponsesLike = { output_text?: string; output?: OutputItem[] };

function extractOutputText(r: unknown): string {
  if (r && typeof r === "object") {
    const obj = r as Partial<ResponsesLike>;
    if (typeof obj.output_text === "string") return obj.output_text;
    if (Array.isArray(obj.output)) {
      const texts: string[] = [];
      for (const item of obj.output) {
        const contents = item?.content;
        if (!Array.isArray(contents)) continue;
        for (const c of contents) {
          if (c && c.type === "output_text" && typeof c.text === "string") {
            texts.push(c.text);
          }
        }
      }
      return texts.join("\n");
    }
  }
  return "";
}

function buildPrompt(params: {
  query: string;
  days: number;
  articles: Article[];
  language: string;
}): string {
  const { query, days, articles } = params;
  const list = articles
    .map(
      (a, i) =>
        `${i + 1}. ${a.title} — ${a.description || "(説明なし)"} [${a.source}] (${a.publishedAt})\n${a.url}`
    )
    .join("\n\n");

  return (
    `出力フォーマット（見出しはそのまま使ってください）。重要: 記事数が多い場合でも下記の形式を守り、必ず全ての提供記事に対して短い要約を出力してください。\n\n` +
    `1) 各記事の短い要約（必須）\n` +
    `- 記事一覧に示した全記事（最大 ${articles.length} 件）について、各番号に対応する1文（目安: 15〜40文字）で要約してください。\n` +
    `- 形式は厳密に「n) 要約文」のように番号をつけて出力してください（例: "1) 主要な技術発表があり、〜"）。\n\n` +
    `2) TL;DR（要約）\n` +
    `- 1〜2文で全体像を端的にまとめる\n\n` +
    `3) 重要ポイント\n` +
    `- 3〜6個の箇条書き。各項目に「要点」「背景/根拠」「今後の見通し」を1〜2文ずつ\n\n` +
    `4) 補足/示唆（あれば）\n` +
    `- 2〜3個の箇条書き（影響、リスク/機会、未解決点 など）\n\n` +
    `5) 関連リンク\n` +
    `- 2〜4件（タイトル – ソース – URL の順）\n\n` +
    `注意: 本プロンプトには多くの記事が含まれる可能性があります。各記事の要約は短めにして出力全体のトークン量を抑えてください。重要記事のみ深掘りする場合は、記事に"[本文抜粋]"が含まれるものを優先して参照してください。\n\n` +
    `対象トピック: ${query}\n` +
    `対象期間: 過去${days}日\n\n` +
    `記事一覧:\n${list}`
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SummarizeRequest;
    const query = (body.query || "").trim();
    const language = (body.language || "ja").trim();
    const days = Math.min(Math.max(Number(body.days ?? 1), 1), 30);
    const pageSize = Math.min(Math.max(Number(body.pageSize ?? 10), 1), 50);
    const preferDiverseSources = Boolean(body.preferDiverseSources);

    if (!query) {
      return NextResponse.json({ error: "'query' は必須です" }, { status: 400 });
    }

    const NEWSAPI_API_KEY = process.env.NEWSAPI_API_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!NEWSAPI_API_KEY) {
      return NextResponse.json({ error: "NEWSAPI_API_KEY が未設定です" }, { status: 500 });
    }
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY が未設定です" }, { status: 500 });
    }

    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD

    const url = new URL("https://newsapi.org/v2/everything");
    url.search = new URLSearchParams({
      q: query,
      language,
      sortBy: "publishedAt",
      pageSize: String(pageSize),
      from: fromDate,
    }).toString();

    const newsRes = await fetch(url.toString(), {
      headers: { "X-Api-Key": NEWSAPI_API_KEY },
      cache: "no-store",
    });

    if (!newsRes.ok) {
      const text = await newsRes.text();
      return NextResponse.json({ error: "NewsAPI 呼び出しに失敗", details: text }, { status: 502 });
    }

    const newsJson: unknown = await newsRes.json();
    const parsed = (newsJson ?? {}) as Partial<NewsApiResponse>;
    const rawArticles = Array.isArray(parsed.articles) ? parsed.articles : [];

    // 詳細ログは環境変数で制御
    const debugNews =
      (process.env.DEBUG_NEWSAPI ?? "").toLowerCase() === "true" || process.env.DEBUG_NEWSAPI === "1";
    if (debugNews) {
      try {
        console.log(
          "[NewsAPI] raw sample",
          rawArticles.slice(0, 5).map((a) => ({
            title: a?.title,
            source: a?.source?.name,
            publishedAt: a?.publishedAt,
            url: a?.url,
          }))
        );
      } catch {
        // noop
      }
    }

    // 基本整形
    const normalized: Article[] = rawArticles.map((a) => ({
      title: a?.title ?? "",
      description: a?.description ?? "",
      url: a?.url ?? "",
      source: a?.source?.name ?? "",
      publishedAt: a?.publishedAt ?? "",
      extractedText: null,
    }));

    // 1) 重複排除（タイトル or URL で単純排除）
    const seen = new Set<string>();
    const deduped: Article[] = [];
    for (const item of normalized) {
      const key = (item.title || item.url).trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    // 2) ソース多様性優先（オプション）
    let articles: Article[] = deduped;
    if (preferDiverseSources) {
      const bySource = new Map<string, Article>();
      for (const a of deduped) {
        if (!bySource.has(a.source)) bySource.set(a.source, a);
        if (bySource.size >= pageSize) break;
      }
      const picked = Array.from(bySource.values());
      if (picked.length < pageSize) {
        for (const a of deduped) {
          if (picked.length >= pageSize) break;
          if (!picked.includes(a)) picked.push(a);
        }
      }
      articles = picked.slice(0, pageSize);
    } else {
      articles = deduped.slice(0, pageSize);
    }

    if (!articles.length) {
      return NextResponse.json({ summary: "該当する記事が見つかりませんでした。", articles: [] });
    }

    // 主要記事の本文をサーバー側で取得して抜粋を生成（最大3件）
    async function fetchArticleText(url: string): Promise<string | null> {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return null;
        const html = await res.text();
        const $ = cheerio.load(html);
        const selectors = [
          "article",
          "main",
          "#content",
          "[role=main]",
          ".article-body",
          ".post-content",
          ".entry-content",
        ];
        for (const sel of selectors) {
          const el = $(sel).first();
          if (el && el.text().trim().length > 200) {
            return el.text().replace(/\s+/g, " ").trim();
          }
        }
        const ps = $("p").toArray().map((p) => $(p).text().trim()).filter(Boolean);
        const joined = ps.join(" \n\n ");
        return joined.length > 200 ? joined : null;
      } catch {
        return null;
      }
    }

    const maxFull = 3;
    const enrichedArticles: Article[] = [];

    const debugNewsFull =
      (process.env.DEBUG_NEWSAPI ?? "").toLowerCase() === "full" ||
      (process.env.DEBUG_NEWSAPI_FULL ?? "").toLowerCase() === "true" ||
      process.env.DEBUG_NEWSAPI_FULL === "1";

    for (const a of articles.slice(0, maxFull)) {
      const text = await fetchArticleText(a.url);
      // descriptionには短めの抜粋を入れる
      enrichedArticles.push({
        ...a,
        description: text ? a.description + "\n\n[本文抜粋]\n" + text.slice(0, 1000) : a.description,
        extractedText: text ?? null,
      });

      // 全文は必ずサーバー側で出力（開発目的）
      if (text) {
        try {
          console.log("[NewsAPI FETCHED TEXT - ALWAYS]", {
            url: a.url,
            source: a.source,
            publishedAt: a.publishedAt,
            extractedText: text,
          });
        } catch {
          // noop
        }
      }

      if (debugNewsFull && text) {
        try {
          console.log("[NewsAPI FULL TEXT]", {
            url: a.url,
            source: a.source,
            publishedAt: a.publishedAt,
            fullText: text,
          });
        } catch {
          // noop
        }
      }
    }

    const finalArticles = enrichedArticles.concat(articles.slice(maxFull));

    const prompt = buildPrompt({ query, days, articles: finalArticles, language });

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const aiRes = await openai.responses.create({ model: "gpt-4o-mini", input: prompt, temperature: 0.3 });
    const summary = extractOutputText(aiRes);

    try {
      console.log(
        "[NewsAPI] selected",
        finalArticles.slice(0, 10).map((a) => ({ title: a.title, source: a.source, publishedAt: a.publishedAt }))
      );
    } catch {
      // noop
    }

    return NextResponse.json({ summary, articles: finalArticles });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        error: "サマリー生成に失敗しました",
        details: err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err),
      },
      { status: 500 }
    );
  }
}
