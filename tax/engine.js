/*
 * engine.js — 세액·공제 계산 엔진 (REQ-006/009/013/015). 순수 함수, DOM 비의존.
 * 모든 요율·한도는 rulePack에서만 읽는다. null 규칙은 "확인 필요"로 표시하고 확정 계산에 쓰지 않는다.
 */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  root.TaxEngine = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var floor = Math.floor;
  function fl(x) { return floor(x + 1e-9); }
  function ceilTo(x, unit) { return Math.ceil((x - 1e-9) / unit) * unit; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function ymOf(date) { return (date || '').slice(0, 7); }
  function ymIndex(ym) { var p = ym.split('-'); return parseInt(p[0], 10) * 12 + parseInt(p[1], 10) - 1; }

  // ---------- 재직기간 ----------
  function employmentRange(profile) {
    var y = profile.year;
    var start = profile.employmentStart || (y + '-01-01');
    var end = profile.employmentEnd || (y + '-12-31');
    if (start < y + '-01-01') start = y + '-01-01';
    if (end > y + '-12-31') end = y + '-12-31';
    return { start: start, end: end, startYm: start.slice(0, 7), endYm: end.slice(0, 7) };
  }
  function inEmployment(date, range) { return date >= range.start && date <= range.end; }
  function monthsInRange(range) {
    var out = [];
    for (var i = ymIndex(range.startYm); i <= ymIndex(range.endYm); i++) {
      var yy = Math.floor(i / 12), mm = i % 12 + 1;
      out.push(yy + '-' + (mm < 10 ? '0' : '') + mm);
    }
    return out;
  }

  // ---------- 총급여 ----------
  function grossFromState(state) {
    var p = state.profile;
    var warnings = [], missing = [];
    var range = employmentRange(p);
    if (p.salaryForecastMode === 'MONTHLY') {
      var months = monthsInRange(range);
      var total = 0, actual = 0, forecast = 0, missingMonths = [];
      months.forEach(function (ym) {
        var m = state.payroll[ym];
        if (!m || typeof m.gross !== 'number') { missingMonths.push(ym); return; }
        var g = num(m.gross) - num(m.nonTaxable);
        if (g < 0) { warnings.push(ym + ' 비과세가 급여를 초과'); g = 0; }
        total += g;
        if (m.status === 'FORECAST') forecast += g; else actual += g;
      });
      if (missingMonths.length) warnings.push('미입력 월 ' + missingMonths.length + '개(' + missingMonths.join(', ') + ')는 0으로 계산되지 않고 경고만 표시');
      var entered = months.filter(function (ym) { return state.payroll[ym] && typeof state.payroll[ym].gross === 'number'; }).length;
      if (!months.length || entered === 0) missing.push('월별 급여');
      if (missing.length) return { gross: null, mode: 'MONTHLY', missingMonths: missingMonths, warnings: warnings, missing: missing, range: range };
      return { gross: total, actual: actual, forecast: forecast, mode: 'MONTHLY', missingMonths: missingMonths, warnings: warnings, missing: missing, range: range };
    }
    if (typeof p.expectedGrossAnnual !== 'number' || p.expectedGrossAnnual <= 0) {
      missing.push('예상 세전연봉');
      return { gross: null, mode: 'FIXED', warnings: warnings, missing: missing, range: range };
    }
    var nt = num(p.expectedNonTaxable);
    if (nt > p.expectedGrossAnnual) { missing.push('비과세가 연봉을 초과'); return { gross: null, mode: 'FIXED', warnings: warnings, missing: missing, range: range }; }
    return { gross: p.expectedGrossAnnual - nt, mode: 'FIXED', warnings: warnings, missing: missing, range: range };
  }

  // ---------- 가족 판정 (REQ-013) ----------
  function ageAtYearEnd(birthYear, year) { return typeof birthYear === 'number' ? year - birthYear : null; }

  function deriveFamilyFlags(member, profile, rules) {
    var year = profile.year;
    var pr = rules.personal;
    var age = ageAtYearEnd(member.birthYear, year);
    var out = {
      id: member.id, alias: member.alias, relation: member.relation, age: age,
      isBasicDeductionTarget: false, reasonBasic: '',
      isCardAggregationTarget: false, reasonCard: '',
      isSenior: false, isDisabled: !!member.disability,
      isChildTaxCreditTarget: false, birthAdoptionCreditAmount: 0,
      needsConfirmation: false, confirmReasons: []
    };
    var rel = member.relation;
    if (rel === 'OTHER' || !rel) { out.reasonBasic = '관계 "기타"는 기본공제 대상 아님'; out.reasonCard = '합산 대상 아님'; return out; }
    if (member.incomeUnderLimit !== true && member.incomeUnderLimit !== false) {
      out.needsConfirmation = true; out.confirmReasons.push('연소득 요건 미입력');
    }
    var ageRule = pr.ageRules[rel];
    var ageOk = true, ageReason = '';
    if (ageRule === 'NOT_ELIGIBLE') { ageOk = false; ageReason = '대상 관계 아님'; }
    else if (ageRule && !(member.disability && pr.disabledIgnoresAge)) {
      if (age === null) { out.needsConfirmation = true; out.confirmReasons.push('생년 미입력'); ageOk = false; ageReason = '생년 미입력'; }
      else {
        var okMin = ageRule.minAge ? age >= ageRule.minAge : true;
        var okMax = ageRule.maxAge ? age <= ageRule.maxAge : true;
        var okOr = ageRule.orMinAge ? age >= ageRule.orMinAge : false;
        ageOk = (ageRule.minAge && ageRule.maxAge) ? (okMin && okMax) : (ageRule.minAge ? okMin : (ageRule.maxAge ? (okMax || okOr) : true));
        if (!ageOk) ageReason = '나이 요건 불충족(' + age + '세)';
      }
    } else if (ageRule && member.disability) { ageReason = '장애인: 나이 요건 면제'; }

    var incomeOk = member.incomeUnderLimit === true;
    if (!out.needsConfirmation || (member.incomeUnderLimit === false)) {
      if (!incomeOk) out.reasonBasic = '연소득 요건 불충족';
      else if (!ageOk) out.reasonBasic = ageReason;
      else { out.isBasicDeductionTarget = true; out.reasonBasic = '기본공제 대상' + (ageReason ? '(' + ageReason + ')' : ''); }
    } else out.reasonBasic = '확인 필요: ' + out.confirmReasons.join(', ');

    if (out.isBasicDeductionTarget) {
      out.isSenior = age !== null && age >= pr.seniorAge;
    }
    var ca = pr.cardAggregation;
    if (ca.relations.indexOf(rel) >= 0) {
      if (member.incomeUnderLimit === true) { out.isCardAggregationTarget = true; out.reasonCard = '소득요건 충족, 나이 무관 합산 가능(옵션)'; }
      else if (member.incomeUnderLimit === false) out.reasonCard = '연소득 요건 불충족';
      else out.reasonCard = '확인 필요(연소득 요건 미입력)';
    } else out.reasonCard = rel === 'SIBLING' ? '형제자매 사용분은 합산 불가' : '합산 대상 관계 아님';

    var ct = rules.childTaxCredit;
    if (out.isBasicDeductionTarget && ct.relations.indexOf(rel) >= 0 && age !== null && age >= ct.minAge) out.isChildTaxCreditTarget = true;
    if (member.bornOrAdoptedThisYear && rel === 'LINEAL_DESCENDANT') {
      var o = member.childOrder;
      if (o === 1) out.birthAdoptionCreditAmount = ct.birthAdoption.first;
      else if (o === 2) out.birthAdoptionCreditAmount = ct.birthAdoption.second;
      else if (o >= 3) out.birthAdoptionCreditAmount = ct.birthAdoption.thirdPlus;
      else { out.needsConfirmation = true; out.confirmReasons.push('출산·입양 순번 미입력'); }
    }
    return out;
  }

  function derivePersonal(state, rules, earnedIncome) {
    var p = state.profile, sc = p.selfConditions || {};
    var pr = rules.personal;
    var flags = state.family.map(function (m) { return deriveFamilyFlags(m, p, rules); });
    var basicCount = 1 + flags.filter(function (f) { return f.isBasicDeductionTarget; }).length;
    var selfAge = ageAtYearEnd(sc.birthYear, p.year);
    var seniorCount = flags.filter(function (f) { return f.isSenior; }).length + ((selfAge !== null && selfAge >= pr.seniorAge) ? 1 : 0);
    var disabledCount = flags.filter(function (f) { return f.isBasicDeductionTarget && f.isDisabled; }).length + (sc.disability ? 1 : 0);
    var hasSpouse = state.family.some(function (m) { return m.relation === 'SPOUSE'; });
    var hasBasicDescendant = flags.some(function (f) { return f.isBasicDeductionTarget && (f.relation === 'LINEAL_DESCENDANT' || f.relation === 'FOSTER_CHILD'); });
    var hasBasicDependent = flags.some(function (f) { return f.isBasicDeductionTarget; });
    var singleParent = !hasSpouse && hasBasicDescendant;
    var womanEligible = sc.gender === 'F' && (hasSpouse || (!hasSpouse && hasBasicDependent && sc.isHouseholdHead)) && earnedIncome <= pr.womanIncomeCap;
    var woman = womanEligible && !(singleParent && pr.priority === 'SINGLE_PARENT_OVER_WOMAN');
    var amounts = {
      basic: basicCount * pr.basic,
      senior: seniorCount * pr.senior,
      disabled: disabledCount * pr.disabled,
      woman: woman ? pr.woman : 0,
      singleParent: singleParent ? pr.singleParent : 0
    };
    var total = amounts.basic + amounts.senior + amounts.disabled + amounts.woman + amounts.singleParent;
    return { flags: flags, basicCount: basicCount, seniorCount: seniorCount, disabledCount: disabledCount, hasSpouse: hasSpouse, singleParent: singleParent, woman: woman, womanEligibleButSuppressed: womanEligible && !woman, amounts: amounts, total: total };
  }

  // ---------- 4대보험 추정 (REQ-013) ----------
  function premiumPeriod(rules, ym) {
    var ps = (rules.premiums && rules.premiums.periods) || [];
    var chosen = null;
    ps.forEach(function (pp) { if (pp.effectiveFrom <= ym && (!chosen || pp.effectiveFrom > chosen.effectiveFrom)) chosen = pp; });
    return chosen;
  }
  function estimatePremiums(yearMonth, gross, nonTaxable, rules) {
    var base = Math.max(0, num(gross) - num(nonTaxable));
    var pp = premiumPeriod(rules, yearMonth);
    var conf = rules.premiums && rules.premiums.confidence;
    var out = { period: pp ? pp.effectiveFrom : null, confidence: conf, items: {} };
    function item(amount, basis) { return { amount: amount, source: 'AUTO', basis: basis, status: amount === null ? 'NEEDS_CONFIRM' : (conf === 'UNVERIFIED' ? 'UNVERIFIED' : 'OK') }; }
    if (!pp) {
      ['nationalPension', 'healthInsurance', 'longTermCare', 'employmentInsurance'].forEach(function (k) { out.items[k] = item(null, '규칙팩에 적용 월 구간 없음(확인 필요)'); });
      return out;
    }
    var np = pp.nationalPension;
    if (np && typeof np.rate === 'number') {
      var b = Math.min(Math.max(base, np.baseMin || 0), np.baseMax || Infinity);
      out.items.nationalPension = item(fl(b * np.rate), '기준소득월액 ' + b.toLocaleString() + ' × ' + (np.rate * 100).toFixed(2) + '% (적용 ' + pp.effectiveFrom + '~)');
    } else out.items.nationalPension = item(null, '국민연금 요율 null');
    var hi = pp.healthInsurance;
    var health = null;
    if (hi && typeof hi.rate === 'number') { health = fl(base * hi.rate); out.items.healthInsurance = item(health, (hi.rate * 100).toFixed(3) + '%'); }
    else out.items.healthInsurance = item(null, '건강보험 요율 null');
    var lt = pp.longTermCare;
    if (lt && typeof lt.rateOfHealth === 'number' && health !== null) out.items.longTermCare = item(fl(health * lt.rateOfHealth), '건강보험료 × ' + (lt.rateOfHealth * 100).toFixed(2) + '%');
    else out.items.longTermCare = item(null, '장기요양 요율 null');
    var ei = pp.employmentInsurance;
    if (ei && typeof ei.rate === 'number') out.items.employmentInsurance = item(fl(base * ei.rate), (ei.rate * 100).toFixed(1) + '%');
    else out.items.employmentInsurance = item(null, '고용보험 요율 null');
    return out;
  }
  /** AUTO/MANUAL 병합: MANUAL은 보존, AUTO는 새 추정값으로 교체 */
  function mergePremiums(existing, auto) {
    var out = {};
    ['nationalPension', 'healthInsurance', 'longTermCare', 'employmentInsurance'].forEach(function (k) {
      var ex = existing && existing[k];
      if (ex && ex.source === 'MANUAL') out[k] = ex; else out[k] = auto.items[k];
    });
    return out;
  }
  function effectivePremium(p) { return p && typeof p.amount === 'number' ? p.amount : 0; }

  // ---------- 카드공제 (REQ-006) ----------
  function cardEligibleSpenders(state, rules) {
    var ids = { self: true };
    if (state.profile.cardFamilyInclusion) {
      state.family.forEach(function (m) {
        var f = deriveFamilyFlags(m, state.profile, rules);
        if (f.isCardAggregationTarget) ids[m.id] = true;
      });
    }
    return ids;
  }

  function classifyExpense(e, gross, rules, range) {
    // 반환: {bucket:'A'|'B'|'C'|'D'|'E'|null, amount, reason}
    var c = rules.card;
    if (e.useCategory === 'EXCLUDED' || (e.deductionTags || []).indexOf('RENT_CREDIT') >= 0) return { bucket: null, reason: '공제제외 사용처' };
    if (e.paymentMethod === 'CASH_NONE' || !e.paymentMethod) return { bucket: null, reason: '현금·이체(공제 없음)' };
    if (!inEmployment(e.date, range)) return { bucket: null, reason: '재직기간 밖' };
    var amt = e.amount;
    if (e.useCategory === 'USED_CAR') amt = fl(amt * c.usedCarInclusionRate);
    var pmBucket = e.paymentMethod === 'CREDIT' ? 'A' : 'B';
    var cat = e.useCategory || 'GENERAL';
    if (cat === 'TRADITIONAL_MARKET') return { bucket: 'D', amount: amt };
    if (cat === 'PUBLIC_TRANSIT') return { bucket: 'E', amount: amt };
    if (cat === 'CULTURE' || cat === 'SPORTS_FACILITY') {
      var cultureOk = gross <= c.cultureGrossCap;
      if (cat === 'SPORTS_FACILITY' && e.date < c.sportsFacilityFrom) cultureOk = false;
      if (cultureOk) return { bucket: 'C', amount: amt };
      return { bucket: pmBucket, amount: amt, reason: cat === 'SPORTS_FACILITY' && e.date < c.sportsFacilityFrom ? '수영장·체력단련장 ' + c.sportsFacilityFrom + ' 이전 결제 → 결제수단 공제율' : '연봉 7천만원 초과 → 결제수단 공제율' };
    }
    return { bucket: pmBucket, amount: amt };
  }

  function computeCard(state, rules, gross, extraExpenses) {
    var c = rules.card;
    var range = employmentRange(state.profile);
    var spenders = cardEligibleSpenders(state, rules);
    var year = String(state.profile.year);
    var sums = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    var bySpender = {};
    var excludedCount = 0, excludedAmount = 0, outsideCount = 0;
    var all = state.expenses.concat(extraExpenses || []);
    var byId = {};
    all.forEach(function (e) { byId[e.id] = e; });
    all.forEach(function (e) {
      if (!e.date || e.date.slice(0, 4) !== year) return;
      var target = e;
      var sign = 1;
      if (e.refundOf) { target = byId[e.refundOf] || e; sign = -1; }
      var sp = target.spenderId || 'self';
      bySpender[sp] = bySpender[sp] || { total: 0, eligible: 0 };
      bySpender[sp].total += sign * e.amount;
      if (!spenders[sp]) return;
      var cl = classifyExpense(Object.assign({}, target, { amount: e.amount, date: e.date }), gross, rules, range);
      if (!cl.bucket) { excludedCount++; excludedAmount += sign * e.amount; if (cl.reason === '재직기간 밖') outsideCount++; return; }
      sums[cl.bucket] += sign * cl.amount;
      bySpender[sp].eligible += sign * cl.amount;
    });
    var total = sums.A + sums.B + sums.C + sums.D + sums.E;
    var minUse = fl(gross * c.minUseRate);
    var tier = c.limitTiers.filter(function (t) { return t.grossUpTo === null || gross <= t.grossUpTo; })[0];
    var r = c.rates;
    var rateAmt = { A: fl(sums.A * r.CREDIT), B: fl(sums.B * r.DEBIT), C: fl(sums.C * r.CULTURE), D: fl(sums.D * r.TRADITIONAL_MARKET), E: fl(sums.E * r.PUBLIC_TRANSIT) };
    var excludedDeduction = 0, excludedCase = '';
    if (total < minUse) { excludedDeduction = rateAmt.A + rateAmt.B + rateAmt.C + rateAmt.D + rateAmt.E; excludedCase = '카드 공제 시작선 미달'; }
    else if (sums.A >= minUse) { excludedDeduction = fl(minUse * r.CREDIT); excludedCase = '(a) ㉮ ≥ 카드 공제 시작선'; }
    else if (sums.A + sums.B + sums.C >= minUse) { excludedDeduction = fl(sums.A * r.CREDIT + (minUse - sums.A) * r.DEBIT); excludedCase = '(b) ㉮+㉯+㉰ ≥ 카드 공제 시작선 > ㉮'; }
    else { excludedDeduction = fl(sums.A * r.CREDIT + (sums.B + sums.C) * r.DEBIT + (minUse - sums.A - sums.B - sums.C) * r.TRADITIONAL_MARKET); excludedCase = '(c) 그 밖'; }
    var deductible = Math.max(0, rateAmt.A + rateAmt.B + rateAmt.C + rateAmt.D + rateAmt.E - excludedDeduction);
    var general = Math.min(deductible, tier.basic);
    var over = Math.max(0, deductible - tier.basic);
    var specialDed = rateAmt.C + rateAmt.D + rateAmt.E;
    var extra = Math.min(over, specialDed, tier.extra);
    var totalDed = general + extra;
    return {
      eligible: total >= minUse, minUse: minUse, total: total, sums: sums, rateAmounts: rateAmt,
      excludedDeduction: excludedDeduction, excludedCase: excludedCase, deductible: deductible,
      basicLimit: tier.basic, extraLimit: tier.extra, general: general, extra: extra, total_deduction: totalDed,
      cultureEligible: gross <= c.cultureGrossCap, bySpender: bySpender, excludedCount: excludedCount, excludedAmount: excludedAmount, outsideEmploymentCount: outsideCount,
      familyIncluded: Object.keys(spenders).filter(function (k) { return k !== 'self'; })
    };
  }

  // ---------- 공제 입력 집계 (REQ-004) ----------
  function collectDeductionInputs(state) {
    // 수동 DeductionEntry + 지출 태그(고정지출 포함). 반환: {category: [entry...]}
    var out = {};
    function push(cat, entry) { (out[cat] = out[cat] || []).push(entry); }
    (state.deductions || []).forEach(function (d) { if (d.category && typeof d.amount === 'number') push(d.category, Object.assign({ source: 'MANUAL' }, d)); });
    var year = String(state.profile.year);
    (state.expenses || []).forEach(function (e) {
      if (!e.date || e.date.slice(0, 4) !== year) return;
      (e.deductionTags || []).forEach(function (tag) {
        var amount = e.amount;
        if (tag === 'MORTGAGE_INTEREST') amount = e.loan ? num(e.loan.interest) : e.amount;
        if (tag === 'RENT_LOAN') amount = e.loan ? num(e.loan.principal) + num(e.loan.interest) : e.amount;
        push(tag, { id: e.id, category: tag, amount: amount, beneficiaryId: e.spenderId || 'self', source: e.recurringId ? 'RECURRING' : 'EXPENSE', meta: e.deductionMeta || {}, date: e.date });
      });
    });
    return out;
  }
  function sumAmt(list) { return (list || []).reduce(function (s, e) { return s + num(e.amount); }, 0); }

  // ---------- 세액 계산 보조 ----------
  function earnedIncomeDeduction(gross, rules) {
    var r = rules.earnedIncomeDeduction;
    var br = r.brackets.filter(function (b) { return b.upTo === null || gross <= b.upTo; })[0];
    var d = fl(br.base + (gross - br.over) * br.rate);
    return Math.min(d, r.cap);
  }
  function calculatedTax(taxBase, rules) {
    if (taxBase <= 0) return 0;
    var br = rules.taxBrackets.filter(function (b) { return b.upTo === null || taxBase <= b.upTo; })[0];
    return Math.max(0, fl(taxBase * br.rate - br.progressive));
  }
  function marginalBracket(taxBase, rules) {
    return rules.taxBrackets.filter(function (b) { return b.upTo === null || taxBase <= b.upTo; })[0];
  }
  function earnedIncomeTaxCredit(calcTax, gross, rules) {
    var r = rules.earnedIncomeTaxCredit;
    var credit = calcTax <= r.threshold ? fl(calcTax * r.rateBelow) : fl(r.baseAbove + (calcTax - r.threshold) * r.rateAbove);
    var tier = r.limitTiers.filter(function (t) { return t.grossUpTo === null || gross <= t.grossUpTo; })[0];
    var limit = tier.limit;
    if (tier.minusRate) limit = Math.max(tier.floor, fl(tier.limit - (gross - tier.minusFrom) * tier.minusRate));
    return { credit: Math.min(credit, limit), limit: limit, raw: credit };
  }

  function medicalCredit(entries, gross, rules, flags) {
    var r = rules.medical;
    var thr = fl(gross * r.thresholdRate);
    var g = { INFERTILITY: 0, PREMATURE: 0, UNLIMITED: 0, GENERAL: 0 };
    var glassesBy = {}, postnatal = 0;
    entries.forEach(function (e) {
      var meta = e.meta || {};
      var amt = Math.max(0, num(e.amount) - num(meta.reimbursed));
      if (meta.kind === 'GLASSES') { var b = e.beneficiaryId || 'self'; var used = glassesBy[b] || 0; var allow = Math.max(0, r.glassesCapPerPerson - used); amt = Math.min(amt, allow); glassesBy[b] = used + amt; }
      if (meta.kind === 'POSTNATAL') { var allow2 = Math.max(0, r.postnatalCapPerBirth - postnatal); amt = Math.min(amt, allow2); postnatal += amt; }
      if (meta.kind === 'COSMETIC' || meta.kind === 'HEALTH_SUPPLEMENT') return;
      var grp = meta.group || 'GENERAL';
      if (!(grp in g)) grp = 'GENERAL';
      g[grp] += amt;
    });
    var rem = thr;
    var ded = { GENERAL: 0, UNLIMITED: 0, PREMATURE: 0, INFERTILITY: 0 };
    if (g.GENERAL >= rem) { ded.GENERAL = Math.min(g.GENERAL - rem, r.generalCap); rem = 0; }
    else { rem -= g.GENERAL; }
    ded.UNLIMITED = Math.max(0, g.UNLIMITED - rem); rem = Math.max(0, rem - g.UNLIMITED);
    ded.PREMATURE = Math.max(0, g.PREMATURE - rem); rem = Math.max(0, rem - g.PREMATURE);
    ded.INFERTILITY = Math.max(0, g.INFERTILITY - rem); rem = Math.max(0, rem - g.INFERTILITY);
    var base = ded.GENERAL + ded.UNLIMITED + ded.PREMATURE + ded.INFERTILITY;
    var credit = fl((ded.GENERAL + ded.UNLIMITED) * r.rate + ded.PREMATURE * r.prematureRate + ded.INFERTILITY * r.infertilityRate);
    var total = g.GENERAL + g.UNLIMITED + g.PREMATURE + g.INFERTILITY;
    return { threshold: thr, groups: g, deductibleByGroup: ded, deductibleBase: base, credit: credit, total: total, belowThreshold: total < thr };
  }

  function educationCredit(entries, rules) {
    var r = rules.education;
    var byBen = {};
    var rejected = [];
    entries.forEach(function (e) {
      var meta = e.meta || {};
      if (meta.kind === 'ACADEMY_SCHOOL') { rejected.push({ id: e.id, reason: '초·중·고 학원비 불인정' }); return; }
      var level = meta.level || 'SCHOOL';
      var b = e.beneficiaryId || 'self';
      var key = b + '|' + level;
      var cap = r.caps[level];
      if (level === 'SELF' || level === 'DISABLED_SPECIAL') cap = null;
      var cur = byBen[key] || { amount: 0, cap: cap };
      var amt = num(e.amount);
      if (meta.kind === 'UNIFORM') amt = Math.min(amt, r.uniformCap);
      if (meta.kind === 'FIELD_TRIP') amt = Math.min(amt, r.fieldTripCap);
      cur.amount += amt; byBen[key] = cur;
    });
    var base = 0;
    Object.keys(byBen).forEach(function (k) { var v = byBen[k]; base += v.cap === null ? v.amount : Math.min(v.amount, v.cap); });
    return { base: base, credit: fl(base * r.rate), rejected: rejected };
  }

  function donationCredits(inputs, earnedIncome, rules) {
    var r = rules.donation;
    var political = sumAmt(inputs.DONATION_POLITICAL);
    var hometown = sumAmt(inputs.DONATION_HOMETOWN);
    var hometownDisaster = (inputs.DONATION_HOMETOWN || []).filter(function (e) { return e.meta && e.meta.disaster; }).reduce(function (s, e) { return s + num(e.amount); }, 0);
    var special = sumAmt(inputs.DONATION_SPECIAL);
    var general = sumAmt(inputs.DONATION_GENERAL);
    var religious = sumAmt(inputs.DONATION_RELIGIOUS);
    // 정치자금
    var pol = 0;
    if (political > 0) {
      var low = Math.min(political, r.political.lowCap);
      pol = fl(low * r.political.lowRatio);
      var mid = Math.min(Math.max(0, political - r.political.lowCap), r.political.midUpTo - r.political.lowCap);
      pol += fl(mid * r.political.midRate);
      pol += fl(Math.max(0, political - r.political.midUpTo) * r.political.highRate);
    }
    // 고향사랑
    var home = 0;
    if (hometown > 0) {
      var hCapped = Math.min(hometown, r.hometown.annualCap);
      var hlow = Math.min(hCapped, r.hometown.lowCap);
      home = fl(hlow * r.hometown.lowRatio);
      var above = Math.max(0, hCapped - r.hometown.lowCap);
      var disasterPart = Math.min(above, hometownDisaster);
      home += fl(disasterPart * r.hometown.disasterRate + (above - disasterPart) * r.hometown.rate);
    }
    // 특례·일반·종교 (한도: 근로소득금액 비율)
    var specialCap = fl(earnedIncome * r.special.incomeCapRate);
    var sEl = Math.min(special, specialCap);
    var generalCap = fl(earnedIncome * r.general.incomeCapRate);
    var gEl = Math.min(general, generalCap);
    var religiousCap = fl(earnedIncome * r.religious.incomeCapRate);
    var rEl = Math.min(religious, religiousCap);
    var combined = sEl + gEl + rEl;
    var lowPart = Math.min(combined, r.special.lowUpTo);
    var sg = fl(lowPart * r.special.lowRate + Math.max(0, combined - r.special.lowUpTo) * r.special.highRate);
    var carry = (special - sEl) + (general - gEl) + (religious - rEl);
    return { political: pol, hometown: home, specialGeneral: sg, amounts: { political: political, hometown: hometown, special: special, general: general, religious: religious }, eligible: { special: sEl, general: gEl, religious: rEl }, carryover: carry };
  }

  function pensionCredit(inputs, gross, rules) {
    var r = rules.pensionAccount;
    var saving = Math.min(sumAmt(inputs.PENSION_SAVING), r.savingCap);
    var irp = sumAmt(inputs.IRP);
    var total = Math.min(saving + irp, r.totalCap);
    var isa = Math.min(fl(sumAmt(inputs.ISA_CONVERSION) * r.isaConversion.rate), r.isaConversion.cap);
    var rate = gross <= r.grossThreshold ? r.rateLow : r.rateHigh;
    return { base: total + isa, rate: rate, credit: fl((total + isa) * rate), saving: saving, irp: irp, isa: isa };
  }

  function rentCredit(inputs, gross, profile, rules) {
    var r = rules.rent;
    var sc = profile.selfConditions || {};
    var amount = sumAmt(inputs.RENT_CREDIT);
    var eligible = gross <= r.grossCap && sc.isHomeless === true && sc.isHouseholdHead === true;
    var reasons = [];
    if (gross > r.grossCap) reasons.push('연봉 8천만원 초과');
    if (sc.isHomeless !== true) reasons.push(sc.isHomeless === null || sc.isHomeless === undefined ? '무주택 여부 미입력(확인 필요)' : '무주택 아님');
    if (sc.isHouseholdHead !== true) reasons.push('세대주 아님');
    var rate = gross <= r.lowGrossCap ? r.lowRate : r.rate;
    var base = Math.min(amount, r.rentCap);
    return { amount: amount, eligible: eligible, reasons: reasons, rate: rate, base: eligible ? base : 0, credit: eligible ? fl(base * rate) : 0, needsConfirm: sc.isHomeless === null || sc.isHomeless === undefined };
  }

  function housingDeductions(inputs, gross, profile, rules) {
    var h = rules.housing, sc = profile.selfConditions || {};
    var sub = sumAmt(inputs.HOUSING_SUBSCRIPTION);
    var subEligible = gross <= h.subscription.grossCap && sc.isHomeless === true && sc.isHouseholdHead === true;
    var subDed = subEligible ? fl(Math.min(sub, h.subscription.annualPayCap) * h.subscription.rate) : 0;
    var rentLoan = sumAmt(inputs.RENT_LOAN);
    var rentLoanDed = fl(rentLoan * h.rentLoan.rate);
    var combined = Math.min(subDed + rentLoanDed, h.rentLoan.combinedCapWithSubscription);
    var mort = sumAmt(inputs.MORTGAGE_INTEREST);
    var capOpt = h.mortgageInterest.capOptions.filter(function (o) { return o.key === profile.mortgageCapKey; })[0];
    var mortDed = 0, mortNote = '';
    if (mort > 0) {
      if (!capOpt) { mortNote = '대출 조건(상환기간·금리) 미선택 → 확인 필요, 공제 0'; }
      else mortDed = Math.min(mort, capOpt.cap);
    }
    return { subscription: sub, subscriptionEligible: subEligible, subscriptionDeduction: subDed, rentLoan: rentLoan, rentLoanDeduction: rentLoanDed, combined: combined, mortgageInterest: mort, mortgageDeduction: mortDed, mortgageNote: mortNote, mortgageCap: capOpt ? capOpt.cap : null,
      specialIncomeDeduction: Math.min(rentLoanDed, h.rentLoan.combinedCapWithSubscription) + mortDed,
      otherDeduction: combined - Math.min(rentLoanDed, h.rentLoan.combinedCapWithSubscription) };
  }

  function smeReduction(profile, calcTax, rules) {
    var sc = profile.selfConditions || {};
    var s = sc.smeEmployment;
    var r = rules.smeReduction;
    if (!s || !s.category || !s.employedAt) return { active: false, amount: 0, rate: 0, reason: '해당 없음' };
    var cat = r.categories[s.category];
    if (!cat) return { active: false, amount: 0, rate: 0, reason: '구분 오류' };
    if (s.employedAt < r.employmentWindow.from || s.employedAt > r.employmentWindow.to) return { active: false, amount: 0, rate: 0, reason: '취업일이 적용 기간 밖' };
    var empYear = parseInt(s.employedAt.slice(0, 4), 10);
    if (profile.year - empYear >= cat.years || profile.year < empYear) return { active: false, amount: 0, rate: 0, reason: '감면 기간(' + cat.years + '년) 종료' };
    var amount = Math.min(r.annualCap, fl(calcTax * cat.rate));
    return { active: true, amount: amount, rate: cat.rate, years: cat.years, reason: s.category + ' ' + (cat.rate * 100) + '% (' + cat.years + '년, 연 ' + r.annualCap.toLocaleString() + '원 한도)' };
  }

  // ---------- 전체 계산 (REQ-009) ----------
  function calc(state, rules, options) {
    options = options || {};
    var warnings = [], missing = [];
    var g = grossFromState(state);
    warnings = warnings.concat(g.warnings); missing = missing.concat(g.missing);
    var result = { ruleVersion: rules.version, verificationLevel: rules.verificationLevel, year: state.profile.year, warnings: warnings, missingFields: missing, grossInfo: g };
    if (g.gross === null) { result.gross = null; result.blocked = true; return result; }
    var gross = g.gross;
    result.gross = gross;

    var eid = earnedIncomeDeduction(gross, rules);
    var earnedIncome = Math.max(0, gross - eid);
    result.earnedIncomeDeduction = eid; result.earnedIncome = earnedIncome;

    var personal = derivePersonal(state, rules, earnedIncome);
    result.personal = personal;
    personal.flags.forEach(function (f) { if (f.needsConfirmation) warnings.push('가족 ' + (f.alias || f.id) + ': ' + f.confirmReasons.join(', ')); });

    // 4대보험 (수동 우선, 없으면 AUTO)
    var prem = { nationalPension: 0, healthInsurance: 0, longTermCare: 0, employmentInsurance: 0, unverified: false, needsConfirm: false };
    Object.keys(state.payroll || {}).forEach(function (ym) {
      var m = state.payroll[ym];
      if (!m || ym.slice(0, 4) !== String(state.profile.year)) return;
      var ps = m.premiums || {};
      ['nationalPension', 'healthInsurance', 'longTermCare', 'employmentInsurance'].forEach(function (k) {
        var p = ps[k];
        if (p && p.amount === null) prem.needsConfirm = true;
        if (p && p.status === 'UNVERIFIED' && p.source !== 'MANUAL') prem.unverified = true;
        prem[k] += effectivePremium(p);
      });
    });
    result.premiums = prem;
    var pensionPremiumDed = prem.nationalPension;
    var insurancePremiumDed = prem.healthInsurance + prem.longTermCare + prem.employmentInsurance;

    var inputs = collectDeductionInputs(state);
    var housing = housingDeductions(inputs, gross, state.profile, rules);
    result.housing = housing;
    if (housing.mortgageNote) warnings.push(housing.mortgageNote);

    // 똑씀이: 카드 소득공제는 앱의 공제현황 계산(computeCardDeduction)을 그대로 넘겨받아 화면 간 숫자를 맞춥니다.
    var card = options.card || computeCard(state, rules, gross, options.extraExpenses);
    result.card = card;

    // 종합한도 대상 합: 카드 + 주택자금(임차 원리금·장기주택 이자) + 주택마련저축
    var capItems = card.total_deduction + housing.combined + housing.mortgageDeduction;
    var overallExcess = Math.max(0, capItems - rules.overallDeductionCap.amount);
    result.overallCap = { items: capItems, excess: overallExcess, cap: rules.overallDeductionCap.amount };

    var medical = medicalCredit(inputs.MEDICAL || [], gross, rules, personal.flags);
    var education = educationCredit(inputs.EDUCATION || [], rules);
    var donation = donationCredits(inputs, earnedIncome, rules);
    var pension = pensionCredit(inputs, gross, rules);
    var rent = rentCredit(inputs, gross, state.profile, rules);
    var insurance = { base: Math.min(sumAmt(inputs.INSURANCE), rules.insurance.cap), baseDisabled: Math.min(sumAmt(inputs.INSURANCE_DISABLED), rules.insurance.disabledCap) };
    insurance.credit = fl(insurance.base * rules.insurance.rate + insurance.baseDisabled * rules.insurance.disabledRate);
    result.medical = medical; result.education = education; result.donation = donation; result.pension = pension; result.rent = rent; result.insurance = insurance;
    if (rent.amount > 0 && rent.needsConfirm) warnings.push('월세 세액공제: 무주택 여부 미입력(확인 필요)');
    if (donation.carryover > 0) warnings.push('기부금 한도 초과 ' + donation.carryover.toLocaleString() + '원은 이월 대상(이월 계산 미지원)');
    education.rejected.forEach(function (x) { warnings.push('교육비 ' + x.id + ': ' + x.reason); });

    var sc = state.profile.selfConditions || {};
    var marriage = (typeof sc.marriageRegisteredYear === 'number' && sc.marriageRegisteredYear >= rules.marriageCredit.yearsFrom && sc.marriageRegisteredYear <= rules.marriageCredit.yearsTo && sc.marriageRegisteredYear === state.profile.year) ? rules.marriageCredit.amount : 0;
    var marriageNote = typeof sc.marriageRegisteredYear === 'number' && !marriage ? (sc.marriageRegisteredYear < rules.marriageCredit.yearsFrom || sc.marriageRegisteredYear > rules.marriageCredit.yearsTo ? '혼인신고 연도 적용 기간 밖' : '혼인신고 연도가 연말정산 연도와 다름(신고한 해에만 공제)') : '';
    var childN = personal.flags.filter(function (f) { return f.isChildTaxCreditTarget; }).length;
    var ct = rules.childTaxCredit.amounts;
    var childCredit = childN === 0 ? 0 : childN === 1 ? ct.one : childN === 2 ? ct.two : ct.threePlusBase + (childN - 2) * ct.threePlusEach;
    var birthAdoption = personal.flags.reduce(function (s, f) { return s + f.birthAdoptionCreditAmount; }, 0);
    result.marriage = { amount: marriage, note: marriageNote };
    result.child = { count: childN, credit: childCredit, birthAdoption: birthAdoption, minAgeUnverified: !!rules.childTaxCredit.minAgeUnverified };

    function scenario(useItemized) {
      var specialIncome = useItemized ? insurancePremiumDed + housing.specialIncomeDeduction : 0;
      var otherDed = card.total_deduction + (useItemized ? housing.otherDeduction : housing.otherDeduction);
      var taxBase = Math.max(0, earnedIncome - personal.total - pensionPremiumDed - specialIncome - otherDed + overallExcess);
      var calcTax = calculatedTax(taxBase, rules);
      var sme = smeReduction(state.profile, calcTax, rules);
      var remaining = calcTax - sme.amount;
      var credits = [];
      function apply(key, label, raw, note) {
        var applied = Math.min(Math.max(0, raw), Math.max(0, remaining));
        remaining -= applied;
        credits.push({ key: key, label: label, raw: raw, applied: applied, note: note || '' });
      }
      var eitc = earnedIncomeTaxCredit(calcTax, gross, rules);
      var eitcAmt = eitc.credit;
      if (sme.active && calcTax > 0) eitcAmt = fl(eitc.credit * (1 - sme.amount / calcTax));
      apply('EARNED_INCOME', '근로소득세액공제', eitcAmt, '한도 ' + eitc.limit.toLocaleString() + (sme.active ? ' · 감면비율 반영' : ''));
      apply('MARRIAGE', '혼인세액공제', marriage, marriageNote);
      apply('CHILD', '자녀세액공제', childCredit + birthAdoption, childN + '명' + (birthAdoption ? ' + 출산·입양 ' + birthAdoption.toLocaleString() : ''));
      if (useItemized) {
        apply('INSURANCE', '보장성보험료', insurance.credit);
        apply('MEDICAL', '의료비', medical.credit, medical.belowThreshold ? '연봉 3% 미달' : '');
        apply('EDUCATION', '교육비', education.credit);
      }
      apply('POLITICAL', '정치자금기부금', donation.political);
      apply('HOMETOWN', '고향사랑기부금', donation.hometown);
      if (!useItemized) apply('STANDARD', '기본 세액공제(13만원)', rules.standardTaxCredit.amount, '특별소득·세액공제·월세 미신청');
      if (useItemized) {
        apply('RENT', '월세액', rent.credit, rent.eligible ? (rent.rate * 100) + '%' : rent.reasons.join(', '));
        apply('DONATION_SPECIAL_GENERAL', '특례·일반기부금', donation.specialGeneral);
      }
      apply('PENSION_ACCOUNT', '연금계좌', pension.credit, (pension.rate * 100) + '%');
      var creditTotal = credits.reduce(function (s, c) { return s + c.applied; }, 0);
      var determined = Math.max(0, calcTax - sme.amount - creditTotal);
      return { itemized: useItemized, specialIncomeDeduction: specialIncome, otherDeduction: otherDed, taxBase: taxBase, calculatedTax: calcTax, sme: sme, credits: credits, creditTotal: creditTotal, determinedTax: determined, pensionCreditUnused: pension.credit - (credits.filter(function (c) { return c.key === 'PENSION_ACCOUNT'; })[0] || { applied: 0 }).applied };
    }
    var A = scenario(true), B = scenario(false);
    var chosen = B.determinedTax < A.determinedTax ? B : A;
    result.scenarios = { itemized: A, standard: B };
    result.standardChoice = chosen.itemized ? 'ITEMIZED' : 'STANDARD';
    result.pensionPremiumDeduction = pensionPremiumDed;
    result.insurancePremiumDeduction = insurancePremiumDed;
    result.specialIncomeDeduction = chosen.specialIncomeDeduction;
    result.otherDeduction = chosen.otherDeduction;
    result.taxBase = chosen.taxBase;
    result.marginal = marginalBracket(chosen.taxBase, rules);
    result.calculatedTax = chosen.calculatedTax;
    result.sme = chosen.sme;
    result.credits = chosen.credits;
    result.creditTotal = chosen.creditTotal;
    result.determinedTax = chosen.determinedTax;
    result.localTax = fl(chosen.determinedTax * rules.localIncomeTax.rate);
    result.totalTax = result.determinedTax + result.localTax;
    result.pensionCreditUnused = chosen.pensionCreditUnused;

    var wIncome = 0, wLocal = 0, anyWithheld = false;
    Object.keys(state.payroll || {}).forEach(function (ym) {
      var m = state.payroll[ym]; if (!m) return;
      if (typeof m.incomeTaxWithheld === 'number') { wIncome += m.incomeTaxWithheld; anyWithheld = true; }
      if (typeof m.localTaxWithheld === 'number') { wLocal += m.localTaxWithheld; anyWithheld = true; }
    });
    result.withheld = { income: wIncome, local: wLocal, any: anyWithheld };
    if (anyWithheld) result.settlement = result.totalTax - (wIncome + wLocal);
    else { result.settlement = null; warnings.push('미리 낸 세금(미리 낸 소득세·지방소득세) 미입력 → 정산액(환급/추가납부) 보류'); }
    if (prem.unverified) warnings.push('4대보험은 추정값이에요 — 급여명세서 값으로 고칠 수 있어요');
    if (prem.needsConfirm) warnings.push('4대보험 일부 항목 규칙 없음(확인 필요)');
    result.estimateOnly = rules.verificationLevel !== 'CASE_VERIFIED'; // 공식 사례 검증 전 → 예상치(화면 경고에는 넣지 않음)
    return result;
  }

  /** 추가 지출(예상)을 넣고 재평가 — 최적화·플랜용 */
  function calcWithExtra(state, rules, extraExpenses) { return calc(state, rules, { extraExpenses: extraExpenses }); }

  function mkExtra(id, amount, paymentMethod, useCategory, date) {
    return { id: id, date: date, amount: amount, paymentMethod: paymentMethod, useCategory: useCategory, spenderId: 'self', deductionTags: [], status: 'FORECAST' };
  }

  // ---------- 최적 사용 플랜 (REQ-015) ----------
  function buildOptimalPlan(state, rules) {
    var base = calc(state, rules);
    if (base.blocked) return { available: false, reason: '연봉 미입력', missing: base.missingFields };
    var gross = base.gross;
    var c = rules.card;
    var range = employmentRange(state.profile);
    var date = range.end;
    var unit = 10000;
    var card0 = base.card;
    var tax0 = base.totalTax;
    var stages = [];
    var extras = [];
    // 1단계: 최저사용액까지 (신용 가능)
    var need1 = Math.max(0, card0.minUse - card0.total);
    var e1 = extras.slice(); if (need1 > 0) e1.push(mkExtra('plan1', need1, 'CREDIT', 'GENERAL', date));
    var r1 = calcWithExtra(state, rules, e1);
    stages.push({ key: 'THRESHOLD', label: '카드 공제 시작선까지', method: '신용카드로 채워도 무방(어떤 수단이든 공제 0)', target: card0.minUse, current: Math.min(card0.total, card0.minUse), need: need1, deduction: 0, taxSaving: Math.max(0, tax0 - r1.totalTax), progress: card0.minUse > 0 ? Math.min(1, card0.total / card0.minUse) : 1,
      why: '카드 공제 시작선은 신용카드 15%분부터 차감되므로(안내 p.41 ①) 이 구간은 신용카드를 써도 손해가 없습니다.' });
    extras = e1;
    // 2단계: 체크·현금영수증으로 기본한도
    var card1 = r1.card;
    var remainBasic = Math.max(0, card1.basicLimit - card1.general);
    var need2 = remainBasic > 0 ? ceilTo(remainBasic / c.rates.DEBIT, unit) : 0;
    var e2 = extras.slice(); if (need2 > 0) e2.push(mkExtra('plan2', need2, 'DEBIT', 'GENERAL', date));
    var r2 = calcWithExtra(state, rules, e2);
    stages.push({ key: 'BASIC', label: '기본 공제 한도 채우기', method: '체크·직불·선불·현금영수증(' + (c.rates.DEBIT * 100) + '%)', target: card1.basicLimit, current: card1.general, need: need2, deduction: r2.card.general - card1.general, taxSaving: Math.max(0, r1.totalTax - r2.totalTax), progress: card1.basicLimit > 0 ? Math.min(1, card1.general / card1.basicLimit) : 1,
      why: '카드 공제 시작선을 넘긴 뒤에는 공제율이 높은 수단(30%)으로 기본 공제 한도 ' + card1.basicLimit.toLocaleString() + '원을 채우는 것이 가장 적은 지출로 한도에 닿습니다.' });
    extras = e2;
    // 3단계: 전통시장·대중교통(·문화체육)으로 추가한도
    var card2 = r2.card;
    var remainExtra = Math.max(0, card2.extraLimit - card2.extra);
    var need3 = remainExtra > 0 ? ceilTo(remainExtra / c.rates.TRADITIONAL_MARKET, unit) : 0;
    var e3 = extras.slice(); if (need3 > 0) e3.push(mkExtra('plan3', need3, 'DEBIT', 'TRADITIONAL_MARKET', date));
    var r3 = calcWithExtra(state, rules, e3);
    stages.push({ key: 'EXTRA', label: '시장·교통 추가 한도 채우기', method: '전통시장·대중교통(' + (c.rates.TRADITIONAL_MARKET * 100) + '%)' + (card0.cultureEligible ? ' · 문화체육(' + (c.rates.CULTURE * 100) + '%)' : ''), target: card2.extraLimit, current: card2.extra, need: need3, deduction: r3.card.extra - card2.extra, taxSaving: Math.max(0, r2.totalTax - r3.totalTax), progress: card2.extraLimit > 0 ? Math.min(1, card2.extra / card2.extraLimit) : 1,
      why: '전통시장·대중교통 사용분은 40%로 계산되고 시장·교통 추가 한도 ' + card2.extraLimit.toLocaleString() + '원에 따로 들어갑니다.' + (card0.cultureEligible ? ' 문화체육(30%)도 시장·교통 추가 한도에 포함됩니다.' : ' 연봉 7천만원 초과자는 문화체육 30%가 적용되지 않습니다.') });
    var totalNeed = need1 + need2 + need3;
    var saturation = card0.total + totalNeed;
    // 의료비·기부금
    var med = base.medical;
    var medThreshold = med.threshold;
    var don = base.donation;
    var dr = rules.donation;
    var autoApplied = {
      gross: gross,
      limitTier: { basic: card0.basicLimit, extra: card0.extraLimit, label: gross <= c.limitTiers[0].grossUpTo ? '연봉 7천만원 이하' : '연봉 7천만원 초과' },
      minUse: card0.minUse,
      cultureEligible: card0.cultureEligible,
      medicalThreshold: medThreshold,
      rent: { eligibleByGross: gross <= rules.rent.grossCap, rate: gross <= rules.rent.lowGrossCap ? rules.rent.lowRate : rules.rent.rate },
      pensionRate: gross <= rules.pensionAccount.grossThreshold ? rules.pensionAccount.rateLow : rules.pensionAccount.rateHigh,
      subscriptionEligibleByGross: gross <= rules.housing.subscription.grossCap,
      marginal: base.marginal,
      taxBase: base.taxBase,
      determinedTax: base.determinedTax,
      totalTax: base.totalTax,
      earnedIncome: base.earnedIncome
    };
    return {
      available: true, gross: gross, unit: unit, stages: stages, totalNeed: totalNeed, saturation: saturation,
      totalDeduction: r3.card.total_deduction, totalTaxSaving: Math.max(0, tax0 - r3.totalTax),
      medical: { threshold: medThreshold, rate: rules.medical.rate, generalCap: rules.medical.generalCap, current: med.total, credit: med.credit, progress: medThreshold > 0 ? Math.min(1, med.total / medThreshold) : 1 },
      donation: { hometownLowCap: dr.hometown.lowCap, hometownLowRatio: dr.hometown.lowRatio, hometownRate: dr.hometown.rate, generalLowUpTo: dr.general.lowUpTo, generalLowRate: dr.general.lowRate, generalHighRate: dr.general.highRate, current: don.amounts, credit: don.political + don.hometown + don.specialGeneral, capNote: '특례·일반 기부금 한도는 연봉이 아닌 근로소득(' + base.earnedIncome.toLocaleString() + '원) 기준' },
      autoApplied: autoApplied,
      hasInputs: state.expenses.length > 0 || state.deductions.length > 0 || state.family.length > 0,
      baseline: base,
      final: r3,
      extras: e3
    };
  }

  /*
   * 최적 사용 플랜 한눈에 보기(요약표). 카드 3단계 뒤에 연금계좌 → 주택청약 → 고향사랑기부를 차례로 한도까지 더하며
   * 매번 세금을 다시 계산해 항목별 절세액을 구한다(결정세액 한도·항목 간 영향 반영, 합계 = 항목 합).
   * maxUse = 지금부터 더 쓰거나 넣으면 혜택이 최대가 되는 금액(이미 입력한 금액 제외).
   */
  function buildPlanSummary(state, rules, plan) {
    if (!plan || !plan.available) return null;
    var rows = [];
    plan.stages.forEach(function (s) {
      var c = rules.card.rates;
      var map = {
        THRESHOLD: { label: '신용카드', sub: '카드 공제 시작선(연봉 25%)까지', rate: pctText(c.CREDIT) + '(이 구간 공제 0)', type: '소득공제' },
        BASIC: { label: '체크카드·현금영수증', sub: '기본 공제 한도 채우기', rate: pctText(c.DEBIT), type: '소득공제' },
        EXTRA: { label: '전통시장·대중교통', sub: '시장·교통 추가 한도 채우기' + (plan.autoApplied.cultureEligible ? '(문화체육 ' + pctText(c.CULTURE) + ' 포함)' : ''), rate: pctText(c.TRADITIONAL_MARKET), type: '소득공제' }
      }[s.key];
      rows.push({ key: s.key, group: 'CARD', label: map.label, sub: map.sub, rate: map.rate, type: map.type, maxUse: s.need, deduction: s.deduction, taxSaving: s.key === 'THRESHOLD' ? 0 : s.taxSaving, conditional: false });
    });
    var inputs = collectDeductionInputs(state);
    var gross = plan.gross, extras = plan.extras || [];
    var added = [];
    function withAdded(st, more) { return Object.assign({}, st, { deductions: (st.deductions || []).concat(more) }); }
    function entry(cat, amount) { return { id: 'plan-' + cat, category: cat, amount: amount, beneficiaryId: 'self', meta: {} }; }
    var prevTax = plan.final.totalTax;
    function step(key, label, sub, rate, type, entries, maxUse, profileOverride, note) {
      var st = withAdded(state, added.concat(entries));
      if (profileOverride) st.profile = Object.assign({}, st.profile, { selfConditions: Object.assign({}, st.profile.selfConditions, profileOverride) });
      var r = calc(st, rules, { extraExpenses: extras });
      var saving = Math.max(0, prevTax - r.totalTax);
      rows.push({ key: key, group: 'OTHER', label: label, sub: sub, rate: rate, type: type, maxUse: maxUse, deduction: 0, taxSaving: saving, conditional: !!profileOverride, note: note || '', result: r });
      if (!profileOverride) { added = added.concat(entries); prevTax = r.totalTax; }
      return r;
    }
    // 연금계좌: 연금저축 600만원 + IRP 합산 900만원 한도
    var pa = rules.pensionAccount;
    var curSaving = sumAmt(inputs.PENSION_SAVING), curIrp = sumAmt(inputs.IRP);
    var addSaving = Math.max(0, Math.min(pa.savingCap, pa.totalCap - curIrp) - curSaving);
    var addIrp = Math.max(0, pa.totalCap - Math.min(curSaving + addSaving, pa.savingCap) - curIrp);
    var pRate = gross <= pa.grossThreshold ? pa.rateLow : pa.rateHigh;
    var pEntries = []; if (addSaving > 0) pEntries.push(entry('PENSION_SAVING', addSaving)); if (addIrp > 0) pEntries.push(entry('IRP', addIrp));
    var before = plan.final.pension ? plan.final.pension.credit : 0;
    var rp = step('PENSION', '연금계좌(연금저축+IRP)', '연금저축 ' + won0(pa.savingCap) + ' 포함 합계 ' + won0(pa.totalCap) + ' 한도', pctText(pRate), '세액공제', pEntries, addSaving + addIrp);
    rows[rows.length - 1].deduction = Math.max(0, (rp.pension ? rp.pension.credit : 0) - before);
    // 주택청약종합저축: 총급여 7천만원 이하 + 무주택 세대주, 연 300만원 × 40% 소득공제
    var hs = rules.housing.subscription, sc = state.profile.selfConditions || {};
    var curSub = sumAmt(inputs.HOUSING_SUBSCRIPTION), addSub = Math.max(0, hs.annualPayCap - curSub);
    if (gross > hs.grossCap) rows.push({ key: 'SUBSCRIPTION', group: 'OTHER', label: '주택청약종합저축', sub: '연봉 7천만원 초과 → 대상 아님', rate: pctText(hs.rate), type: '소득공제', maxUse: 0, deduction: 0, taxSaving: 0, conditional: false, na: true });
    else {
      var subEligible = sc.isHomeless === true && sc.isHouseholdHead === true;
      var rs = step('SUBSCRIPTION', '주택청약종합저축', '연 ' + won0(hs.annualPayCap) + ' 납입 한도', pctText(hs.rate), '소득공제', addSub > 0 ? [entry('HOUSING_SUBSCRIPTION', addSub)] : [], addSub, subEligible ? null : { isHomeless: true, isHouseholdHead: true }, subEligible ? '' : '무주택 세대주일 때 금액(설정에서 무주택·세대주 체크 시 합계에 포함)');
      rows[rows.length - 1].deduction = rs.housing ? Math.max(0, rs.housing.subscriptionDeduction - (plan.final.housing ? plan.final.housing.subscriptionDeduction : 0)) : fl(addSub * hs.rate);
    }
    // 고향사랑기부: 10만원까지 100/110 세액공제(지방소득세 포함 사실상 전액 환급), 초과분 15%
    var dh = rules.donation.hometown, curHome = sumAmt(inputs.DONATION_HOMETOWN), addHome = Math.max(0, dh.lowCap - curHome);
    step('HOMETOWN', '고향사랑기부', won0(dh.lowCap) + '까지(초과분 ' + pctText(dh.rate) + ')', '100/110', '세액공제', addHome > 0 ? [entry('DONATION_HOMETOWN', addHome)] : [], addHome);
    rows[rows.length - 1].deduction = fl(addHome * dh.lowRatio);
    var counted = rows.filter(function (r) { return !r.conditional && !r.na; });
    return {
      rows: rows,
      totals: {
        maxUse: counted.reduce(function (s, r) { return s + r.maxUse; }, 0),
        cardMaxUse: rows.filter(function (r) { return r.group === 'CARD'; }).reduce(function (s, r) { return s + r.maxUse; }, 0),
        incomeDeduction: counted.filter(function (r) { return r.type === '소득공제'; }).reduce(function (s, r) { return s + r.deduction; }, 0),
        taxCredit: counted.filter(function (r) { return r.type === '세액공제'; }).reduce(function (s, r) { return s + r.deduction; }, 0),
        taxSaving: counted.reduce(function (s, r) { return s + r.taxSaving; }, 0)
      },
      baselineTax: plan.baseline.totalTax,
      finalTax: prevTax,
      medical: plan.medical
    };
  }
  /*
   * 전체 절세 설계(시뮬레이션). 실제 입력(지출·공제)과 별개로, 연봉만 있는 상태(기준)에서
   * 선택한 부양가족 → 선택한 항목을 대분류 순서대로 더하며 매번 세금을 다시 계산한다.
   * scenario: { family: {가족id: false면 제외}, extraFamily: [가상 부양가족], items: {key: {on, amount}},
   *             homelessHead, smeCategory, mortgageCapKey }
   * 선택 안 한 항목은 "선택하면 더 줄어드는 세금"(potential)을 최종 상태에 하나만 더해 계산한다.
   */
  var DESIGN_GROUPS = [
    { key: 'FAMILY', label: '인적공제(부양가족)', type: '소득공제' },
    { key: 'CARD', label: '신용카드 등 사용', type: '소득공제' },
    { key: 'SAVING', label: '연금·저축', type: '세액·소득공제' },
    { key: 'INSURANCE', label: '보험료', type: '세액공제' },
    { key: 'MEDICAL', label: '의료비', type: '세액공제' },
    { key: 'EDUCATION', label: '교육비', type: '세액공제' },
    { key: 'DONATION', label: '기부금', type: '세액공제' },
    { key: 'HOUSING', label: '주거(월세·전세·주택대출)', type: '세액·소득공제' },
    { key: 'OTHER', label: '기타 공제·감면', type: '세액공제·감면' }
  ];
  function designCatalog(gross, rules, year) {
    var c = rules.card, lim = c.limitTiers.filter(function (t) { return t.grossUpTo === null || gross <= t.grossUpTo; })[0];
    var minUse = fl(gross * c.minUseRate), pa = rules.pensionAccount, md = rules.medical, ed = rules.education, dn = rules.donation, hs = rules.housing, rt = rules.rent;
    var medThr = fl(gross * md.thresholdRate), pRate = gross <= pa.grossThreshold ? pa.rateLow : pa.rateHigh;
    var cultureOk = gross <= c.cultureGrossCap, rentRate = gross <= rt.lowGrossCap ? rt.lowRate : rt.rate;
    var M = function (o) { return o; };
    return [
      M({ key: 'CARD_CREDIT', group: 'CARD', label: '신용카드', sub: '카드 공제 시작선(연봉 25%)까지는 어떤 수단이든 공제 0 — 신용카드로 채워도 손해 없음', rate: pctText(c.rates.CREDIT), cap: '카드 공제 시작선 ' + won0(minUse), on: true, amount: minUse, metric: 'card' }),
      M({ key: 'CARD_DEBIT', group: 'CARD', label: '체크카드·현금영수증', sub: '카드 공제 시작선을 넘긴 뒤 기본 공제 한도 채우기', rate: pctText(c.rates.DEBIT), cap: '기본 공제 한도 ' + won0(lim.basic), on: true, amount: ceilTo(lim.basic / c.rates.DEBIT, 10000), metric: 'card' }),
      M({ key: 'CARD_MARKET', group: 'CARD', label: '전통시장', sub: '시장·교통 추가 한도(시장·교통·문화 합산)', rate: pctText(c.rates.TRADITIONAL_MARKET), cap: '시장·교통 추가 한도 ' + won0(lim.extra), on: true, amount: ceilTo(lim.extra / c.rates.TRADITIONAL_MARKET, 10000), metric: 'card' }),
      M({ key: 'CARD_TRANSIT', group: 'CARD', label: '대중교통', sub: '전통시장과 시장·교통 추가 한도를 함께 씀(이미 다 채웠으면 효과 없음)', rate: pctText(c.rates.PUBLIC_TRANSIT), cap: '시장·교통 추가 한도 합산', on: false, amount: 1200000, metric: 'card' }),
      M({ key: 'CARD_CULTURE', group: 'CARD', label: '문화체육(도서·공연·영화·수영장·헬스)', sub: cultureOk ? '시장·교통 추가 한도 합산' : '연봉 7천만원 초과 → 대상 아님', rate: pctText(c.rates.CULTURE), cap: '시장·교통 추가 한도 합산', on: false, amount: 1000000, na: !cultureOk, metric: 'card' }),
      M({ key: 'PENSION_SAVING', group: 'SAVING', label: '연금저축', sub: '연금계좌 세액공제(IRP와 합산 ' + won0(pa.totalCap) + ')', rate: pctText(pRate), cap: won0(pa.savingCap), on: true, amount: pa.savingCap, max: pa.savingCap, metric: 'pension', type: '세액공제' }),
      M({ key: 'IRP', group: 'SAVING', label: 'IRP(개인형 퇴직연금)', sub: '연금저축과 합산 ' + won0(pa.totalCap) + ' 한도', rate: pctText(pRate), cap: won0(pa.totalCap - pa.savingCap) + '(합산 기준)', on: true, amount: pa.totalCap - pa.savingCap, max: pa.totalCap, metric: 'pension', type: '세액공제' }),
      M({ key: 'ISA', group: 'SAVING', label: 'ISA 만기 연금계좌 전환', sub: '전환액의 10%, 최대 ' + won0(pa.isaConversion.cap) + ' 추가', rate: pctText(pRate), cap: '전환 ' + won0(pa.isaConversion.cap / pa.isaConversion.rate), on: false, amount: fl(pa.isaConversion.cap / pa.isaConversion.rate), metric: 'pension', type: '세액공제' }),
      M({ key: 'SUBSCRIPTION', group: 'SAVING', label: '주택청약종합저축', sub: gross > hs.subscription.grossCap ? '연봉 7천만원 초과 → 대상 아님' : '무주택 세대주만', rate: pctText(hs.subscription.rate), cap: won0(hs.subscription.annualPayCap), on: true, amount: hs.subscription.annualPayCap, max: hs.subscription.annualPayCap, na: gross > hs.subscription.grossCap, needsHomeless: true, metric: 'housing', type: '소득공제' }),
      M({ key: 'INSURANCE', group: 'INSURANCE', label: '보장성보험(자동차·실손·종신 등)', sub: '연 100만원 한도', rate: pctText(rules.insurance.rate), cap: won0(rules.insurance.cap), on: true, amount: rules.insurance.cap, max: rules.insurance.cap, metric: 'insurance' }),
      M({ key: 'INSURANCE_DISABLED', group: 'INSURANCE', label: '장애인전용 보장성보험', sub: '장애인 피보험자', rate: pctText(rules.insurance.disabledRate), cap: won0(rules.insurance.disabledCap), on: false, amount: rules.insurance.disabledCap, max: rules.insurance.disabledCap, metric: 'insurance' }),
      M({ key: 'MED_SELF', group: 'MEDICAL', label: '본인·65세 이상·6세 이하·장애인', sub: '한도 없음. 연봉 3%(' + won0(medThr) + ') 넘는 금액부터', rate: pctText(md.rate), cap: '한도 없음', on: false, amount: ceilTo(medThr + 1000000, 10000), metric: 'medical', example: true }),
      M({ key: 'MED_GENERAL', group: 'MEDICAL', label: '그 외 부양가족', sub: '공제대상 ' + won0(md.generalCap) + ' 한도', rate: pctText(md.rate), cap: won0(md.generalCap) + '(문턱 초과분)', on: false, amount: ceilTo(medThr + 1000000, 10000), metric: 'medical', example: true }),
      M({ key: 'MED_INFERTILITY', group: 'MEDICAL', label: '난임시술비', sub: '한도 없음', rate: pctText(md.infertilityRate), cap: '한도 없음', on: false, amount: 3000000, metric: 'medical', example: true }),
      M({ key: 'MED_GLASSES', group: 'MEDICAL', label: '안경·콘택트렌즈', sub: '1인 50만원까지 의료비에 포함', rate: pctText(md.rate), cap: won0(md.glassesCapPerPerson) + '/인', on: false, amount: md.glassesCapPerPerson, max: md.glassesCapPerPerson, metric: 'medical' }),
      M({ key: 'EDU_SELF', group: 'EDUCATION', label: '본인(대학원·직업훈련 등)', sub: '한도 없음', rate: pctText(ed.rate), cap: '한도 없음', on: false, amount: 3000000, metric: 'education', example: true }),
      M({ key: 'EDU_PRESCHOOL', group: 'EDUCATION', label: '취학 전 아동(어린이집·유치원·학원)', sub: '1인당', rate: pctText(ed.rate), cap: won0(ed.caps.PRESCHOOL) + '/인', on: false, amount: ed.caps.PRESCHOOL, max: ed.caps.PRESCHOOL, metric: 'education' }),
      M({ key: 'EDU_SCHOOL', group: 'EDUCATION', label: '초·중·고(학원비 제외)', sub: '1인당', rate: pctText(ed.rate), cap: won0(ed.caps.SCHOOL) + '/인', on: false, amount: ed.caps.SCHOOL, max: ed.caps.SCHOOL, metric: 'education' }),
      M({ key: 'EDU_UNIV', group: 'EDUCATION', label: '대학생', sub: '1인당', rate: pctText(ed.rate), cap: won0(ed.caps.UNIVERSITY) + '/인', on: false, amount: ed.caps.UNIVERSITY, max: ed.caps.UNIVERSITY, metric: 'education' }),
      M({ key: 'DON_HOMETOWN', group: 'DONATION', label: '고향사랑기부(10만원까지)', sub: '100/110 공제 + 지방세 → 사실상 전액 환급, 답례품 별도', rate: '100/110', cap: won0(dn.hometown.lowCap), on: true, amount: dn.hometown.lowCap, max: dn.hometown.lowCap, metric: 'donation' }),
      M({ key: 'DON_HOMETOWN_MORE', group: 'DONATION', label: '고향사랑기부 추가분', sub: '10만원 초과분, 연 ' + won0(dn.hometown.annualCap) + '까지', rate: pctText(dn.hometown.rate), cap: won0(dn.hometown.annualCap - dn.hometown.lowCap), on: false, amount: 400000, max: dn.hometown.annualCap - dn.hometown.lowCap, metric: 'donation', example: true }),
      M({ key: 'DON_POLITICAL', group: 'DONATION', label: '정치자금 기부(10만원까지)', sub: '100/110 공제', rate: '100/110', cap: won0(dn.political.lowCap), on: false, amount: dn.political.lowCap, metric: 'donation' }),
      M({ key: 'DON_SPECIAL', group: 'DONATION', label: '특례기부금(국가·재난·대학 등)', sub: '근로소득 100% 한도', rate: pctText(dn.special.lowRate) + '(1천만원 초과 ' + pctText(dn.special.highRate) + ')', cap: '소득 100%', on: false, amount: 1000000, metric: 'donation', example: true }),
      M({ key: 'DON_GENERAL', group: 'DONATION', label: '일반기부금(종교 외)', sub: '근로소득 30% 한도', rate: pctText(dn.general.lowRate), cap: '소득 30%', on: false, amount: 1000000, metric: 'donation', example: true }),
      M({ key: 'DON_RELIGIOUS', group: 'DONATION', label: '종교단체 기부금', sub: '근로소득 10% 한도', rate: pctText(dn.religious.lowRate), cap: '소득 10%', on: false, amount: 1000000, metric: 'donation', example: true }),
      M({ key: 'RENT', group: 'HOUSING', label: '월세 세액공제', sub: gross > rt.grossCap ? '연봉 8천만원 초과 → 대상 아님' : '무주택 세대주, 국민주택규모·기준시가 4억 이하', rate: pctText(rentRate), cap: won0(rt.rentCap), on: false, amount: 6000000, max: rt.rentCap, na: gross > rt.grossCap, needsHomeless: true, metric: 'rent', example: true }),
      M({ key: 'RENT_LOAN', group: 'HOUSING', label: '전세대출 원리금 상환', sub: '무주택 세대주, 청약과 합산 공제 ' + won0(hs.rentLoan.combinedCapWithSubscription), rate: pctText(hs.rentLoan.rate), cap: '공제 ' + won0(hs.rentLoan.combinedCapWithSubscription), on: false, amount: 10000000, needsHomeless: true, metric: 'housing', type: '소득공제', example: true }),
      M({ key: 'MORTGAGE', group: 'HOUSING', label: '주택담보대출 이자', sub: '무주택·1주택 세대주, 취득 당시 기준시가 6억 이하. 한도는 아래에서 고른 대출 조건', rate: '100%(소득공제)', cap: '조건별 600만~2천만원', on: false, amount: 8000000, metric: 'mortgage', type: '소득공제', example: true }),
      M({ key: 'MARRIAGE', group: 'OTHER', label: '혼인세액공제', sub: '올해 혼인신고(' + rules.marriageCredit.yearsFrom + '~' + rules.marriageCredit.yearsTo + ', 생애 1회)', rate: '정액', cap: won0(rules.marriageCredit.amount), on: false, toggleOnly: true, metric: 'marriage' }),
      M({ key: 'SME', group: 'OTHER', label: '중소기업 취업자 소득세 감면', sub: '청년 90%(5년)·60세 이상·장애인·경력단절 70%(3년), 연 200만원 한도', rate: '70~90%', cap: '연 200만원', on: false, toggleOnly: true, metric: 'sme', type: '감면' })
    ].map(function (it) { it.type = it.type || DESIGN_GROUPS.filter(function (g) { return g.key === it.group; })[0].type; return it; });
  }
  function designItemParts(it, amount, year) {
    var a = Math.max(0, num(amount));
    switch (it.key) {
      case 'CARD_CREDIT': return { extras: a ? [mkExtra('d-cc', a, 'CREDIT', 'GENERAL', year + '-12-31')] : [] };
      case 'CARD_DEBIT': return { extras: a ? [mkExtra('d-cd', a, 'DEBIT', 'GENERAL', year + '-12-31')] : [] };
      case 'CARD_MARKET': return { extras: a ? [mkExtra('d-cm', a, 'DEBIT', 'TRADITIONAL_MARKET', year + '-12-31')] : [] };
      case 'CARD_TRANSIT': return { extras: a ? [mkExtra('d-ct', a, 'DEBIT', 'PUBLIC_TRANSIT', year + '-12-31')] : [] };
      case 'CARD_CULTURE': return { extras: a ? [mkExtra('d-cu', a, 'DEBIT', 'CULTURE', year + '-12-31')] : [] };
    }
    var map = {
      PENSION_SAVING: ['PENSION_SAVING'], IRP: ['IRP'], ISA: ['ISA_CONVERSION'], SUBSCRIPTION: ['HOUSING_SUBSCRIPTION'],
      INSURANCE: ['INSURANCE'], INSURANCE_DISABLED: ['INSURANCE_DISABLED'],
      MED_SELF: ['MEDICAL', { group: 'UNLIMITED' }], MED_GENERAL: ['MEDICAL', { group: 'GENERAL' }, 'd-dep'], MED_INFERTILITY: ['MEDICAL', { group: 'INFERTILITY' }], MED_GLASSES: ['MEDICAL', { group: 'UNLIMITED', kind: 'GLASSES' }],
      EDU_SELF: ['EDUCATION', { level: 'SELF' }], EDU_PRESCHOOL: ['EDUCATION', { level: 'PRESCHOOL' }, 'd-kid1'], EDU_SCHOOL: ['EDUCATION', { level: 'SCHOOL' }, 'd-kid2'], EDU_UNIV: ['EDUCATION', { level: 'UNIVERSITY' }, 'd-kid3'],
      DON_HOMETOWN: ['DONATION_HOMETOWN'], DON_HOMETOWN_MORE: ['DONATION_HOMETOWN'], DON_POLITICAL: ['DONATION_POLITICAL'], DON_SPECIAL: ['DONATION_SPECIAL'], DON_GENERAL: ['DONATION_GENERAL'], DON_RELIGIOUS: ['DONATION_RELIGIOUS'],
      RENT: ['RENT_CREDIT'], RENT_LOAN: ['RENT_LOAN'], MORTGAGE: ['MORTGAGE_INTEREST']
    }[it.key];
    if (map) return { entries: a ? [{ id: 'd-' + it.key, category: map[0], amount: a, beneficiaryId: map[2] || 'self', meta: map[1] || {} }] : [] };
    if (it.key === 'MARRIAGE') return { profile: { marriageRegisteredYear: year } };
    if (it.key === 'SME') return { sme: true };
    return {};
  }
  function designMetric(r, metric) {
    if (!r || r.blocked) return 0;
    switch (metric) {
      case 'card': return r.card.total_deduction;
      case 'pension': return r.pension.credit;
      case 'housing': return r.housing.combined;
      case 'mortgage': return r.housing.mortgageDeduction;
      case 'insurance': return r.insurance.credit;
      case 'medical': return r.medical.credit;
      case 'education': return r.education.credit;
      case 'donation': return r.donation.political + r.donation.hometown + r.donation.specialGeneral;
      case 'rent': return r.rent.credit;
      case 'marriage': return r.marriage.amount;
      case 'sme': return r.sme ? r.sme.amount : 0;
      case 'personal': return r.personal.total;
    }
    return 0;
  }
  /*
   * 공제 관리 화면의 항목별 예상 세제혜택: 그 항목만 뺐을 때 늘어나는 세금(소득세+지방세).
   * 각 항목을 나머지가 모두 있는 상태에서 뺀 값이라 항목 합이 전체와 다를 수 있다(표준세액공제 전환·결정세액 한도 때문).
   * 근로소득·표준·자녀 세액공제처럼 뺄 수 없는 자동 항목은 적용액 × (1 + 지방세율) 추정.
   */
  var SAVING_CATS = {
    HOUSING: ['HOUSING_SUBSCRIPTION', 'RENT_LOAN', 'MORTGAGE_INTEREST'], INSURANCE: ['INSURANCE', 'INSURANCE_DISABLED'], MEDICAL: ['MEDICAL'], EDUCATION: ['EDUCATION'],
    POLITICAL: ['DONATION_POLITICAL'], HOMETOWN: ['DONATION_HOMETOWN'], RENT: ['RENT_CREDIT'], DONATION_SPECIAL_GENERAL: ['DONATION_SPECIAL', 'DONATION_GENERAL', 'DONATION_RELIGIOUS'],
    PENSION_ACCOUNT: ['PENSION_SAVING', 'IRP', 'ISA_CONVERSION']
  };
  function itemTaxSavings(state, rules) {
    var base = calc(state, rules); if (base.blocked) return {};
    function diff(st) { return Math.max(0, calc(st, rules).totalTax - base.totalTax); }
    function without(cats) {
      return diff(Object.assign({}, state, {
        deductions: (state.deductions || []).filter(function (d) { return cats.indexOf(d.category) < 0; }),
        expenses: (state.expenses || []).map(function (e) { return (e.deductionTags || []).some(function (t) { return cats.indexOf(t) >= 0; }) ? Object.assign({}, e, { deductionTags: e.deductionTags.filter(function (t) { return cats.indexOf(t) < 0; }) }) : e; })
      }));
    }
    function zeroPremiums(keys) {
      var pay = {}; Object.keys(state.payroll || {}).forEach(function (ym) { var m = state.payroll[ym], pr = Object.assign({}, m.premiums || {}); keys.forEach(function (k) { pr[k] = { amount: 0, source: 'MANUAL', status: 'OK' }; }); pay[ym] = Object.assign({}, m, { premiums: pr }); });
      return diff(Object.assign({}, state, { payroll: pay }));
    }
    function withSelf(patch) { return diff(Object.assign({}, state, { profile: Object.assign({}, state.profile, { selfConditions: Object.assign({}, state.profile.selfConditions, patch) }) })); }
    var out = {};
    Object.keys(SAVING_CATS).forEach(function (k) { out[k] = without(SAVING_CATS[k]); });
    out.PERSONAL_FAMILY = diff(Object.assign({}, state, { family: [] }));
    out.PENSION_PREMIUM = zeroPremiums(['nationalPension']);
    out.INSURANCE_PREMIUM = zeroPremiums(['healthInsurance', 'longTermCare', 'employmentInsurance']);
    out.CARD = diff(Object.assign({}, state, { expenses: (state.expenses || []).map(function (e) { return Object.assign({}, e, { useCategory: 'EXCLUDED' }); }) }));
    out.MARRIAGE = withSelf({ marriageRegisteredYear: null });
    out.SME = withSelf({ smeEmployment: null });
    var lr = 1 + rules.localIncomeTax.rate;
    (base.credits || []).forEach(function (c) { if (['EARNED_INCOME', 'STANDARD', 'CHILD'].indexOf(c.key) >= 0) out[c.key] = Math.round(c.applied * lr); });
    return out;
  }

  // 가족 한 명을 더했을 때 인적공제가 어떤 항목으로 바뀌었는지(기본·경로우대·장애인·부녀자·한부모). 배우자를 더하면 한부모가 빠지는 것처럼 음수도 있다.
  var PERSONAL_LABELS = { basic: '기본공제', senior: '경로우대', disabled: '장애인', woman: '부녀자', singleParent: '한부모' };
  function personalBreakdown(after, before) {
    var a = after.personal.amounts, b = before.personal.amounts;
    return Object.keys(PERSONAL_LABELS).map(function (k) { return { key: k, label: PERSONAL_LABELS[k], amount: (a[k] || 0) - (b[k] || 0) }; }).filter(function (x) { return x.amount !== 0; });
  }
  // 설계 항목별로 실제 입력된 연간 금액(귀속연도). 의료비·교육비는 대상 구분(meta)으로 나눈다
  function designActualAmounts(state, rules) {
    var inp = collectDeductionInputs(state), out = {};
    function sum(cat, pred) { return (inp[cat] || []).filter(function (e) { return !pred || pred(e.meta || {}); }).reduce(function (a, e) { return a + num(e.amount); }, 0); }
    out.PENSION_SAVING = sum('PENSION_SAVING'); out.IRP = sum('IRP'); out.ISA = sum('ISA_CONVERSION'); out.SUBSCRIPTION = sum('HOUSING_SUBSCRIPTION');
    out.INSURANCE = sum('INSURANCE'); out.INSURANCE_DISABLED = sum('INSURANCE_DISABLED');
    out.MED_GLASSES = sum('MEDICAL', function (m) { return m.kind === 'GLASSES'; });
    out.MED_SELF = sum('MEDICAL', function (m) { return m.kind !== 'GLASSES' && (m.group === 'UNLIMITED' || m.group === 'PREMATURE'); });
    out.MED_GENERAL = sum('MEDICAL', function (m) { return m.kind !== 'GLASSES' && (!m.group || m.group === 'GENERAL'); });
    out.MED_INFERTILITY = sum('MEDICAL', function (m) { return m.kind !== 'GLASSES' && m.group === 'INFERTILITY'; });
    out.EDU_SELF = sum('EDUCATION', function (m) { return m.level === 'SELF' || m.level === 'DISABLED_SPECIAL'; });
    out.EDU_PRESCHOOL = sum('EDUCATION', function (m) { return m.level === 'PRESCHOOL'; });
    out.EDU_SCHOOL = sum('EDUCATION', function (m) { return !m.level || m.level === 'SCHOOL'; });
    out.EDU_UNIV = sum('EDUCATION', function (m) { return m.level === 'UNIVERSITY'; });
    var home = sum('DONATION_HOMETOWN'), low = rules.donation.hometown.lowCap;
    out.DON_HOMETOWN = Math.min(home, low); out.DON_HOMETOWN_MORE = Math.max(0, home - low);
    out.DON_POLITICAL = sum('DONATION_POLITICAL'); out.DON_SPECIAL = sum('DONATION_SPECIAL'); out.DON_GENERAL = sum('DONATION_GENERAL'); out.DON_RELIGIOUS = sum('DONATION_RELIGIOUS');
    out.RENT = sum('RENT_CREDIT'); out.RENT_LOAN = sum('RENT_LOAN'); out.MORTGAGE = sum('MORTGAGE_INTEREST');
    return out;
  }
  function buildTaxDesign(state, rules, scenario) {
    scenario = scenario || {};
    var g = grossFromState(state);
    if (g.gross === null) return { available: false, missing: g.missing };
    var gross = g.gross, year = state.profile.year, range = employmentRange(state.profile);
    // 급여 입력이 없으면 4대보험 공제를 월할 추정치로 채운다(설계값이 과대해지지 않게)
    var payroll = state.payroll || {}, hasPay = Object.keys(payroll).some(function (k) { return k.slice(0, 4) === String(year); });
    if (!hasPay) {
      var months = monthsInRange(range), mg = fl(gross / months.length), mn = fl(num(state.profile.expectedNonTaxable) / months.length);
      payroll = {}; months.forEach(function (ym) { payroll[ym] = { yearMonth: ym, gross: mg, nonTaxable: mn, status: 'FORECAST', premiums: mergePremiums(null, estimatePremiums(ym, mg, mn, rules)) }; });
    }
    var sc0 = state.profile.selfConditions || {};
    var homeless = scenario.homelessHead === undefined ? (sc0.isHomeless === true && sc0.isHouseholdHead === true) : !!scenario.homelessHead;
    var baseProfile = Object.assign({}, state.profile, {
      mortgageCapKey: scenario.mortgageCapKey || state.profile.mortgageCapKey || rules.housing.mortgageInterest.capOptions[0].key,
      selfConditions: Object.assign({}, sc0, { isHomeless: homeless, isHouseholdHead: homeless || sc0.isHouseholdHead, marriageRegisteredYear: null, smeEmployment: null })
    });
    var smeCat = scenario.smeCategory || 'YOUTH';
    function build(parts) {
      var prof = Object.assign({}, baseProfile, { selfConditions: Object.assign({}, baseProfile.selfConditions) });
      if (parts.marriage) prof.selfConditions.marriageRegisteredYear = year;
      if (parts.sme) prof.selfConditions.smeEmployment = { category: smeCat, employedAt: scenario.smeEmployedAt || (year + '-01-01') };
      var st = Object.assign({}, state, { profile: prof, family: parts.family, deductions: parts.entries, expenses: [], recurring: [], payroll: payroll });
      return calc(st, rules, { extraExpenses: parts.extras });
    }
    function clone(p) { return { family: p.family.slice(), entries: p.entries.slice(), extras: p.extras.slice(), marriage: p.marriage, sme: p.sme }; }
    function add(p, part) {
      var q = clone(p);
      if (part.family) q.family = q.family.concat(part.family);
      if (part.entries) q.entries = q.entries.concat(part.entries);
      if (part.extras) q.extras = q.extras.concat(part.extras);
      if (part.profile && part.profile.marriageRegisteredYear) q.marriage = true;
      if (part.sme) q.sme = true;
      return q;
    }
    var cur = { family: [], entries: [], extras: [], marriage: false, sme: false };
    var base = build(cur), prevTax = base.totalTax, prevR = base;
    // 1) 부양가족: 실제 가족(제외 선택 가능) + 가상 추가
    var famOn = scenario.family || {};
    var members = (state.family || []).map(function (m) { return { m: m, virtual: false, on: famOn[m.id] !== false }; })
      .concat((scenario.extraFamily || []).map(function (m) { return { m: Object.assign({ incomeUnderLimit: true }, m), virtual: true, on: m.on !== false }; }));
    var famRows = members.map(function (x) {
      var row = { key: 'FAM-' + x.m.id, id: x.m.id, group: 'FAMILY', label: (x.m.alias || '') , relation: x.m.relation, birthYear: x.m.birthYear, virtual: x.virtual, on: x.on, type: '소득공제', member: x.m };
      var flag = deriveFamilyFlags(x.m, baseProfile, rules);
      row.flag = flag;
      if (x.on) {
        var nxt = add(cur, { family: [x.m] }), r = build(nxt);
        row.deduction = Math.max(0, designMetric(r, 'personal') - designMetric(prevR, 'personal'));
        row.breakdown = personalBreakdown(r, prevR);
        row.creditNote = (r.child.credit + r.child.birthAdoption) - (prevR.child.credit + prevR.child.birthAdoption);
        row.saving = Math.max(0, prevTax - r.totalTax); cur = nxt; prevTax = r.totalTax; prevR = r;
      }
      return row;
    });
    // 2) 항목
    var catalog = designCatalog(gross, rules, year), sel = scenario.items || {};
    var actual = designActualAmounts(state, rules);
    var capOpt = rules.housing.mortgageInterest.capOptions.filter(function (o) { return o.key === baseProfile.mortgageCapKey; })[0];
    var rows = catalog.map(function (it) {
      var s = sel[it.key] || {};
      // 실제로 입력한 공제(공제 관리·고정지출·지출 태그)가 있으면 그 금액으로 시작하고 체크한다. 사용자가 설계에서 바꾸면 그 값을 우선
      var act = actual[it.key] || 0;
      var defOn = act > 0 ? true : it.on, defAmt = act > 0 ? act : it.amount;
      var row = Object.assign({}, it, { on: s.on === undefined ? defOn : !!s.on, amount: s.amount === undefined || s.amount === null ? defAmt : num(s.amount), actual: act, fromActual: act > 0 && (s.amount === undefined || s.amount === null) });
      if (row.fromActual) row.example = false;
      if (it.key === 'MORTGAGE' && capOpt) row.cap = won0(capOpt.cap) + '(' + capOpt.label + ')';
      if (row.na) row.on = false;
      // 무주택 세대주 조건을 고르지 않으면 체크를 빼고 잠근다(혜택 0인데 납입액만 합계에 들어가지 않게)
      if (row.needsHomeless && !homeless) { row.on = false; row.locked = true; row.blockedReason = '"무주택 세대주"에 체크하면 선택할 수 있습니다'; }
      return row;
    });
    rows.forEach(function (row) {
      if (!row.on) return;
      var nxt = add(cur, designItemParts(row, row.amount, year)), r = build(nxt);
      row.deduction = Math.max(0, designMetric(r, row.metric) - designMetric(prevR, row.metric));
      row.saving = Math.max(0, prevTax - r.totalTax); cur = nxt; prevTax = r.totalTax; prevR = r;
    });
    var finalR = prevR;
    // 3) 선택 안 한 항목: 최종 상태에 하나만 더했을 때 추가로 줄어드는 세금
    rows.concat(famRows).forEach(function (row) {
      if (row.on || row.na || row.locked) return;
      var part = row.group === 'FAMILY' ? { family: [row.member] } : designItemParts(row, row.amount, year);
      var r = build(add(cur, part));
      row.potential = Math.max(0, finalR.totalTax - r.totalTax);
      row.potentialDeduction = Math.max(0, designMetric(r, row.group === 'FAMILY' ? 'personal' : row.metric) - designMetric(finalR, row.group === 'FAMILY' ? 'personal' : row.metric));
      if (row.group === 'FAMILY') row.breakdown = personalBreakdown(r, finalR);
    });
    var groups = DESIGN_GROUPS.map(function (gr) {
      var items = gr.key === 'FAMILY' ? famRows : rows.filter(function (r) { return r.group === gr.key; });
      var on = items.filter(function (r) { return r.on; });
      return { key: gr.key, label: gr.label, type: gr.type, items: items, saving: on.reduce(function (s, r) { return s + (r.saving || 0); }, 0), use: on.reduce(function (s, r) { return s + (r.toggleOnly || r.group === 'FAMILY' ? 0 : num(r.amount)); }, 0) };
    });
    var all = rows.concat(famRows).filter(function (r) { return r.on; });
    return {
      available: true, gross: gross, year: year, homelessHead: homeless, estimatedPayroll: !hasPay,
      baseline: base, final: finalR, baselineTax: base.totalTax, finalTax: finalR.totalTax,
      totalSaving: Math.max(0, base.totalTax - finalR.totalTax), totalUse: groups.reduce(function (s, gr) { return s + gr.use; }, 0),
      selectedCount: all.length, groups: groups, taxExhausted: finalR.determinedTax === 0,
      mortgageCapKey: baseProfile.mortgageCapKey, smeCategory: smeCat
    };
  }
  function pctText(x) { return (Math.round(x * 1000) / 10) + '%'; }
  function won0(n) { return n >= 10000 && n % 10000 === 0 ? (n / 10000).toLocaleString('ko-KR') + '만원' : Math.round(n).toLocaleString('ko-KR') + '원'; }

  return {
    calc: calc, calcWithExtra: calcWithExtra, computeCard: computeCard, deriveFamilyFlags: deriveFamilyFlags, derivePersonal: derivePersonal,
    estimatePremiums: estimatePremiums, mergePremiums: mergePremiums, grossFromState: grossFromState, employmentRange: employmentRange, monthsInRange: monthsInRange,
    earnedIncomeDeduction: earnedIncomeDeduction, calculatedTax: calculatedTax, earnedIncomeTaxCredit: earnedIncomeTaxCredit,
    medicalCredit: medicalCredit, educationCredit: educationCredit, donationCredits: donationCredits, pensionCredit: pensionCredit, rentCredit: rentCredit,
    collectDeductionInputs: collectDeductionInputs, buildOptimalPlan: buildOptimalPlan, buildPlanSummary: buildPlanSummary, buildTaxDesign: buildTaxDesign, itemTaxSavings: itemTaxSavings, DESIGN_GROUPS: DESIGN_GROUPS, mkExtra: mkExtra, classifyExpense: classifyExpense
  };
});
