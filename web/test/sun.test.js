import assert from 'node:assert/strict';
import test from 'node:test';
import { daylightNote, sunset } from '../js/sun.js';

const near = (date, iso, minutes = 4) => assert.ok(Math.abs(date - new Date(iso)) <= minutes * 60_000, `${date.toISOString()} ≠ ${iso}`);

test('soleil : heures de coucher connues', () => {
  near(sunset([48.8566, 2.3522], new Date('2024-06-21T10:00:00Z')), '2024-06-21T19:58:00Z'); // Paris, solstice d'été
  near(sunset([48.8566, 2.3522], new Date('2024-12-21T10:00:00Z')), '2024-12-21T15:56:00Z'); // Paris, solstice d'hiver
  near(sunset([-33.87, 151.21], new Date('2024-06-21T02:00:00Z')), '2024-06-21T06:54:00Z'); // Sydney
  assert.equal(sunset([78.2, 15.6], new Date('2024-06-21T12:00:00Z')), null); // Svalbard : soleil de minuit
});

test('soleil : prévient si le retour se fait de nuit', () => {
  const paris = [48.8566, 2.3522];
  const afternoon = new Date('2024-12-21T14:00:00Z'); // coucher vers 15 h 56 UTC
  assert.equal(daylightNote(paris, 3600, afternoon).warn, false);
  const late = daylightNote(paris, 3 * 3600, afternoon);
  assert.equal(late.warn, true);
  assert.match(late.text, /min de nuit/);
  assert.match(daylightNote(paris, 600, new Date('2024-12-21T18:00:00Z')).text, /Soleil couché/);
});
