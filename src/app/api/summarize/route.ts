import { NextResponse } from "next/server";
import OpenAI from "openai";

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
  language: string; // 検索用（NewsAPI）に利用。出力は常に日本語。
}): string {
  const { query, days, articles } = params;
  const list = articles
    .map(
      (a, i) =>
        `${i + 1}. ${a.title} — ${a.description || "(説明なし)"} [${a.source}] (${a.publishedAt})\n${a.url}`
    )
    .join("\n\n");

  // 出力は常に日本語
  return (
    `あなたは調査に長けたニュースアナリストです。出力は必ず日本語で、以下のガイドラインに従ってください。\n` +
    `- 重複や宣伝色の強い内容は除外し、一次情報/信頼性を重視する\n` +
    `- 事実と推測を分けて記述する\n` +
    `- 数字や日付は簡潔かつ一貫した書式（YYYY-MM-DD）で示す\n` +
    `- 出典は本文末の「関連リンク」に限り、与えられたURL以外は生成しない\n\n` +
    `出力フォーマット（見出しはそのまま使ってください）:\n` +
    `TL;DR\n` +
    `- 1〜2文で全体像を端的に要約\n\n` +
    `重要ポイント\n` +
    `- 3〜6個の箇条書き。各項目に「要点」「背景/根拠」「今後の見通し」を1〜2文ずつ\n\n` +
    `補足/示唆\n` +
    `- あれば2〜3個の箇条書き（影響、リスク/機会、未解決点 など）\n\n` +
    `関連リンク\n` +
    `- 2〜4件（タイトル – ソース – URL の順）\n\n` +
    `対象トピック: ${query}\n` +
    `対象期間: 過去${days}日\n\n` +
    `記事一覧:\n${list}`
  );
}

export async function POST(req: Request) {
  let body: SummarizeRequest = {};
  try {
    body = await req.json();
  } catch {
    // noop
  }

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
    return NextResponse.json(
      { error: "NEWSAPI_API_KEY が未設定です" },
      { status: 500 }
    );
  }
  if (!OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY が未設定です" },
      { status: 500 }
    );
  }

  try {
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
      // サーバー側でのみ実行（CORS回避）
      cache: "no-store",
    });

    if (!newsRes.ok) {
      const text = await newsRes.text();
      return NextResponse.json(
        { error: "NewsAPI 呼び出しに失敗", details: text },
        { status: 502 }
      );
    }

    const newsJson: unknown = await newsRes.json();
    const parsed = (newsJson ?? {}) as Partial<NewsApiResponse>;
    const rawArticles = Array.isArray(parsed.articles) ? parsed.articles : [];

    // 基本整形
    const normalized: Article[] = rawArticles.map((a) => ({
      title: a?.title ?? "",
      description: a?.description ?? "",
      url: a?.url ?? "",
      source: a?.source?.name ?? "",
      publishedAt: a?.publishedAt ?? "",
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
      // 足りない場合は残りを追加
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

  const prompt = buildPrompt({ query, days, articles, language });

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const aiRes = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
      temperature: 0.3,
    });

  const summary = extractOutputText(aiRes);

    return NextResponse.json({ summary, articles });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        error: "サマリー生成に失敗しました",
        details:
          err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err),
      },
      { status: 500 }
    );
  }
}
