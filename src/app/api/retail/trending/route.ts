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
// 話題性判定用キーワード（頻出ブランド/概念）
const TREND_KEYWORDS = [
  'ai','生成','omnichannel','オムニ','supply','chain','inflation','物価','price','価格','walmart','amazon','shopify','costco','target','tesla','logistics','物流','inventory','在庫','demand','需要','holiday','セール','sale','決算','earnings','expansion','出店','閉店','撤退','labor','雇用','strike','ストライキ','sustainability','サステナ','eco','脱炭素','digital','デジタル','loyalty','ロイヤルティ','membership','サブスク','subscription'
];

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

interface ScoredArticle extends Article { score: number }

function scoreArticles(articles: Article[]): ScoredArticle[] {
  const now = Date.now();
  // ソース出現数 (横断報道 = 話題性) を算出
  const srcFreq: Record<string, number> = {};
  for (const a of articles) {
    const s = a.source || 'unknown';
    srcFreq[s] = (srcFreq[s]||0)+1;
  }
  const maxSrcFreq = Math.max(1, ...Object.values(srcFreq));

  const keywordRegexes = TREND_KEYWORDS.map(k => new RegExp(`\\b${k.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')}\\b`,'i'));

  return articles.map(a => {
    const ageHours = (() => {
      const t = Date.parse(a.publishedAt || '') || now;
      return (now - t) / 36e5;
    })();
    const recency = 1 / (1 + ageHours / 12); // 12h で 0.5 目安
    const textForKw = (a.title + ' ' + a.description).toLowerCase();
    let kwHits = 0;
    for (const r of keywordRegexes) if (r.test(textForKw)) kwHits++;
    const keywordBoost = Math.min(kwHits, 6) * 0.15; // 上限 0.9
    const crossSource = (srcFreq[a.source] / maxSrcFreq) * 0.6; // 多ソース露出ほど +
    const descLen = (a.description || '').length;
    const lengthQuality = descLen > 300 ? 0.25 : descLen > 120 ? 0.15 : descLen > 60 ? 0.05 : 0;
    // 同義/重複っぽい短いタイトルはペナルティ
    const penalty = a.title.length < 25 ? 0.1 : 0;
    const score = +(recency + keywordBoost + crossSource + lengthQuality - penalty).toFixed(4);
    return { ...a, score };
  });
}

function buildClusterPrompt(articles: Article[]): string {
  const list = articles
    .map((a) => {
      const score = (a as unknown as { score?: number }).score;
      return `${a.index}. [score=${score ?? 'N/A'}] TITLE: ${a.title}\nSOURCE: ${a.source}\nPUBLISHED: ${a.publishedAt}\nDESC: ${(a.description || "").slice(0, 220)}`;
    })
    .join("\n\n");

  return `You are an expert retail industry trend analyst. Identify HIGH-VIRALITY topical clusters.\nWeighted Articles (index + score):\n${list}\n\nInstructions:\n- Use score to prioritize inclusion (higher score => more central).\n- Produce up to 8 clusters; each cluster MUST contain only clearly related articles.\n- Ignore outliers with very low semantic relation even if high score.\n- Prefer clusters with cross-source coverage (different sources).\nJSON ONLY. Schema:\n{\n  "trendingTopics": [ {\n    "topic": "短い日本語名",\n    "reason": "なぜ注目か(日本語1文)",\n    "articles": [1,2],\n    "message": "中心的動き(日本語1文)",\n    "support": ["具体的根拠1","具体的根拠2"],\n    "significance": "影響/示唆(日本語1文)",\n    "citations": ["Title. Source. YYYY-MM-DD. URL"]\n  } ]\n}\nRules:\n- articles は index 数字のみ。\n- support は最大3件。曖昧語(恐らく等)禁止。\n- citations は各 cluster 1~3 件。\n- トピック順 = 緊急性/広がり/構造転換性 の複合優先度。\n- 類似/重複トピックは統合。\nOutput JSON:`;
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

    // 話題性スコア計算
    const scored = scoreArticles(normalized);
    // スコア降順で並び替えし上位をクラスタ対象 (最大100)
    const clusterSource = scored.sort((a,b)=> b.score - a.score);
    const clusterTargetRaw = clusterSource.slice(0, 100);
    // 再インデックス（プロンプト内 index は 1..N 連番）
    const clusterTarget: Article[] = clusterTargetRaw.map((a,i) => ({
      title: a.title,
      description: a.description,
      url: a.url,
      source: a.source,
      publishedAt: a.publishedAt,
      index: i+1
    }));

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
      // スコア付き原本 (上位200 目安) も返す
      scoredArticles: clusterSource.slice(0, 200).map(a => ({
        title: a.title,
        description: a.description,
        url: a.url,
        source: a.source,
        publishedAt: a.publishedAt,
        score: a.score
      })),
      clusteredArticles: clusterTarget,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: "トレンド抽出失敗", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
