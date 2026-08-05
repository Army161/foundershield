import { describe, expect, it } from 'vitest';
import {
  PLANS,
  PLAN_ORDER,
  canAddDomain,
  effectivePlanId,
  estimateRequests,
  getPlan,
  lowestPlanWith,
  planAllows,
} from './plans';

describe('plan catalogue', () => {
  it('prices ascend with the tier order', () => {
    const prices = PLAN_ORDER.map((id) => PLANS[id].monthlyPrice);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('matches the prices the business model calls for', () => {
    expect([PLANS.solo, PLANS.indie, PLANS.studio, PLANS.agency].map((p) => p.monthlyPrice)).toEqual([20, 50, 150, 300]);
  });

  it('never removes a feature as you go up a tier', () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lower = PLANS[PLAN_ORDER[i - 1]!];
      const higher = PLANS[PLAN_ORDER[i]!];
      for (const feature of lower.features) {
        expect(higher.features, `${higher.id} should keep ${feature} from ${lower.id}`).toContain(feature);
      }
      expect(higher.domains).toBeGreaterThanOrEqual(lower.domains);
      expect(higher.retentionDays).toBeGreaterThanOrEqual(lower.retentionDays);
    }
  });

  it('gives the free plan a real, usable domain', () => {
    expect(PLANS.free.domains).toBeGreaterThanOrEqual(1);
    expect(PLANS.free.retentionDays).toBeGreaterThan(0);
  });

  it('never paywalls anything that keeps a live site standing up', () => {
    // Verification, bot scoring, rate limiting and monitor/standard modes are
    // universal by construction: they are not expressible as plan features, so
    // there is no way to accidentally gate them.
    const gateable = new Set(PLAN_ORDER.flatMap((id) => PLANS[id].features));
    expect(gateable.has('strict-mode')).toBe(true);
    for (const forbidden of ['browser-verification', 'bot-scoring', 'rate-limiting']) {
      expect([...gateable]).not.toContain(forbidden);
    }
  });
});

describe('getPlan', () => {
  it('falls back to free for anything unrecognised', () => {
    expect(getPlan(undefined).id).toBe('free');
    expect(getPlan(null).id).toBe('free');
    expect(getPlan('enterprise-deluxe').id).toBe('free');
    expect(getPlan(42).id).toBe('free');
  });
});

describe('effectivePlanId', () => {
  it('honours an active subscription', () => {
    expect(effectivePlanId({ plan_id: 'indie', status: 'active' })).toBe('indie');
  });

  it('honours a trial', () => {
    expect(effectivePlanId({ plan_id: 'studio', status: 'trialing' })).toBe('studio');
  });

  it('keeps the plan while payment is being retried', () => {
    // A failed card must not silently strip a customer's protection settings.
    expect(effectivePlanId({ plan_id: 'studio', status: 'past_due' })).toBe('studio');
  });

  it('drops to free once actually cancelled', () => {
    expect(effectivePlanId({ plan_id: 'agency', status: 'canceled' })).toBe('free');
    expect(effectivePlanId({ plan_id: 'agency', status: 'incomplete_expired' })).toBe('free');
    expect(effectivePlanId({ plan_id: 'agency', status: 'unpaid' })).toBe('free');
  });

  it('drops to free with no subscription at all', () => {
    expect(effectivePlanId(null)).toBe('free');
    expect(effectivePlanId(undefined)).toBe('free');
  });

  it('drops to free when the stored plan id is nonsense', () => {
    expect(effectivePlanId({ plan_id: 'legacy-gold', status: 'active' })).toBe('free');
  });
});

describe('feature gating', () => {
  it('reports what each plan allows', () => {
    expect(planAllows('free', 'agreements')).toBe(false);
    expect(planAllows('solo', 'strict-mode')).toBe(true);
    expect(planAllows('solo', 'evidence-seals')).toBe(false);
    expect(planAllows('indie', 'evidence-seals')).toBe(true);
    expect(planAllows('studio', 'agreements')).toBe(true);
    expect(planAllows('agency', 'priority-support')).toBe(true);
  });

  it('names the cheapest plan that unlocks a feature', () => {
    expect(lowestPlanWith('strict-mode')?.id).toBe('solo');
    expect(lowestPlanWith('evidence-report')?.id).toBe('indie');
    expect(lowestPlanWith('agreements')?.id).toBe('studio');
    expect(lowestPlanWith('priority-support')?.id).toBe('agency');
  });
});

describe('canAddDomain', () => {
  it('allows up to the plan limit and no further', () => {
    expect(canAddDomain('free', 0)).toBe(true);
    expect(canAddDomain('free', 1)).toBe(false);
    expect(canAddDomain('indie', 2)).toBe(true);
    expect(canAddDomain('indie', 3)).toBe(false);
  });

  it('treats an unknown plan as free rather than unlimited', () => {
    expect(canAddDomain('nonsense', 1)).toBe(false);
  });
});

describe('estimateRequests', () => {
  it('scales sampled allowed traffic back up', () => {
    const result = estimateRequests({ blocked: 100, challenged: 50, allowedSampled: 20, sampleRate: 0.02 });
    expect(result.estimate).toBe(1150); // 150 enforced + 20/0.02
    expect(result.exact).toBe(false);
  });

  it('is exact when nothing was sampled away', () => {
    const result = estimateRequests({ blocked: 10, challenged: 5, allowedSampled: 985, sampleRate: 1 });
    expect(result).toEqual({ estimate: 1000, exact: true });
  });

  it('counts only enforced requests when allowed logging is off', () => {
    const result = estimateRequests({ blocked: 40, challenged: 2, allowedSampled: 0, sampleRate: 0 });
    expect(result).toEqual({ estimate: 42, exact: false });
  });

  it('never reports an exact figure it cannot support', () => {
    for (const sampleRate of [0, 0.01, 0.5, 0.99]) {
      expect(estimateRequests({ blocked: 1, challenged: 1, allowedSampled: 1, sampleRate }).exact).toBe(false);
    }
  });
});
