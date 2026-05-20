// Node.js Unit Test Runner for World Cup Monitor Pricing & Matching Logic

import assert from 'assert';
import { 
    getFaceValue, 
    getStageWeight, 
    getTeamDemandWeight, 
    getLocationWeight, 
    getFamilyPenalty, 
    getTargetPrice, 
    getDecision, 
    computeConfidenceScore, 
    detectAnomalies 
} from '../js/pricing.js';

import { matchByDateAndTeams } from '../js/matching.js';

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

// -------------------------------------------------------------
// Test Suite: Pricing Math & Stages
// -------------------------------------------------------------
test('getFaceValue returns correct base prices', () => {
    assert.strictEqual(getFaceValue('Group Stage'), 175);
    assert.strictEqual(getFaceValue('Round of 16'), 175);
    assert.strictEqual(getFaceValue('Quarterfinals'), 250);
    assert.strictEqual(getFaceValue('Semifinals'), 400);
    assert.strictEqual(getFaceValue('Final'), 600);
});

test('getStageWeight returns correct multipliers', () => {
    assert.strictEqual(getStageWeight('Group Stage'), 1.0);
    assert.strictEqual(getStageWeight('Quarterfinals'), 1.5);
    assert.strictEqual(getStageWeight('Semifinals'), 2.0);
    assert.strictEqual(getStageWeight('Final'), 2.5);
});

test('getTeamDemandWeight triggers on high demand countries', () => {
    assert.strictEqual(getTeamDemandWeight('USA vs Germany'), 1.6); // 2 strong teams
    assert.strictEqual(getTeamDemandWeight('Argentina vs Peru'), 1.3); // 1 strong team
    assert.strictEqual(getTeamDemandWeight('Ghana vs Ecuador'), 1.0); // 0 strong teams
});

test('getLocationWeight adjusts targets by base city', () => {
    const preferences = { homeBaseCity: 'New York / New Jersey' };
    
    // Local city (NY/NJ)
    assert.strictEqual(getLocationWeight('New York / New Jersey', preferences), 1.20);
    // Driveable city (Philadelphia, PA)
    assert.strictEqual(getLocationWeight('Philadelphia, PA', preferences), 1.15);
    // Flight city (Seattle, WA)
    assert.strictEqual(getLocationWeight('Seattle, WA', preferences), 0.85);
});

test('getFamilyPenalty triggers penalty multiplier on late evening games', () => {
    const preferences = { avoidLateGames: true };
    const lateRow = { date_time: 'Thu, Jun 11 · 9:00pm' };
    const earlyRow = { date_time: 'Thu, Jun 11 · 2:00pm' };
    
    assert.strictEqual(getFamilyPenalty(lateRow, preferences), 0.85);
    assert.strictEqual(getFamilyPenalty(earlyRow, preferences), 1.0);
    
    // When disabled, no penalty
    const disabledPrefs = { avoidLateGames: false };
    assert.strictEqual(getFamilyPenalty(lateRow, disabledPrefs), 1.0);
});

test('getTargetPrice matches target thresholds', () => {
    const row = {
        stage: 'Group Stage',
        match: 'USA vs England',
        host_city: 'New York / New Jersey',
        date_time: 'Thu, Jun 11 · 2:00pm' // early
    };
    const preferences = {
        homeBaseCity: 'New York / New Jersey',
        avoidLateGames: true,
        strongTeamPremiumTolerance: 'medium'
    };
    
    const faceVal = getFaceValue(row.stage); // 175
    // target price for group stage knockout/strong with currentPrice = 600
    // is min(600 * 0.85 * 1.20 * 1.0, 175 * 6 * 1.20 * 1.0) = min(612, 1260) = 612
    const target = getTargetPrice(row, 600, faceVal, preferences);
    assert.ok(target > 500 && target < 650);
});

