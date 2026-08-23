const EDGE_PUNCT = /^[.\-+#]+|[.\-+#]+$/g
const MEANINGFUL_INTERNAL_PUNCT = /[#+]/

export function tokenize(text: string): string[] {
  const raw = text.toLocaleLowerCase().match(/[\p{L}\p{N}_+#.-]+/gu) ?? []
  const result: string[] = []
  for (const token of raw) {
    const stripped = token.replace(EDGE_PUNCT, '')
    if (stripped) {
      result.push(stripped)
      if (stripped !== token && MEANINGFUL_INTERNAL_PUNCT.test(token)) result.push(token)
    } else if (token) {
      result.push(token)
    }
  }
  return result
}

export function bm25Scores(query: string, corpus: string[]): number[] {
  const k1 = 1.5, b = 0.75
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0 || corpus.length === 0) return corpus.map(() => 0)
  const docTokens = corpus.map((text) => tokenize(text))
  const docFreq = new Map<string, number>()
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
  }
  const N = corpus.length
  const avgDl = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / N
  return docTokens.map((tokens) => {
    const tf = new Map<string, number>()
    for (const term of tokens) tf.set(term, (tf.get(term) ?? 0) + 1)
    const dl = tokens.length
    let score = 0
    for (const term of queryTerms) {
      const df = docFreq.get(term) ?? 0
      if (df === 0) continue
      const f = tf.get(term) ?? 0
      if (f === 0) continue
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgDl))
    }
    return score
  })
}
