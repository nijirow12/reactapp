"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
// 言語選択削除に伴い Select関連は未使用のため除外
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Calendar, Globe, ExternalLink } from "lucide-react";

type Result = {
  articles: Array<{
    title: string;
    description: string;
    url: string;
    source: string;
    publishedAt: string;
    summaryBullets?: string[]; // [message, support, citation]
    extractedText?: string;
  }>;
};

export default function Home() {
  const [query, setQuery] = useState("AI");
  const [days, setDays] = useState(3);
  const [pageSize, setPageSize] = useState(10);
  const [preferDiverseSources, setPreferDiverseSources] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query, days, pageSize, preferDiverseSources }),
      });
      const json = await res.json();
      // クライアント側: 取得した記事と抽出全文を必ずコンソールに出力（開発/本番問わず）
      try {
        const articles = (json as Result).articles || [];
        console.log("[Client] Articles (with extractedText)", articles.map((a) => ({
          title: a.title,
          source: a.source,
          url: a.url,
          publishedAt: a.publishedAt,
          extractedText: a.extractedText ?? null,
          summaryBullets: Array.isArray((a as unknown as { summaryBullets?: unknown }).summaryBullets)
            ? (a as { summaryBullets?: string[] }).summaryBullets
            : null,
        })));
      } catch {}
      if (!res.ok) throw new Error(json?.error || "エラーが発生しました");
      setResult(json as Result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "不明なエラー";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-2">
            ニュース要約
          </h1>
          <p className="text-muted-foreground text-lg">
            NewsAPI + ChatGPTで興味のある分野の最新ニュースを要約
          </p>
        </div>

        {/* Search Form */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              検索条件
            </CardTitle>
            <CardDescription>
              興味のあるトピックを入力し、条件を設定してください
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="sm:col-span-2 lg:col-span-2">
                  <Label htmlFor="query">検索キーワード</Label>
                  <Input
                    id="query"
                    placeholder="例: 生成AI、半導体、気候変動"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    required
                    className="mt-1"
                  />
                </div>
                {/* 言語指定は削除（常に多言語記事→日本語要約） */}
                <div>
                  <Label htmlFor="days">期間（日）</Label>
                  <Input
                    id="days"
                    type="number"
                    min={1}
                    max={30}
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                    className="mt-1"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="diverse"
                  type="checkbox"
                  className="accent-primary size-4"
                  checked={preferDiverseSources}
                  onChange={(e) => setPreferDiverseSources(e.target.checked)}
                />
                <Label htmlFor="diverse">ソースの多様性を優先する</Label>
              </div>
              <div className="flex gap-4 items-end">
                <div className="flex-1">
                  <Label htmlFor="pageSize">取得件数</Label>
                  <Input
                    id="pageSize"
                    type="number"
                    min={1}
                    max={50}
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="mt-1"
                  />
                </div>
                <Button type="submit" disabled={loading} className="px-8">
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      要約中...
                    </>
                  ) : (
                    <>
                      <Search className="h-4 w-4" />
                      取得して要約
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Error Display */}
        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertDescription>エラー: {error}</AlertDescription>
          </Alert>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-6">
            {/* Articles Section (per-article summaries only) */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="h-5 w-5" />
                  取得した記事
                  <Badge variant="secondary" className="ml-auto">
                    {result.articles.length}件
                  </Badge>
                </CardTitle>
                <CardDescription>
                  過去{days}日間の関連記事
                </CardDescription>
              </CardHeader>
              <CardContent>
                {/* 簡易タイムライン（日付でグルーピング） */}
                {Object.entries(
                  result.articles.reduce<Record<string, typeof result.articles>>( (acc, a) => {
                    const d = new Date(a.publishedAt)
                      .toISOString()
                      .slice(0, 10)
                    acc[d] ||= []
                    acc[d].push(a)
                    return acc
                  }, {})
                ).sort(([a],[b]) => (a < b ? 1 : -1)).map(([date, items]) => (
                  <div key={date} className="mb-6">
                    <div className="font-medium text-sm text-muted-foreground mb-2">{date}</div>
                    <div className="space-y-4">
                      {items.map((article, i) => (
                    <div
                      key={i}
                      className="border rounded-lg p-4 hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium leading-tight mb-2">
                            <a
                              href={article.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-primary transition-colors line-clamp-2"
                            >
                              {article.title}
                            </a>
                          </h3>
                          {article.description && (
                            <p className="text-xs text-muted-foreground mb-3 line-clamp-3">
                              {article.description}
                            </p>
                          )}
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Globe className="h-3 w-3" />
                              {article.source}
                            </span>
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {new Date(article.publishedAt).toLocaleDateString('ja-JP')}
                            </span>
                          </div>
                          {article.summaryBullets && article.summaryBullets.length === 3 && (
                            <div className="mt-3 pt-2 border-t border-border/40 text-xs space-y-1">
                              <ul className="list-disc pl-5 space-y-1">
                                <li><span className="font-semibold">メッセージ:</span> {article.summaryBullets[0]}</li>
                                <li><span className="font-semibold">根拠:</span> {article.summaryBullets[1]}</li>
                                <li><span className="font-semibold">引用:</span> <span className="break-all">{article.summaryBullets[2]}</span></li>
                              </ul>
                            </div>
                          )}
                        </div>
                        <Button variant="outline" size="sm" asChild>
                          <a
                            href={article.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </Button>
                      </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
