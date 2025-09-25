// 業界 -> 検索語 (NewsAPI q 用 OR 連結) の簡易マッピング
// 文字数を抑えるため代表語 + 主要企業/概念をいくつかに限定
// 必要に応じて拡張可能
export const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  "AI": ["AI", "人工知能", "machine learning", "生成AI", "LLM"],
  "半導体": ["半導体", "semiconductor", "chip", "TSMC", "NVIDIA", "ASML"],
  "自動車": ["自動車", "automotive", "EV", "電気自動車", "Tesla", "トヨタ"],
  "金融": ["金融", "finance", "bank", "fintech", "証券"],
  "ヘルスケア": ["ヘルスケア", "healthcare", "医療", "pharma", "製薬"],
  "エネルギー": ["エネルギー", "energy", "renewable", "再生可能エネルギー", "脱炭素"],
  "小売": ["小売", "retail", "e-commerce", "EC", "supply chain"],
  "通信": ["通信", "telecom", "5G", "モバイル通信"],
  "宇宙・防衛": ["宇宙", "space", "satellite", "defense", "衛星"],
  "サイバーセキュリティ": ["サイバーセキュリティ", "cybersecurity", "情報セキュリティ", "脆弱性"],
  "クラウド": ["クラウド", "cloud", "SaaS", "IaaS", "data center"],
  "ゲーム": ["ゲーム", "gaming", "video game", "e-sports"],
};

// 業界キーから NewsAPI 用クエリ文字列を組み立て
export function buildIndustryQuery(industry: string): string | null {
  const terms = INDUSTRY_KEYWORDS[industry];
  if (!terms) return null;
  // NewsAPI は OR で括弧利用可能 (シンプルなブール)。語にスペース含む場合は引用符で囲む
  const orExpr = terms
    .map((t) => {
      const trimmed = t.trim();
      if (!trimmed) return null;
      return /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
    })
    .filter(Boolean)
    .join(" OR ");
  return `(${orExpr})`;
}
