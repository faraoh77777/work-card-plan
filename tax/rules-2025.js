/*
 * 규칙팩 2025 귀속 (연말정산 카드공제 계산기)
 * - 구조는 JSON과 같고, file:// 환경에서 fetch가 막혀 UMD 스크립트로 둔다(02_개발지시 v1.4).
 * - 모든 수치의 출처는 아래 sources 맵에 "안내 p.N"(국세청 「2025년 귀속 연말정산 세액계산 및 지급명세서 제출 방법 안내」
 *   인쇄 쪽번호, PDF 쪽 = 인쇄 쪽 + 3) 또는 조문으로 기록한다. 상세는 rules/SOURCES.md.
 * - 값이 null이면 엔진은 그 항목을 "확인 필요"로 표시하고 확정 계산에 쓰지 않는다.
 * - confidence: "GUIDE"(안내 PDF 대조) / "LAW"(조문, 안내 미수록) / "UNVERIFIED"(공단 공표값, 사용자 재확인 필요)
 */
(function (root, factory) {
  var pack = factory();
  if (typeof module === 'object' && module.exports) module.exports = pack;
  root.TaxRules = root.TaxRules || {};
  root.TaxRules[pack.year] = pack;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
    year: 2025,
    version: '2025.v1.0',
    verificationLevel: 'LAW_CHECKED',
    verificationNote: '국세청 안내(2025 귀속) 대조 완료. 카드공제 모듈은 안내 p.42 공식 사례와 단계별 일치(TC-006B). 전체 세액(TC-009)은 공식 사례 미확보로 LAW_CHECKED 유지.',
    verifiedAt: '2026-10-16',
    sourceUrls: [
      'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=238938&mi=2304',
      'https://www.law.go.kr/'
    ],
    effectiveFrom: '2025-01-01',
    effectiveTo: '2025-12-31',

    rounding: {
      wonFloorEachStep: true,
      note: '지급명세서 작성 방법 2: 소수점 이하 값은 버림. 각 단계 금액은 원 미만 버림.'
    },

    localIncomeTax: { rate: 0.10 },

    earnedIncomeDeduction: {
      cap: 20000000,
      brackets: [
        { upTo: 5000000, base: 0, rate: 0.70, over: 0 },
        { upTo: 15000000, base: 3500000, rate: 0.40, over: 5000000 },
        { upTo: 45000000, base: 7500000, rate: 0.15, over: 15000000 },
        { upTo: 100000000, base: 12000000, rate: 0.05, over: 45000000 },
        { upTo: null, base: 14750000, rate: 0.02, over: 100000000 }
      ]
    },

    taxBrackets: [
      { upTo: 14000000, rate: 0.06, progressive: 0 },
      { upTo: 50000000, rate: 0.15, progressive: 1260000 },
      { upTo: 88000000, rate: 0.24, progressive: 5760000 },
      { upTo: 150000000, rate: 0.35, progressive: 15440000 },
      { upTo: 300000000, rate: 0.38, progressive: 19940000 },
      { upTo: 500000000, rate: 0.40, progressive: 25940000 },
      { upTo: 1000000000, rate: 0.42, progressive: 35940000 },
      { upTo: null, rate: 0.45, progressive: 65940000 }
    ],

    earnedIncomeTaxCredit: {
      threshold: 1300000,
      rateBelow: 0.55,
      baseAbove: 715000,
      rateAbove: 0.30,
      limitTiers: [
        { grossUpTo: 33000000, limit: 740000 },
        { grossUpTo: 70000000, limit: 740000, minusRate: 0.008, minusFrom: 33000000, floor: 660000 },
        { grossUpTo: 120000000, limit: 660000, minusRate: 0.5, minusFrom: 70000000, floor: 500000 },
        { grossUpTo: null, limit: 500000, minusRate: 0.5, minusFrom: 120000000, floor: 200000 }
      ]
    },

    standardTaxCredit: { amount: 130000 },

    personal: {
      basic: 1500000,
      senior: 1000000, seniorAge: 70,
      disabled: 2000000,
      woman: 500000, womanIncomeCap: 30000000,
      singleParent: 1000000,
      priority: 'SINGLE_PARENT_OVER_WOMAN',
      incomeLimit: 1000000, incomeLimitGrossOnly: 5000000,
      ageRules: {
        SPOUSE: null,
        LINEAL_ASCENDANT: { minAge: 60 },
        LINEAL_DESCENDANT: { maxAge: 20 },
        SIBLING: { maxAge: 20, orMinAge: 60 },
        FOSTER_CHILD: null,
        WELFARE_RECIPIENT: null,
        OTHER: 'NOT_ELIGIBLE'
      },
      disabledIgnoresAge: true,
      ascendantCohabitNotRequired: true,
      cardAggregation: { relations: ['SPOUSE', 'LINEAL_ASCENDANT', 'LINEAL_DESCENDANT'], ageLimit: null, incomeRequired: true }
    },

    childTaxCredit: {
      minAge: 8,
      relations: ['LINEAL_DESCENDANT', 'FOSTER_CHILD'],
      amounts: { one: 250000, two: 550000, threePlusBase: 550000, threePlusEach: 400000 },
      birthAdoption: { first: 300000, second: 500000, thirdPlus: 700000 }
    },

    marriageCredit: { amount: 500000, yearsFrom: 2024, yearsTo: 2026, oncePerLife: true },

    smeReduction: {
      annualCap: 2000000,
      categories: {
        YOUTH: { rate: 0.90, years: 5, ageMin: 15, ageMax: 34 },
        SENIOR: { rate: 0.70, years: 3, ageMin: 60 },
        DISABLED: { rate: 0.70, years: 3 },
        CAREER_BREAK: { rate: 0.70, years: 3 }
      },
      employmentWindow: { from: '2012-01-01', to: '2026-12-31' }
    },

    card: {
      minUseRate: 0.25,
      rates: {
        CREDIT: 0.15, DEBIT: 0.30, CASH_RECEIPT: 0.30, CASH_NONE: 0,
        CULTURE: 0.30, SPORTS_FACILITY: 0.30, TRADITIONAL_MARKET: 0.40, PUBLIC_TRANSIT: 0.40
      },
      cultureGrossCap: 70000000,
      sportsFacilityFrom: '2025-07-01',
      limitTiers: [
        { grossUpTo: 70000000, basic: 3000000, extra: 3000000 },
        { grossUpTo: null, basic: 2500000, extra: 2000000 }
      ],
      deductionOrder: ['A_CREDIT', 'B_DEBIT_CASH_C_CULTURE', 'D_MARKET_E_TRANSIT'],
      childLimitBonus: null,
      childLimitBonusNote: '2025 귀속 없음(2026년 지출분부터 도입 예정, 2026 팩에서 조문 확인)',
      consumptionIncreaseBonus: null,
      consumptionIncreaseNote: '2025 귀속 없음(안내에 산식 없음)',
      usedCarInclusionRate: 0.10,
      excludedCategories: ['세금·공과금', '보험료', '통신비', '아파트관리비', '대출 상환', '대학등록금', '상품권', '면세점', '해외사용', '신차 구입', '월세 세액공제를 받는 월세 현금영수증'],
      aggregationNote: '본인, 배우자 및 생계를 같이하는 직계존비속(나이제한 없음, 소득요건 있음) 사용액 합산 가능. 앱 기본은 분리 집계(사용자 결정).'
    },

    overallDeductionCap: {
      amount: 25000000,
      items: ['주택자금공제', '주택마련저축', '소기업·소상공인 공제부금', '투자조합출자등', '신용카드등 사용금액', '우리사주조합출연금', '장기집합투자증권저축']
    },

    housing: {
      subscription: { rate: 0.40, annualPayCap: 3000000, grossCap: 70000000, requires: '무주택 세대주(또는 배우자)' },
      rentLoan: { rate: 0.40, combinedCapWithSubscription: 4000000, requires: '무주택 세대주, 국민주택규모' },
      mortgageInterest: {
        capOptions: [
          { key: 'GE15_FIXED_NONDEFER', label: '15년 이상·고정금리·비거치식', cap: 20000000 },
          { key: 'GE15_FIXED_OR_NONDEFER', label: '15년 이상·고정금리 또는 비거치식', cap: 18000000 },
          { key: 'GE15_OTHER', label: '15년 이상·기타', cap: 8000000 },
          { key: 'GE10_FIXED_OR_NONDEFER', label: '10년 이상·고정금리 또는 비거치식', cap: 6000000 }
        ],
        requires: '무주택 또는 1주택 세대주, 취득 당시 기준시가 6억원 이하'
      }
    },

    insurance: { rate: 0.12, cap: 1000000, disabledRate: 0.15, disabledCap: 1000000 },

    medical: {
      thresholdRate: 0.03,
      rate: 0.15,
      infertilityRate: 0.30,
      prematureRate: 0.20,
      generalCap: 7000000,
      unlimitedGroups: ['본인', '65세 이상', '6세 이하', '장애인', '건강보험 산정특례자', '난임시술', '미숙아·선천성이상아'],
      glassesCapPerPerson: 500000,
      postnatalCapPerBirth: 2000000,
      excluded: ['미용·성형수술', '건강증진 의약품', '실손보험금 보전분']
    },

    education: {
      rate: 0.15,
      caps: { PRESCHOOL: 3000000, SCHOOL: 3000000, UNIVERSITY: 9000000, SELF: null, DISABLED_SPECIAL: null },
      uniformCap: 500000, fieldTripCap: 300000,
      notAllowed: ['초·중·고 학원비', '직계존속 교육비']
    },

    donation: {
      political: { lowCap: 100000, lowRatio: 100 / 110, midRate: 0.15, midUpTo: 30000000, highRate: 0.25 },
      hometown: { lowCap: 100000, lowRatio: 100 / 110, rate: 0.15, disasterRate: 0.30, annualCap: 20000000 },
      special: { lowRate: 0.15, lowUpTo: 10000000, highRate: 0.30, incomeCapRate: 1.0 },
      general: { lowRate: 0.15, lowUpTo: 10000000, highRate: 0.30, incomeCapRate: 0.30 },
      religious: { lowRate: 0.15, lowUpTo: 10000000, highRate: 0.30, incomeCapRate: 0.10 },
      highDonationBonusRemoved: true
    },

    pensionAccount: {
      savingCap: 6000000, totalCap: 9000000,
      rateLow: 0.15, rateHigh: 0.12, grossThreshold: 55000000,
      isaConversion: { rate: 0.10, cap: 3000000 }
    },

    rent: { rate: 0.15, lowRate: 0.17, lowGrossCap: 55000000, rentCap: 10000000, grossCap: 80000000, requires: '무주택 세대주, 국민주택규모 또는 기준시가 4억원 이하' },

    creditOrder: [
      'SME_REDUCTION', 'EARNED_INCOME', 'MARRIAGE', 'CHILD', 'INSURANCE', 'MEDICAL', 'EDUCATION',
      'POLITICAL', 'HOMETOWN', 'STANDARD', 'TAX_ASSOCIATION', 'HOUSING_LOAN_INTEREST_95', 'RENT',
      'DONATION_SPECIAL_GENERAL', 'FOREIGN', 'PENSION_ACCOUNT'
    ],

    premiums: {
      confidence: 'UNVERIFIED',
      note: '공단 공표 요율(국민연금공단·건강보험공단·고용노동부). 안내 PDF에 없어 사용자 재확인 필요. 추정값은 급여명세서와 다를 수 있음(국민연금 기준소득월액은 전년 소득 기준).',
      base: 'TAXABLE_GROSS',
      periods: [
        {
          effectiveFrom: '2025-01',
          nationalPension: { rate: 0.045, baseMin: 390000, baseMax: 6170000 },
          healthInsurance: { rate: 0.03545 },
          longTermCare: { rateOfHealth: 0.1295 },
          employmentInsurance: { rate: 0.009 }
        },
        {
          effectiveFrom: '2025-07',
          nationalPension: { rate: 0.045, baseMin: 400000, baseMax: 6370000 },
          healthInsurance: { rate: 0.03545 },
          longTermCare: { rateOfHealth: 0.1295 },
          employmentInsurance: { rate: 0.009 }
        }
      ],
      rounding: 'WON_FLOOR'
    },

    sources: {
      'earnedIncomeDeduction': '소득세법 §47(한도 2천만원) · 안내 종교인소득 비교표(총급여 5,000만원 → 1,225만원)',
      'taxBrackets': '소득세법 §55①(안내 PDF 미수록, 조문 확인)',
      'earnedIncomeTaxCredit': '안내 p.30 · 소득세법 §59',
      'standardTaxCredit': '안내 p.32 · 소득세법 §59의4⑨',
      'personal': '안내 p.26 · 소득세법 §50·§51',
      'childTaxCredit': '안내 p.5·p.30 · 소득세법 §59의2',
      'marriageCredit': '안내 p.30',
      'smeReduction': '안내 p.29 · 조특법 §30',
      'card': '안내 p.28(공제율·한도표)·p.41(산식)·p.42(사례) · 조특법 §126의2',
      'overallDeductionCap': '안내 p.29 · 조특법 §132의2',
      'housing': '안내 p.27~28',
      'insurance': '안내 p.31',
      'medical': '안내 p.31',
      'education': '안내 p.31',
      'donation': '안내 p.32~33',
      'pensionAccount': '안내 p.30',
      'rent': '안내 p.32',
      'creditOrder': '안내 p.33 · 소득세법 §60·§61',
      'localIncomeTax': '지방세법 §103의3',
      'premiums': '국민연금공단·건강보험공단·고용노동부 공표(미대조, 확인 필요)',
      'rounding': '지급명세서 작성 방법 2(소수점 이하 버림)'
    }
  };
});
