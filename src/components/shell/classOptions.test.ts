// The class chips of the filter panel and the legend, with the
// names a dataset's source file gave its classes (metadata `classNames`).
import { describe, it, expect } from 'vitest';
import { CLASS_OPTIONS, classOptionsFor } from './FiltersPanel';
import { classColorIn } from '../../three/palette';

describe('class options', () => {
  it('are the ASPRS list when the file named nothing', () => {
    expect(classOptionsFor(undefined)).toBe(CLASS_OPTIONS);
  });

  it('take the file\'s names, and add a chip for a class not in the list', () => {
    const opts = classOptionsFor({ '2': 'Bare earth', '64': 'Stem', '65': 'Branch' });
    expect(opts.find(o => o.code === 2)?.label).toBe('Bare earth');
    expect(opts.find(o => o.code === 2)?.swatch).toBe(CLASS_OPTIONS.find(o => o.code === 2)?.swatch);
    expect(opts.find(o => o.code === 9)?.label).toBe('Water');
    const stem = opts.find(o => o.code === 64);
    expect(stem?.label).toBe('Stem');
    expect(stem?.swatch).toBe(`rgb(${classColorIn(64, [2, 64, 65]).join(',')})`);
    expect(opts.map(o => o.code).slice(-2)).toEqual([64, 65]);
    expect(opts.length).toBe(CLASS_OPTIONS.length + 2);
  });
});
