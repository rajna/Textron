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
  ok("legacy Content maps to Technique", extracted.includes("Technique: Textron E2E validation requires observable external task"), extracted);
  ok("does not merge Content into Name", !extracted.includes("Name: TextronE2E证据链 Content:"), extracted);
}

function testJsonXml() {
  const xml = `<HighEntropy>{"name":"Textron E2E validation","content":"Textron E2E validation should verify provider payload marker, semantic backward reward, manual writeback event, node persistence, and next-turn retrieval."}</HighEntropy>`;
  const extracted = extractHighEntropy(xml);
  ok("captures JSON HighEntropy XML", extracted.includes("Name: Textron E2E validation"), extracted);
  ok("captures legacy JSON content as technique", extracted.includes("Technique: Textron E2E validation") && extracted.includes("manual writeback event"), extracted);
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

function testTaskTechniquePacket() {
  const technique = "先让执行代理只接收标的与日期并自行调用历史数据接口，结果接口由审计代理隔离持有；这样可减少重复上下文，同时必须在最终技巧包中保留实际使用的结构、因果条件和验证边界。" +
    "当工具结果不进入previousTask时，不能只写预测结论，应提炼关键K线形态、星象演化和置信度约束，使autoBackward仍能根据真实反馈更新相关节点。";
  const xml = `<HighEntropy>
Name: previousTask autoBackward 历史数据接口
Task: 在不泄漏目标日行情的前提下，降低主AI向coder重复转发K线与星象数据造成的token消耗。
Technique: ${technique}
</HighEntropy>`;
  const extracted = extractHighEntropy(xml);
  ok("captures Task field", extracted.includes("Task: 在不泄漏目标日行情的前提下"), extracted);
  ok("captures Technique field", extracted.includes("Technique: 先让执行代理只接收标的与日期"), extracted);
  ok("preserves technique beyond legacy 180-char limit", extracted.includes("autoBackward仍能根据真实反馈"), extracted);
}

function testTaskTechniqueLimits() {
  const longTask = "解决任务边界".repeat(30);
  const longTechnique = "因为条件变化所以采用验证门控并保留失败边界。".repeat(40);
  const xml = `<HighEntropy>\nName: 验证门控 失败边界\nTask: ${longTask}\nTechnique: ${longTechnique}\n</HighEntropy>`;
  const extracted = extractHighEntropy(xml);
  const task = extracted.match(/^Task: (.*)$/m)?.[1] || "";
  const technique = extracted.match(/^Technique: (.*)$/m)?.[1] || "";
  ok("Task is capped at 100 chars", task.length <= 100 && task.length > 0, `length=${task.length}`);
  ok("Technique is capped at 500 chars", technique.length <= 500 && technique.length > 180, `length=${technique.length}`);
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
testTaskTechniquePacket();
testTaskTechniqueLimits();
testAgentEndMessagesFallback();

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