// -------------------------------------------------------------
// Test Suite: Decision Triggers
// -------------------------------------------------------------
test('getDecision triggers correct signals', () => {
    // Current price is at or below target -> Buy
    assert.strictEqual(getDecision(200, 220, 'Stable'), 'Buy');
    // Current price is 10% above target, but trend is Declining -> Wait
    assert.strictEqual(getDecision(220, 200, 'Declining'), 'Wait');
    // Current price is 10% above target, trend is Stable -> Watch
    assert.strictEqual(getDecision(220, 200, 'Stable'), 'Watch');
    // Current price is 60% above target -> Avoid
    assert.strictEqual(getDecision(350, 200, 'Stable'), 'Avoid');
});

// -------------------------------------------------------------
// Test Suite: Confidence & Anomalies
// -------------------------------------------------------------
test('computeConfidenceScore evaluates metrics correct', () => {
    // High coverage, fresh data, long history
    const row = {
        sg_price: 200,
        tp_price: 210,
        vs_price: 195,
        latest_observed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h old
        mapping_metadata: { mappingMethod: 'Datetime' }
    };
    const history = Array(12).fill(0).map((_, i) => ({ t: new Date(Date.now() - i * 3600000), price: 200 }));
    
    const confidence = computeConfidenceScore(row, history);
    assert.strictEqual(confidence.label, 'High');
    assert.ok(confidence.score >= 80);
});

test('detectAnomalies detects bargain drops', () => {
    const row = {
        agg_lowest_price: 100, // Very cheap
        sg_price: 100,
        tp_price: 250,
        vs_price: 260
    };
    // 7-day average was 300
    const history = [
        { t: new Date(Date.now() - 24 * 3600000), price: 300 },
        { t: new Date(Date.now() - 48 * 3600000), price: 310 },
        { t: new Date(Date.now() - 72 * 3600000), price: 290 }
    ];
    
    const anomalies = detectAnomalies(row, history);
    // Bargain: 100 <= 300 * 0.70 (true)
    // Outlier: 100 <= 250 * 0.75 (true)
    assert.ok(anomalies.includes('Bargain'));
    assert.ok(anomalies.includes('Outlier'));
});

// -------------------------------------------------------------
// Test Suite: Matching Feeds
// -------------------------------------------------------------
test('matchByDateAndTeams maps event aliases correctly', () => {
    const sgRow = {
        date_time: 'Thu, Jun 11 · 2:00pm',
        match: 'USA vs South Korea',
        venue: 'MetLife Stadium'
    };
    const externalSnapshot = [
        {
            start_date: '2026-06-11T14:00:00', // matches Jun 11, 2:00pm
            name: 'United States vs Korea Republic', // alias variation
            venue: 'MetLife Stadium',
            tickpick_event_id: 998877
        }
    ];
    const teamAliases = [
        ['unitedstates', 'USA'],
        ['korearepublic', 'South Korea'],
        ['southkorea', 'South Korea'],
        ['usmnt', 'USA'],
        ['usa', 'USA'],
        ['us', 'USA']
    ];
    
    const matched = matchByDateAndTeams(sgRow, externalSnapshot, 'name', 'venue', teamAliases);
    assert.ok(matched);
    assert.strictEqual(matched.matchedRow.tickpick_event_id, 998877);
    assert.strictEqual(matched.confidence, 'High');
    assert.strictEqual(matched.method, 'Teams');
});

// -------------------------------------------------------------
// Run Tests Execution
// -------------------------------------------------------------
let failed = 0;
console.log('Running World Cup Decision Console Unit Tests...');
console.log('================================================');

for (const t of tests) {
    try {
        t.fn();
        console.log(`✅ PASS: ${t.name}`);
    } catch (e) {
        console.error(`❌ FAIL: ${t.name}`);
        console.error(e);
        failed++;
    }
}

console.log('================================================');
if (failed > 0) {
    console.error(`Test run complete: ${failed} failed tests.`);
    process.exit(1);
} else {
    console.log(`Test run complete: All tests passed!`);
    process.exit(0);
}
