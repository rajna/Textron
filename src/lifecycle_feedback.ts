/**
 * Detects whether a user message contains an outcome signal that backward should learn from.
 *
 * Gate 1: 领域无关的通用反馈信号（评价/纠正/质问）+ 结果评价词
 * Gate 2: 星象/金融领域信号（保留作为强信号补充）
 * Gate 3: 简短但明确的纠正/批评（不受30字限制）
 *
 * 纯操作指令(改代码/修bug/重启服务)不含结果信号→阻断backward merge/delete。
 */
export function hasBackwardOutcomeSignal(message: string): boolean {
  const s = message.trim();
  if (s.length < 4) return false;
  // Generic short acknowledgments without outcome content
  if (/^(收到|OK|ok|好|知道了|继续|go|next|yes|no|done|start|开始|测试|test)\s*$/i.test(s)) return false;

  // Gate 1: 领域无关的通用反馈信号
  // A. 结果评价词（涨跌/对错/成败）
  if (/(涨了|跌了|上涨|下跌|收涨|收跌|正确|错误|对了|错了|不对|验证通过|验证失败|确认|否认|符合预期|不符预期|准确|不准|偏差|跑赢|跑输|胜|负|盈|亏|成功|失败|有效|无效|结果|实际|真实|收盘|涨幅|跌幅)/.test(s)) return true;

  // B. 纠正/质问模式 — "为什么没有X" "为什么会X" "为啥没有X" "X漏了" "X缺失"
  if (/(为什么没有|为什么会|为啥没有|为啥会|怎么没有|怎么会|漏了|缺少|缺失|忘了|忽略了|没触发|没生效|没反应|没产生|没生成|没更新|没新增|没保存|没执行|没通过|没成功|没有触发|没有生成|没有更新|没有新增|没有保存)/.test(s)) return true;

  // C. 批评/否定模式 — "不行" "不对" "有问题" "不应该" "不应该只有"
  if (/(不行|不对|有问题|不应该|不应该只有|不该只有|不合理|不正确|不好|不行|不能用|没法用|不工作|坏了|断了|卡了)/.test(s)) return true;

  // D. 明确反馈/纠正意图 — "你的回答" "你的XX" + 评价
  if (/(你的回答|你的回复|你的输出|你的结论|你的判断|你刚刚|你刚才|你这个).{0,10}(没有|不对|错了|有问题|不行|漏了|少了)/.test(s)) return true;

  // E. 反问式反馈 — "也就是X只能Y" "难道X" 等质疑句式
  if (/(也就是.{0,20}只能|难道.{0,10}就|这不就是|那不就是|这不等于|那不等于|XX都|全是|全都是|就只有|光有)/.test(s)) return true;

  // F. 直接批评/反馈关键词（短消息也能命中）
  if (/(批评|吐槽|不满|失望|不行|不能接受|不能这样|这样不行|有问题|怎么搞的|什么情况|搞什么)/.test(s)) return true;

  // Gate 2: 星象/金融领域信号（保留作为强信号补充，保持对预测任务反馈的敏感度）
  const astroFinanceSignal = /(月冲|月刑|月合|月拱|月六合|日冲|日刑|日合|盘中正相|盘中负相|相位|合相|刑相|冲相|拱相|六合|对冲|逆行|顺行|换座|新月|满月|星象|上证|深证|A股|放量|缩量|支撑|压力|突破|跌破|回踩|反弹|反转|涨停|跌停|预测|准确率|胜率|均线|MACD|KDJ)/;
  if (astroFinanceSignal.test(s)) return true;

  // Gate 3: 较长消息（≥15字）含反馈意图词
  if (s.length >= 15 && /(反馈|评价|评判|判断|打分|评分|审查|复盘|回顾|总结|结论|应该|不应该|建议|改进|修正|修复|纠正|优化|调整|换成|改成|换成|最好是|可以考虑|试一下|试下|试过|试了)/.test(s)) return true;

  return false;
}
