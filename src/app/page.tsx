"use client";
import { useState } from "react";

type Result = {
  summary: string;
  articles: Array<{
    title: string;
    description: string;
    url: string;
    source: string;
    publishedAt: string;
  }>;
};

export default function Home() {
  const [query, setQuery] = useState("AI");
  const [language, setLanguage] = useState("ja");
  const [days, setDays] = useState(3);
  const [pageSize, setPageSize] = useState(10);
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
        body: JSON.stringify({ query, language, days, pageSize }),
      });
      const json = await res.json();
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
    <div className="min-h-screen p-6 sm:p-10 max-w-5xl mx-auto">
      <h1 className="text-2xl sm:text-3xl font-bold mb-4">ニュース要約（NewsAPI + ChatGPT）</h1>
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-6 mb-6">
        <input
          className="sm:col-span-3 border rounded px-3 py-2 bg-background text-foreground"
          placeholder="興味のあるトピック（例: 生成AI、半導体、気候変動）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          required
        />
        <select
          className="sm:col-span-1 border rounded px-3 py-2 bg-background text-foreground"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="ja">日本語</option>
          <option value="en">English</option>
        </select>
        <input
          type="number"
          min={1}
          max={30}
          className="sm:col-span-1 border rounded px-3 py-2 bg-background text-foreground"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          title="過去何日分を対象にするか"
        />
        <input
          type="number"
          min={1}
          max={50}
          className="sm:col-span-1 border rounded px-3 py-2 bg-background text-foreground"
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          title="取得件数"
        />
        <button
          type="submit"
          className="sm:col-span-6 bg-foreground text-background rounded px-4 py-2 disabled:opacity-60"
          disabled={loading}
        >
          {loading ? "要約中…" : "取得して要約"}
        </button>
      </form>

      {error && (
        <div className="text-red-600 mb-4">エラー: {error}</div>
      )}

      {result && (
        <div className="grid gap-6">
          <section>
            <h2 className="text-xl font-semibold mb-2">要約</h2>
            <div className="prose whitespace-pre-wrap text-sm sm:text-base">
              {result.summary || "（サマリーが空です）"}
            </div>
          </section>
          <section>
            <h2 className="text-xl font-semibold mb-2">取得した記事</h2>
            <ul className="space-y-3">
              {result.articles.map((a, i) => (
                <li key={i} className="border rounded p-3">
                  <a
                    className="font-medium hover:underline"
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {a.title}
                  </a>
                  <div className="text-xs opacity-70 mt-1">
                    {a.source} ・ {new Date(a.publishedAt).toLocaleString()}
                  </div>
                  {a.description && (
                    <p className="text-sm mt-2">{a.description}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
