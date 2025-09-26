import { NextResponse } from "next/server";
import OpenAI from "openai";
import cheerio from "cheerio";

export const runtime = "nodejs"; // OpenAI SDKを使うためNode.jsランタイムを明示

type SummarizeRequest = {
  query?: string;
  days?: number;
  pageSize?: number;
  preferDiverseSources?: boolean;
  country?: string; // ISO 2-letter (for top-headlines)
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
  type MaybeAuthorArticle = Article & { author?: string };
  const list = (articles as MaybeAuthorArticle[])
    .map(
      (a, i) =>
        `${i + 1}. TITLE: ${a.title}\nSOURCE: ${a.source}\nPUBLISHED: ${a.publishedAt}\nAUTHOR: ${a.author || ""}\nURL: ${a.url}\nDESCRIPTION: ${(a.description || "(説明なし)").slice(0, 800)}`
    )
    .join("\n\n---\n\n");

  return `以下はトピック「${query}」に関する過去${days}日分の記事一覧です。各記事について以下3点を日本語で簡潔に作成し、厳密なJSONのみを出力してください。追加説明やマークダウンは禁止。\n\n各記事で必要な3要素 (bullet 用):\n1) message: その記事が主に伝える中心メッセージ（15〜35文字程度、日本語）。\n2) support: そのメッセージを裏付ける具体的根拠/データ/事実（1文、日本語）。誇張や憶測は禁止。\n3) citation: APA形式の引用（Web記事版）。形式: Author/Source. (年, 月 日). Title. Source/Publisher. URL\n   - Authorが欠落する場合: Source名を著者位置に。\n   - 日付が不明: (n.d.) を使用し、月日省略。\n   - Titleは原文表記（可能なら30〜120文字にトリムし省略記号不要）。\n\n出力JSON スキーマ例:\n{\n  "articles": [\n    {\n      "index": 1,\n      "message": "中心メッセージ",\n      "support": "根拠となる具体的事実",\n      "citation": "Author. (2025, September 10). Title.... Source. URL"\n    }\n  ]\n}\n制約:\n- articles.length は入力記事数と同じ\n- index は1開始で対応記事番号\n- message / support は日本語。citation はAPA書式（英語タイトル原文可）\n- 推測語(恐らく/かもしれない)は避け、提供情報に基づく簡潔表現\n- support に複数文を入れない\n\n記事一覧:\n${list}\n\n厳密なJSONのみで出力:`;
}
function parseArticleJsonDetailed(raw: string, count: number): { per: { message: string; support: string; citation: string }[] } {
  const per = Array(count)
    .fill(null)
    .map(() => ({ message: "", support: "", citation: "" }));
  try {
    const match = raw.match(/\{[\s\S]*\}$/);
    const jsonText = match ? match[0] : raw;
    const obj = JSON.parse(jsonText);
    if (Array.isArray(obj.articles)) {
      for (const item of obj.articles) {
        const idx = typeof item.index === "number" ? item.index : Number(item.i || item.id);
        if (idx && idx >= 1 && idx <= count) {
          if (typeof item.message === "string") per[idx - 1].message = item.message.trim();
          if (typeof item.support === "string") per[idx - 1].support = item.support.trim();
          if (typeof item.citation === "string") per[idx - 1].citation = item.citation.trim();
        }
      }
    }
  } catch {
    // noop
  }
  return { per };
}

export async function POST(req: Request) {
  try {
  const body = (await req.json()) as SummarizeRequest;
  const query = (body.query || "").trim();
  const country = (body.country || "").trim().toLowerCase();
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

    // country が指定された場合は top-headlines を利用（from/sortBy 不可）
    let url: URL;
    if (country) {
      url = new URL("https://newsapi.org/v2/top-headlines");
      const params: Record<string, string> = {
        country,
        pageSize: String(pageSize),
      };
      if (query) params.q = query; // top-headlines でもキーワードは利用可
      url.search = new URLSearchParams(params).toString();
    } else {
      url = new URL("https://newsapi.org/v2/everything");
      url.search = new URLSearchParams({
        q: query,
        sortBy: "publishedAt",
        pageSize: String(pageSize),
        from: fromDate,
        language: "ja", // デフォルトは日本語記事
      }).toString();
    }

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

  // 2) ソース多様性優先（オプション） ※ top-headlines でも適用
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
    const { per: perDetails } = parseArticleJsonDetailed(rawSummary, finalArticles.length);

    // Fallback
    finalArticles.forEach((a, i) => {
      const d = perDetails[i];
      if (!d.message) d.message = a.title.slice(0, 40);
      if (!d.support) d.support = (a.description || "")?.split(/\n|。/)[0]?.slice(0, 60) || a.source;
      if (!d.citation) {
        const year = a.publishedAt ? a.publishedAt.slice(0, 4) : "n.d.";
        d.citation = `${a.source || "Source"}. (${year}). ${a.title}. ${a.source || "Publisher"}. ${a.url}`;
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

  return NextResponse.json({ articles: finalArticles.map((a, i) => ({ ...a, summaryBullets: [perDetails[i].message, perDetails[i].support, perDetails[i].citation] })) });
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
