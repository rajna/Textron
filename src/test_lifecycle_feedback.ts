import { hasBackwardOutcomeSignal } from "./lifecycle_feedback.ts";

declare const process: { exit(code?: number): never };

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean) {
  if (condition) { passed++; console.log(`  OK ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

console.log("lifecycle_feedback tests\n");

// Outcome signal detection
ok("1: detects outcome signal in prediction feedback", hasBackwardOutcomeSignal("预测涨，实际跌 -1.85%，未命中"));
ok("2: detects outcome signal in result feedback", hasBackwardOutcomeSignal("实际收盘3864，变动+1.79%，命中了"));
ok("3: rejects short acknowledgment", !hasBackwardOutcomeSignal("收到"));
ok("4: rejects empty", !hasBackwardOutcomeSignal(""));
ok("5: rejects single char", !hasBackwardOutcomeSignal("好"));
ok("6: accepts long message", hasBackwardOutcomeSignal("这是一个很长的消息包含了足够的字符来通过门控检测"));
ok("7: rejects very short message (< 8 chars)", !hasBackwardOutcomeSignal("abc"));

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
