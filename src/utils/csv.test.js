import { csvCell, exportCSV } from './csv';
import { describe, it, expect } from 'vitest';

describe('CSV Export Utilities', () => {
  describe('csvCell()', () => {
    it('escapes standard formula injection vectors (=, +, -, @)', () => {
      expect(csvCell('=SUM(A1:A2)')).toBe(`"'=SUM(A1:A2)"`);
      expect(csvCell('+cmd|/C calc!A0')).toBe(`"'+cmd|/C calc!A0"`);
      expect(csvCell('-1+1+cmd')).toBe(`"'-1+1+cmd"`);
      expect(csvCell('@SUM(1,2)')).toBe(`"'@SUM(1,2)"`);
    });

    it('escapes formula chars with leading tab/CR/LF/space', () => {
      expect(csvCell(' \t\n\r=SUM(A1:A2)')).toBe(`"' \t\n\r=SUM(A1:A2)"`);
    });

    it('handles embedded commas, quotes, and newlines', () => {
      expect(csvCell('Hello, World')).toBe(`"Hello, World"`);
      expect(csvCell('John "Pro" Doe')).toBe(`"John ""Pro"" Doe"`);
      expect(csvCell('Line 1\nLine 2')).toBe(`"Line 1\nLine 2"`);
    });

    it('handles arrays safely', () => {
      expect(csvCell(['a', 'b', null, 'c'])).toBe(`"a, b, , c"`);
    });

    it('handles null, undefined, and NaN gracefully', () => {
      expect(csvCell(null)).toBe(`""`);
      expect(csvCell(undefined)).toBe(`""`);
      expect(csvCell(NaN)).toBe(`""`);
    });

    it('handles valid and invalid Dates', () => {
      const validDate = new Date('2024-01-01T00:00:00.000Z');
      expect(csvCell(validDate)).toBe(`"2024-01-01T00:00:00.000Z"`);

      const invalidDate = new Date('invalid');
      expect(csvCell(invalidDate)).toBe(`""`);
    });

    it('allows valid negative numbers without text-escaping', () => {
      expect(csvCell(-42)).toBe(`"-42"`);
      expect(csvCell(0)).toBe(`"0"`);
    });

    it('handles wrapped quotes alongside arithmetic formula threats safely', () => {
      expect(csvCell('="Payload"')).toBe('"\'=""Payload"""');
    });
  });

  describe('exportCSV()', () => {
    const headers = ['name', 'score'];

    it('produces a header-only CSV when dataset is empty', () => {
      const csv = exportCSV([], headers);
      expect(csv).toContain('\uFEFF"name","score"');
      expect(csv.split('\r\n').length).toBe(1);
    });

    it('generates proper rows when data is provided', () => {
      const devs = [
        { name: 'Alice', score: 100 },
        { name: '=SUM()', score: -5 }
      ];
      const csv = exportCSV(devs, headers);
      const lines = csv.split('\r\n');
      expect(lines[0]).toBe('\uFEFF"name","score"');
      expect(lines[1]).toBe(`"Alice","100"`);
      expect(lines[2]).toBe(`"'=SUM()","-5"`);
    });
  });
});