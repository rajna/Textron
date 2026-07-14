import * as path from "node:path";
import { readNodeContent, readNodeName, writeNodeHtml, compressNodeName } from "./storage";
import { addPolicyNode } from "./policy";
import { clamp } from "./utils";
import type { LoadedNetwork } from "./network";

// ─── Textron Feedback Detection ───────────────────────────────────────

export async function evaluateUserFeedback(userMessage: string, ctx?: { apiKey?: string; baseUrl?: string; model?: string }): Promise<{ sentiment: 'success' | 'failure' | 'neutral'; insight?: string }> {
  const endpoint = ctx?.baseUrl || process.env.TEXTRON_EVAL_ENDPOINT || 'http://localhost:11434/v1/chat/completions';
  const model = ctx?.model || process.env.TEXTRON_EVAL_MODEL || await detectSmallestModel() || '';
  if (!model) return { sentiment: keywordFallback(userMessage) };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'system',
          content: '分析用户消息。1) 判断是对助手上一轮回答的正面/负面/中性回应。2) 如有改进建议或纠正，提炼≤80字关键要点。返回JSON: {"sentiment":"success|failure|neutral","insight":"要点或null"}'
        }, {
          role: 'user',
          content: `用户消息: "${userMessage.slice(0, 3000)}"`
        }],
        max_tokens: 150,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const raw: string = data?.choices?.[0]?.message?.content || '';
    try {
      const parsed = JSON.parse(raw);
      return {
        sentiment: parsed.sentiment || 'neutral',
        insight: parsed.insight && parsed.insight !== 'null' ? parsed.insight : undefined,
      };
    } catch {
      const lower = raw.toLowerCase();
      if (lower.includes('failure') || lower.includes('负面')) return { sentiment: 'failure' };
      if (lower.includes('success') || lower.includes('正面')) return { sentiment: 'success' };
      return { sentiment: 'neutral' };
    }
  } catch {
    return { sentiment: keywordFallback(userMessage) };
  }
}

export async function detectSmallestModel(): Promise<string | null> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const models: { name: string; size: number }[] = data?.models || [];
    if (models.length === 0) return null;
    models.sort((a, b) => a.size - b.size);
    return models[0].name;
  } catch { return null; }
}

export function keywordFallback(userMessage: string): 'success' | 'failure' | 'neutral' {
  const msg = userMessage.toLowerCase();
  // Negation pattern: 不 + positive word = negative. Must check BEFORE success.
  if (/不[好行对像样够理想]|太差|太烂|太糟|[没無]有?做好|[没無]用|fail|wrong|incorrect|don't|shouldn't|cannot|can't|badly|poorly/.test(msg)) return 'failure';
  // More aggressive failure: explicit negative words
  if (/不对|不是|错了|修正|不应该|错误|不行|不像|不好|不完?整|不连贯|混乱|糟糕|失败|垃圾|难听|不自然|不流畅|僵硬|生硬/.test(msg)) return 'failure';
  // Success: positive feedback (only match standalone positive words, not negated ones)
  if (/(?:^|[\s，。！？、\-—\(\)])好(?:[\s，。！？、\-—\(\)]|$)|很好|太棒|不错|厉害|完美|great|awesome|excellent|amazing|perfect/.test(msg)) return 'success';
  if (/对|继续|是的|good|thanks|correct|exactly|love it|well done/.test(msg)) return 'success';
  return 'neutral';
}

export function storeFailureKnowledge(
  net: LoadedNetwork,
  activatedIds: string[],
  userMessage: string,
  onLog: (msg: string) => void,
) {
  // Compress user's correction to ~100 chars as high-entropy insight
  const insight = userMessage.length > 100 ? userMessage.slice(0, 97) + '...' : userMessage;
  // Try to fill an empty node in a non-output layer first
  for (let l = 0; l < net.hyperparams.layers.length - 1; l++) {
    for (let n = 0; n < net.hyperparams.layers[l]; n++) {
      const np = path.join(net.path, `layer_${l}`, `node_${n}.html`);
      if (!readNodeContent(np)) {
        const outEdges = (net.weights.layer_connections[`${l}_to_${l + 1}`] || [])
          .filter(e => e.from === `node_${n}`).map(e => ({ toId: e.to, weight: e.weight }));
        writeNodeHtml(np, l, `node_${n}`, insight, outEdges, compressNodeName(insight));
        onLog(`Textron: stored failure insight in L${l}::node_${n}`);
        return;
      }
    }
  }
  // All non-output nodes filled — add dynamic node to layer 0
  addPolicyNode(net, undefined, insight, onLog, compressNodeName(insight));
}
