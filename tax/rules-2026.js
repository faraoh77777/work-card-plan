/*
 * 규칙팩 2026 귀속 — LAW_CHECKED 단계(공식 계산 사례 없음).
 * 2025 팩을 기준으로 2026 적용분 변경 후보만 표시하고, 확인되지 않은 값은 null + 사유로 둔다.
 * 엔진은 null 항목을 "확인 필요"로 표시하고 확정 계산에 쓰지 않는다.
 */
(function (root, factory) {
  var pack = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = pack;
  root.TaxRules = root.TaxRules || {};
  root.TaxRules[pack.year] = pack;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  var base;
  if (typeof module === 'object' && module.exports) base = require('./rules-2025.js');
  else base = (root.TaxRules && root.TaxRules[2025]) || null;
  if (!base) throw new Error('rules/2025.js must be loaded before rules/2026.js');

  var pack = JSON.parse(JSON.stringify(base));
  pack.year = 2026;
  pack.version = '2026.v0.1';
  pack.verificationLevel = 'LAW_CHECKED';
  pack.verificationNote = '2025 팩 값을 기준으로 함. 2026 귀속 개정 사항(카드 자녀 한도 가산, 자녀세액공제 나이 등)은 조문 확인 전까지 null(확인 필요).';
  pack.verifiedAt = '2026-10-16';
  pack.effectiveFrom = '2026-01-01';
  pack.effectiveTo = '2026-12-31';

  pack.card.childLimitBonus = null;
  pack.card.childLimitBonusNote = '2026년 지출분부터 기본공제대상 자녀당 한도 가산(보도 기준 7천만원 이하 50만원·최대 100만원, 초과 25만원·최대 50만원) — 조특법 §126의2 현행 조문 확인 전 null';
  pack.card.sportsFacilityFrom = '2025-07-01';

  pack.childTaxCredit.minAgeNote = '2026 팩 자녀세액공제 대상 나이 변경 여부(블로그 출처 9세) 확인 필요 — 확인 전 2025 값(8세) 유지, 화면에 확인 필요 표시';
  pack.childTaxCredit.minAgeUnverified = true;

  // 똑씀이: 2026 근로자 부담 요율(국민연금 9.5%의 절반 4.75%, 건강보험 7.19%의 절반 3.595%, 장기요양 건강보험료의 13.14%, 고용보험 0.9%).
  // 국민연금 기준소득월액 상·하한은 2025.7~2026.6 고시값(40만~637만원), 2026.7 이후 고시는 미반영. 급여명세서와 다를 수 있어 직접 입력으로 고칠 수 있습니다.
  pack.premiums = {
    confidence: 'UNVERIFIED',
    note: '2026 근로자 부담 요율 공표값(2026-10-28 확인, 공단 고시 원문 미대조). 국민연금 상·하한은 2025.7 고시값 유지.',
    base: 'TAXABLE_GROSS',
    periods: [
      {
        effectiveFrom: '2026-01',
        nationalPension: { rate: 0.0475, baseMin: 400000, baseMax: 6370000 },
        healthInsurance: { rate: 0.03595 },
        longTermCare: { rateOfHealth: 0.1314 },
        employmentInsurance: { rate: 0.009 }
      }
    ],
    rounding: 'WON_FLOOR'
  };

  pack.sources['card.childLimitBonus'] = '조특법 §126의2(2026 적용분) 확인 필요';
  pack.sources['premiums'] = '2026 요율 공표 보도(국민연금 9.5%·건강 7.19%·장기요양 13.14%·고용 1.8%), 공단 고시 원문 미대조';
  return pack;
});
