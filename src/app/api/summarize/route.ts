import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs"; // OpenAI SDKを使うためNode.jsランタイムを明示

type SummarizeRequest = {
  query?: string;
  language?: string; // ja | en | ...
  days?: number; // 何日分遡るか
  pageSize?: number; // 取得件数（上限: NewsAPIの制限に依存）
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
    const articles: Article[] = rawArticles.map((a) => ({
      title: a?.title ?? "",
      description: a?.description ?? "",
      url: a?.url ?? "",
      source: a?.source?.name ?? "",
      publishedAt: a?.publishedAt ?? "",
    }));

    if (!articles.length) {
      return NextResponse.json({ summary: "該当する記事が見つかりませんでした。", articles: [] });
    }

    const list = articles
      .map(
        (a, i) =>
          `${i + 1}. ${a.title} — ${a.description || "(説明なし)"} [${a.source}] (${a.publishedAt})\n${a.url}`
      )
      .join("\n\n");

    const prompt = `あなたは調査に長けたアナリストです。以下は「${query}」に関する過去${days}日以内のニュースです。重複や宣伝色の強い内容を避け、重要ポイント3〜6個を箇条書きで日本語要約してください。各ポイントは「要点」「背景/根拠」「今後の見通し」を1〜2文で簡潔に。最後に関連リンクを2〜4件（タイトル + 短い説明）で列挙してください。\n\n記事一覧:\n${list}`;

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
