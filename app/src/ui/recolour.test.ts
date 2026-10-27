import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navScheduleXml, navTeamXml, calendarXml, clockXml, navSettingsXml, navSwapsXml } from './icons/figmaIcons';
import { recolour } from './recolour';

test('recolour changes every stroke colour and nothing else', () => {
  const svg = '<svg width="24" height="24"><path d="M1 1" stroke="#152E2B" stroke-width="2"/><path d="M2 2" stroke="#586d68"/></svg>';
  assert.equal(recolour(svg, '#ffffff'), '<svg width="24" height="24"><path d="M1 1" stroke="#ffffff" stroke-width="2"/><path d="M2 2" stroke="#ffffff"/></svg>');
});

test('the six schedule icons are 24 x 24 SVGs whose strokes can all be recoloured (no baked colour is left behind)', () => {
  for (const xml of [navScheduleXml, navTeamXml, navSwapsXml, navSettingsXml, calendarXml, clockXml]) {
    assert.match(xml, /width="24"/);
    assert.match(xml, /height="24"/);
    const after = recolour(xml, '#abcdef');
    assert.equal(/stroke="#(?!abcdef)[0-9A-Fa-f]{6}"/i.test(after), false, 'every stroke now carries the new colour');
    assert.ok(after.includes('stroke="#abcdef"'));
  }
});
