import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../assets/js/data.js';
import { analyzeZone } from '../assets/js/analytics.js';
import { riskCard, recommendationsMarkup, anomaliesMarkup } from '../assets/js/analytics-views.js';
import { zoneCards } from '../assets/js/views.js';

const state = () => createInitialState('2026-10-19T12:00:00.000Z');
test('risk card explains score, classification, coverage and factor weights', () => {
  const data = state(); data.sensors.find((s) => s.id === 'ZONE-01-S-waterLevel').value = 10;
  const html = riskCard(analyzeZone(data, 'ZONE-01'));
  assert.match(html, /30/); assert.match(html, /Critical/); assert.match(html, /6 \/ 6/); assert.match(html, /вод/);
});
test('incomplete and recovered models never render a false Low reassurance', () => {
  const data = state(); data.sensors[0].status = 'offline';
  assert.match(riskCard(analyzeZone(data, 'ZONE-01')), /Неполные данные/);
  const html = riskCard(analyzeZone(state(), 'ZONE-01', { issue: 'invalid-state' }));
  assert.doesNotMatch(html, /Low/); assert.match(html, /недоступна/);
});
test('recommendations and factors escape evidence, identify zone and remain informational', () => {
  const data = state(); data.sensors[0].value = 30;
  const result = analyzeZone(data, 'ZONE-01');
  result.factors[0].evidence.push('<img onerror=bad()>');
  result.recommendations[0].evidence = '<script>bad()</script>';
  assert.doesNotMatch(riskCard(result), /<img/); assert.match(riskCard(result), /&lt;img/);
  assert.doesNotMatch(recommendationsMarkup(result), /<script/); assert.match(recommendationsMarkup(result), /Tomatoes/);
  assert.match(recommendationsMarkup(result), /Перегрев/);
  assert.doesNotMatch(recommendationsMarkup(result), /temperature-high/);
  assert.match(anomaliesMarkup(result), /Недостаточно данных/);
});
test('shared zone cards show the same risk calculation and recovered-data quality', () => {
  const data = state(); data.sensors[0].value = 30;
  const html = zoneCards(data);
  assert.match(html, /25 \/ 100/); assert.match(html, /Moderate/); assert.doesNotMatch(html, /Не рассчитан/);
  assert.match(zoneCards(data, false, { issue: 'invalid-state' }), /Неполные данные/);
});
