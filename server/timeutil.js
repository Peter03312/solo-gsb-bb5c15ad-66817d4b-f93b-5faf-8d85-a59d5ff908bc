'use strict';
// 事件时间的统一比较口径：按“实际时刻”判定。
//
// 系统接受两种本地 ISO 写法（均无时区，同构可比）：
//   - 分钟写法  YYYY-MM-DDTHH:MM     如 2026-10-01T09:00
//   - 带秒写法  YYYY-MM-DDTHH:MM:SS  如 2026-10-01T09:00:00
// 二者可表示同一实际时刻（上例即同刻）。此前校验直接按原始文本比较，
// 会把同刻的两种写法误判为不同时刻（同设备冲突漏判），或把同刻引用
// 误判为“严格更早”（引用先后误判）。本模块统一补足到含秒形式再比较，
// 使分钟写法与带秒写法在任何判定中都按实际时刻等价。
//
// 注意：仅用于比较；事件时间的存储与展示一律保留用户提交的原始文本。

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// 统一为含秒的形式：分钟写法补 ":00"，带秒写法原样返回。
// 补足后的字符串比较（字典序）等价于实际时刻比较。
function normTime(t) {
  const s = String(t);
  return s.length === 16 ? `${s}:00` : s;
}

// 两个时间文本是否表示同一实际时刻。
function sameInstant(a, b) {
  return normTime(a) === normTime(b);
}

// 按实际时刻比较：a 早于 b 返回 -1，同刻返回 0，a 晚于 b 返回 1。
function cmpTime(a, b) {
  const x = normTime(a);
  const y = normTime(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

module.exports = { TIME_RE, normTime, sameInstant, cmpTime };
