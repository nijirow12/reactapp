import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

type RetailTrendingRequest = {
  days?: number; // 遡る日数
  pages?: number; // NewsAPI ページ数 (各最大100件)
  pageSize?: number; // 1ページの件数 (<=100)
};

type Article = {
  index: number; // クラスタリング対象時のインデックス (1開始)
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
};

type RawNewsArticle = {
  source?: { id?: string | null; name?: string | null } | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  publishedAt?: string | null;
};

const RETAIL_QUERY = '((retail OR "retail industry" OR 小売 OR "小売業" OR e-commerce OR ecommerce OR EC OR "supply chain" OR 店舗 OR オムニチャネル OR omnichannel OR Amazon OR Walmart OR Shopify OR Target OR Costco))';

async function fetchNewsBatch(params: {
  apiKey: string;
  from: string;
  page: number;
  pageSize: number;
  sortBy: string;
}): Promise<RawNewsArticle[]> {
  const { apiKey, from, page, pageSize, sortBy } = params;
  const url = new URL("https://newsapi.org/v2/everything");
  url.search = new URLSearchParams({
    q: RETAIL_QUERY,
    sortBy,
    from,
    language: "en", // retail関連は英語が多いので英語優先（日本語記事も拾いたければ削除）
    page: String(page),
    pageSize: String(pageSize),
  }).toString();
  const res = await fetch(url.toString(), {
    headers: { "X-Api-Key": apiKey },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const json = await res.json();
  const list = Array.isArray(json?.articles) ? json.articles : [];
  return list as RawNewsArticle[];
}

function normalize(raw: RawNewsArticle[]): Article[] {
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const r of raw) {
    const title = (r.title ?? "").trim();
    const url = (r.url ?? "").trim();
    if (!title || !url) continue;
    const key = (title + "::" + url).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      index: out.length + 1,
      title,
      description: (r.description ?? "").trim(),
      url,
      source: (r.source?.name ?? "").trim(),
      publishedAt: (r.publishedAt ?? "").trim(),
    });
  }
  return out;
}

function buildClusterPrompt(articles: Article[]): string {
  const list = articles
    .map(
      (a) =>
        `${a.index}. TITLE: ${a.title}\nSOURCE: ${a.source}\nPUBLISHED: ${a.publishedAt}\nDESC: ${(a.description || "").slice(0, 200)}`
    )
    .join("\n\n");

  return `You are an analyst identifying CURRENT, HIGH-IMPACT RETAIL INDUSTRY TRENDS.\nArticles list (indexed):\n${list}\n\nTask: Cluster articles into up to 8 trending topics for the global retail / e-commerce sector (supply chain, consumer shifts, strategy, technology, macro).\nReturn STRICT JSON ONLY (no markdown). JSON schema:\n{\n  "trendingTopics": [\n    {\n      "topic": "短い日本語名",\n      "reason": "なぜ注目か(日本語1文)",\n      "articles": [1,2],\n      "message": "要約メッセージ(日本語1文)",\n      "support": ["具体的根拠1", "具体的根拠2"],\n      "significance": "影響/示唆(日本語1文)",\n      "citations": ["APA形式引用", "APA形式引用"]\n    }\n  ]\n}\nRules:\n- 必ず articles 配列はインデックス参照のみ\n- support は最大3件、出典を簡潔に\n- citations は代表記事 1~3 件 (Title. Source. YYYY-MM-DD. URL) 形式 (簡易APA)\n- 重要度順 (最もホットなトレンドを先頭)\n- データが不足する場合は返さない (空文字禁止)\n- 重複・ほぼ同義のトピックは統合\n出力は JSON のみ:`;
}

interface ClusterJSONTopic {
  topic: string;
  reason: string;
  articles: number[];
  message: string;
  support: string[];
  significance: string;
  citations: string[];
}
interface ClusterJSON { trendingTopics: ClusterJSONTopic[] }
function parseClusterJson(raw: string): ClusterJSON {
  try {
    const match = raw.match(/\{[\s\S]*\}$/);
    const txt = match ? match[0] : raw;
    const obj = JSON.parse(txt);
    if (Array.isArray(obj.trendingTopics)) return obj as ClusterJSON;
  } catch {}
  return { trendingTopics: [] };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as RetailTrendingRequest;
    const days = Math.min(Math.max(Number(body.days ?? 3), 1), 30);
    const pages = Math.min(Math.max(Number(body.pages ?? 2), 1), 5); // NewsAPI課金状況に応じ調整
    const pageSize = Math.min(Math.max(Number(body.pageSize ?? 50), 1), 100);

    const NEWSAPI_API_KEY = process.env.NEWSAPI_API_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!NEWSAPI_API_KEY) return NextResponse.json({ error: "NEWSAPI_API_KEY 未設定" }, { status: 500 });
    if (!OPENAI_API_KEY) return NextResponse.json({ error: "OPENAI_API_KEY 未設定" }, { status: 500 });

    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 2種類のソートで並列取得 (recency + popularity)
    const fetchPromises: Promise<RawNewsArticle[]>[] = [];
    for (const sortBy of ["publishedAt", "popularity"]) {
      for (let p = 1; p <= pages; p++) {
        fetchPromises.push(
          fetchNewsBatch({ apiKey: NEWSAPI_API_KEY, from: fromDate, page: p, pageSize, sortBy })
        );
      }
    }

    const rawBatches = await Promise.all(fetchPromises);
    const mergedRaw = rawBatches.flat();
    const normalized = normalize(mergedRaw);

    // 最新順でソート
    normalized.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

    // LLMへのトークン対策: 上位 N 件 (最大 80) のみクラスタリング対象
    const clusterTarget = normalized.slice(0, 80);

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const prompt = buildClusterPrompt(clusterTarget);
    const aiRes = await openai.responses.create({ model: "gpt-4o-mini", input: prompt, temperature: 0.2 });
    const text = (() => {
      try {
        const maybe: unknown = (aiRes as unknown as { output_text?: string }).output_text;
        if (typeof maybe === "string") return maybe;
      } catch {}
      return JSON.stringify(aiRes);
    })();
    const parsed = parseClusterJson(text);

    // 簡易検証 & フォールバック (topics 無い場合は頻出語トップ3)
    if (!parsed.trendingTopics.length) {
      const freq: Record<string, number> = {};
      for (const a of clusterTarget) {
        for (const w of a.title.split(/[^A-Za-z0-9一-龠ぁ-んァ-ン]+/).filter(Boolean)) {
          const k = w.toLowerCase();
          freq[k] = (freq[k] || 0) + 1;
        }
      }
      const top = Object.entries(freq)
        .filter(([k]) => k.length > 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([word], i) => ({
          topic: `頻出語:${word}`,
          reason: "頻出語頻度による暫定トピック",
          articles: clusterTarget.filter((a) => a.title.toLowerCase().includes(word)).slice(0, 5).map((a) => a.index),
          message: `${word} に関する報道集中`,
          support: ["頻度分析フォールバック"],
          significance: "暫定的示唆",
          citations: clusterTarget
            .filter((a) => a.title.toLowerCase().includes(word))
            .slice(0, 2)
            .map((a) => `${a.title}. ${a.source}. ${a.publishedAt?.slice(0, 10)}. ${a.url}`),
        }));
      parsed.trendingTopics = top;
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      totalFetched: mergedRaw.length,
      articlesUsedForClustering: clusterTarget.length,
      trendingTopics: parsed.trendingTopics,
      articles: clusterTarget,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: "トレンド抽出失敗", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
