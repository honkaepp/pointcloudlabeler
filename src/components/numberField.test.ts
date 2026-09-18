// The parsers behind every numeric parameter field in the app.
//
// They exist because the obvious alternative — parseFloat on every
// keystroke, number in state — produces a field that looks editable
// and is not: clearing it snaps back, a lone minus sign is NaN so a
// negative default can never be retyped, and "0." is NaN so no decimal
// can be entered from the left. Both panels that expose algorithm
// parameters (Point QC, Co-registration) hold text and parse once, and
// these are the cases that made that necessary.

import { describe, it, expect } from 'vitest';
import { parseNum, parseCount } from './NumberField';

describe('parseNum', () => {
  it('reads ordinary numbers, including negatives and exponents', () => {
    expect(parseNum('12', 0)).toBe(12);
    expect(parseNum('-20', 0)).toBe(-20);
    expect(parseNum('0.125', 0)).toBe(0.125);
    expect(parseNum('1e-6', 0)).toBe(1e-6);
    expect(parseNum(' 2.5 ', 0)).toBe(2.5);
  });

  it('falls back on the states a field passes through while being typed', () => {
    // Each of these is what the input holds mid-edit. A per-keystroke
    // parser would write the fallback into state here and undo the
    // user's typing; parsing once at submit means they only matter if
    // the user actually leaves the field like this.
    expect(parseNum('', 7)).toBe(7);
    expect(parseNum('-', 7)).toBe(7);
    expect(parseNum('.', 7)).toBe(7);
    expect(parseNum('abc', 7)).toBe(7);
    // A half-typed exponent is the sharp one: `parseFloat('1e')` is 1,
    // so the loose parser would submit a value three orders of
    // magnitude off the intended 1e-6 with the field showing "1e" and
    // nothing amiss. `Number` takes the whole string or none of it.
    expect(parseNum('1e', 7)).toBe(7);
    expect(parseNum('0.5 m', 7)).toBe(7);
    expect(parseNum('12abc', 7)).toBe(7);
    // …and a decimal point being typed reads as the zero it is, so the
    // field does not fight the user on the way to "0.125".
    expect(parseNum('0.', 7)).toBe(0);
  });

  it('refuses the non-finite values a number field can produce', () => {
    expect(parseNum('Infinity', 3)).toBe(3);
    expect(parseNum('-Infinity', 3)).toBe(3);
    expect(parseNum('NaN', 3)).toBe(3);
  });

  it('keeps a real zero, which a truthiness check would lose', () => {
    // `parseFloat(t) || fallback` is the tempting one-liner and it
    // turns "0" into the default — wrong for every parameter where 0
    // means "off", such as the plane extractor's max size.
    expect(parseNum('0', 5)).toBe(0);
    expect(parseNum('0.0', 5)).toBe(0);
  });
});

describe('parseCount', () => {
  it('rounds and holds a floor', () => {
    expect(parseCount('8', 1)).toBe(8);
    expect(parseCount('8.6', 1)).toBe(9);
    expect(parseCount('0', 3)).toBe(1);
    expect(parseCount('-5', 3)).toBe(1);
    expect(parseCount('', 3)).toBe(3);
  });

  it('takes a floor of zero when zero is a real choice', () => {
    expect(parseCount('0', 3, 0)).toBe(0);
    expect(parseCount('-1', 3, 0)).toBe(0);
  });
});
