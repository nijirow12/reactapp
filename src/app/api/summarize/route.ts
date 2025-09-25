import { NextResponse } from "next/server";
import OpenAI from "openai";
import cheerio from "cheerio";

export const runtime = "nodejs"; // OpenAI SDKを使うためNode.jsランタイムを明示

type SummarizeRequest = {
  query?: string;
  days?: number;
  pageSize?: number;
  preferDiverseSources?: boolean;
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

function buildPrompt(params: { query: string; days: number; articles: Article[] }): string {
  const { query, days, articles } = params;
  const list = articles
    .map(
      (a, i) =>
        `${i + 1}. TITLE: ${a.title}\nSOURCE: ${a.source}\nPUBLISHED: ${a.publishedAt}\nURL: ${a.url}\nTEXT: ${(a.description || "(説明なし)").slice(0, 800)}`
    )
    .join("\n\n---\n\n");

  return `以下は「${query}」に関する過去${days}日分の記事リストです。各記事を日本語で1文(15〜40文字目安)に要約し、最終的に全体を俯瞰した総合要約(overall)も日本語で1〜2文で作成してください。重要: 出力は必ず厳密なJSONのみ。余計な文章やマークダウンは禁止。\n\n要求JSONスキーマ例:\n{\n  "articles": [ { "index": 1, "summary": "〜" }, ... ],\n  "overall": "全体要約..."\n}\n制約:\n- index は入力リストの番号(1開始)をそのまま使う\n- 要約は事実ベース・簡潔・日本語\n- 記事本文内の未確定情報は断定しない\n- 文字数を抑えて冗長な接続詞を連発しない\n\n記事リスト:\n${list}\n\nJSONのみを出力:`;
}

function parseArticleJson(raw: string, count: number): { per: string[]; overall: string } {
  const per = Array(count).fill("");
  let overall = "";
  try {
    const match = raw.match(/\{[\s\S]*\}$/); // 末尾にあるJSON風を抽出
    const jsonText = match ? match[0] : raw;
    const obj = JSON.parse(jsonText);
    if (Array.isArray(obj.articles)) {
      for (const item of obj.articles) {
        const idx = typeof item.index === "number" ? item.index : Number(item.i || item.id);
        if (idx && idx >= 1 && idx <= count && typeof item.summary === "string") {
          per[idx - 1] = item.summary.trim();
        }
      }
    }
    if (typeof obj.overall === "string") overall = obj.overall.trim();
  } catch {
    // JSON parse 失敗時は後段で fallback
  }
  return { per, overall };
}

export async function POST(req: Request) {
  try {
  const body = (await req.json()) as SummarizeRequest;
  const query = (body.query || "").trim();
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
        console.log("[NewsAPI] raw sample", rawArticles.slice(0, 5).map((a) => ({
          title: a?.title,
          source: a?.source?.name,
          publishedAt: a?.publishedAt,
          url: a?.url,
        })));
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

    const prompt = buildPrompt({ query, days, articles: finalArticles });

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const aiRes = await openai.responses.create({ model: "gpt-4o-mini", input: prompt, temperature: 0.3 });
    const rawSummary = extractOutputText(aiRes);
    const { per: perSummaries, overall } = parseArticleJson(rawSummary, finalArticles.length);

    // Fallback: per-article summary が欠落しているものには簡易生成
    finalArticles.forEach((a, i) => {
      if (!perSummaries[i]) {
        perSummaries[i] = a.title.slice(0, 40);
      }
    });

    try {
      console.log(
        "[NewsAPI] selected",
        finalArticles.slice(0, 10).map((a) => ({ title: a.title, source: a.source, publishedAt: a.publishedAt }))
      );
    } catch {
      // noop
    }

  return NextResponse.json({ overallSummary: overall || rawSummary.slice(0, 500), articles: finalArticles.map((a, i) => ({ ...a, summary: perSummaries[i] })) });
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
