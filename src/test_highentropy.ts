declare const process: { exit(code?: number): never };

import { extractHighEntropy, extractLatestHighEntropyFromMessages } from "./highentropy.ts";

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  OK ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function testMultilineNameContentXml() {
  const xml = `<HighEntropy>
Name: TextronE2E证据链
Content: Textron E2E validation requires observable external task, provider payload marker, backward event, node writeback, and next-turn relevance evidence.
</HighEntropy>`;
  const extracted = extractHighEntropy(xml);
  ok("captures standard multiline HighEntropy XML", extracted.includes("Name: TextronE2E证据链"), extracted);
  ok("captures multiline Content field", extracted.includes("Content: Textron E2E validation requires observable external task"), extracted);
  ok("does not merge Content into Name", !extracted.includes("Name: TextronE2E证据链 Content:"), extracted);
}

function testJsonXml() {
  const xml = `<HighEntropy>{"name":"Textron E2E validation","content":"Textron E2E validation should verify provider payload marker, semantic backward reward, manual writeback event, node persistence, and next-turn retrieval."}</HighEntropy>`;
  const extracted = extractHighEntropy(xml);
  ok("captures JSON HighEntropy XML", extracted.includes("Name: Textron E2E validation"), extracted);
  ok("captures JSON content", extracted.includes("manual writeback event"), extracted);
}

function testGenericNameReplacedByKeywordDistill() {
  // Regression: LLM gave a generic summary name sharing zero content keywords —
  // must be replaced by distilled high-entropy terms from the content itself.
  const xml = `<HighEntropy>
Name: 语法检查不等于可运行
Content: 交付可玩程序前必须跑运行时冒烟测试:node --check只验语法,缺函数drawMinimap和实体缺col字段这类错误只有模拟真实流程帧循环才能暴露;stub DOM/Canvas可低成本覆盖全代码路径。
</HighEntropy>`;
  const extracted = extractHighEntropy(xml);
  const nameLine = extracted.split("\n")[0] || "";
  ok("crystal accepted", extracted.length > 0, extracted);
  ok("generic name replaced (no 不等于)", !nameLine.includes("不等于"), nameLine);
  ok("distilled name carries high-entropy identifier drawMinimap", nameLine.includes("drawMinimap"), nameLine);
  ok("distilled name carries domain signal 冒烟测试", nameLine.includes("冒烟测试"), nameLine);
}

function testKeywordSharingNamePreserved() {
  // A name built from content keywords must survive the overlap guard.
  const xml = `<HighEntropy>
Name: 运行时冒烟测试 drawMinimap stub DOM
Content: 交付可玩程序前必须跑运行时冒烟测试:node --check只验语法,缺函数drawMinimap和实体缺col字段这类错误只有模拟真实流程帧循环才能暴露;stub DOM/Canvas可低成本覆盖全代码路径。
</HighEntropy>`;
  const extracted = extractHighEntropy(xml);
  ok("keyword-built name preserved", (extracted.split("\n")[0] || "").includes("Name: 运行时冒烟测试 drawMinimap stub DOM"), extracted);
}

function testChineseNoPunctuationCrystal() {
  const xml = `<HighEntropy>
Name: 星象量化因果门控
Content: 星象预测股市必须记录可验证因果链与回测边界；无价格数据或统计检验时只能作为假设特征，不能当交易结论
</HighEntropy>`;
  const extracted = extractHighEntropy(xml);
  ok("captures Chinese HighEntropy without final punctuation", extracted.includes("星象预测股市必须记录可验证因果链"), extracted);
  ok("does not reject Chinese crystal as low word entropy", extracted.length > 0, extracted);
}

function testAgentEndMessagesFallback() {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "处理中，不含最终晶体" }] },
    { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
    { role: "assistant", content: [{ type: "text", text: `完成。\n<HighEntropy>\nName: AgentEnd最终兜底\nContent: agent_end必须从event.messages倒序提取最终assistant晶体；仅依赖流式buffer会因事件时序遗漏最终输出。\n</HighEntropy>` }] },
  ];
  const extracted = extractLatestHighEntropyFromMessages(messages);
  ok("agent_end messages capture final assistant HighEntropy", extracted.includes("Name: AgentEnd最终兜底"), extracted);
  ok("agent_end messages ignore intermediate assistant and tool results", !extracted.includes("处理中"), extracted);
}

console.log("highentropy tests\n");
testMultilineNameContentXml();
testJsonXml();
testGenericNameReplacedByKeywordDistill();
testKeywordSharingNamePreserved();
testChineseNoPunctuationCrystal();
testAgentEndMessagesFallback();

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
