import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The export option plumbing.
 *
 *  This is the second test that would have caught a real bug. The geoid
 *  option was collected in the export dialog, declared on the options
 *  type, and then never forwarded to `invoke` — the export module's own
 *  inline parameter type simply did not carry it. tsc is silent about a
 *  field that is merely absent (only an EXTRA property is an error), so
 *  the dialog would have offered "convert to orthometric", the export
 *  would have reported success, and the heights would have been
 *  unchanged.
 *
 *  It is asserted over the source rather than by calling the wrapper
 *  because the failure is a missing line, and a runtime call with a
 *  stubbed invoke would only prove what IS forwarded, never notice what
 *  was dropped on the way in. */
describe('cloud_export_octree_las option plumbing', () => {
  const bridge = readFileSync('src/persistence/desktopBridge.ts', 'utf8');
  const editorModule = readFileSync('src/modules/EditorModule.tsx', 'utf8');
  const dialog = readFileSync('src/components/OctreeExportDialog.tsx', 'utf8');

  /** Every option the dialog can produce, in the order the pipeline
   *  carries it: dialog → export module → bridge → invoke. Adding an
   *  option here without wiring all three fails the test, which is the
   *  point. */
  const OPTIONS = [
    'includeTreeId', 'includeSemantic',
    'includeStandingDeadwood', 'includeLayingDeadwood',
    'keepClassification', 'keepIntensity',
    'decimals', 'extrasToExport', 'filter', 'targetCrs', 'geoid', 'las14',
  ];

  const invokePayload = (() => {
    const start = bridge.indexOf("ctx.invoke<ExportReport>('cloud_export_octree_las'");
    expect(start, 'the export invoke must exist').toBeGreaterThan(-1);
    return bridge.slice(start, bridge.indexOf('}),', start));
  })();

  it.each(OPTIONS)('forwards %s all the way to invoke', (opt) => {
    expect(invokePayload, `desktopBridge drops ${opt} before invoke`).toContain(`${opt}: opts.${opt}`);
  });

  it.each(OPTIONS)('%s survives the export module\'s own parameter type', (opt) => {
    // The export module re-declares the option bag inline. A field
    // missing THERE is exactly how geoid was lost: the object literal
    // simply never mentioned it, and an absent field is not a type error.
    const sig = editorModule.slice(
      editorModule.indexOf('cloudExportOctreeLas?:'),
      editorModule.indexOf('=> Promise<number>;', editorModule.indexOf('cloudExportOctreeLas?:')),
    );
    expect(sig, `EditorModule's inline type omits ${opt}`).toContain(opt);
  });

  /** The export tells the caller what it left out.
   *
   *  A normalised export cannot give a point a height above ground when
   *  no ground surface reaches it. It used to substitute 0 for the
   *  missing DTM, which does not mean "unknown" — it writes the point's
   *  ABSOLUTE elevation into a file whose Z column claims to be a
   *  height, so a plot 150 m above the datum exported 150 m trees. LAS
   *  stores Z as a scaled integer and cannot hold a NaN, so those points
   *  are now left out — and a file quietly short of points is only half
   *  a fix, so the count comes back with it and both callers show it. */
  it('both export callers read the report rather than treating it as a number', () => {
    // This is asserted over the source because the failure is silent to
    // tsc: `ExportReport` is an object, and `toLocaleString()` exists on
    // every object, so the old `n.toLocaleString()` still type-checks and
    // would have rendered "[object Object]" into the success message.
    for (const [file, src] of [
      ['EditorModule', editorModule],
      ['GroundPanel', readFileSync('src/components/shell/GroundPanel.tsx', 'utf8')],
    ] as const) {
      expect(src, `${file} must read the written count off the report`).toContain('.written.toLocaleString()');
      expect(src, `${file} must surface the points that were left out`).toContain('skippedNoGround');
    }
  });

  it('the dialog actually emits every option it declares', () => {
    const submit = dialog.slice(dialog.indexOf('const submit = ()'), dialog.indexOf('};', dialog.indexOf('const submit = ()')));
    for (const opt of OPTIONS) {
      expect(submit, `the export dialog declares ${opt} but never sends it`).toContain(opt);
    }
  });
});

/** Commands that rewrite a dataset on disk must hold the edit lock.
 *
 *  Bake, classification, segmentation and friends re-open the dataset
 *  when they finish, and the re-open reloads patches.bin over the
 *  in-memory edit store and clears undo — so an edit made while one runs
 *  is destroyed and the indicator then reads "Saved". The lock is taken
 *  here, around the wrappers, precisely so no panel can forget it; this
 *  test is what stops a NEW mutating command being added without it. */
describe('dataset-mutating commands hold the edit lock', () => {
  const bridge = readFileSync('src/persistence/desktopBridge.ts', 'utf8');

  const MUTATORS = [
    'octreeBakePatches', 'octreeClassifyGround', 'octreeResetClassification',
    'octreeResetAttribute', 'octreeSkeletonTransfer', 'octreeNormalize',
    'octreeRemoveExtra', 'octreeAddDeadwoodColumns', 'octreeIntensityRange',
    'octreeSegmentChm', 'octreeTreeIsolation', 'octreeSegmentDeadwood', 'octreeLeafWood',
  ];

  it.each(MUTATORS)('%s is wrapped in withDatasetBusy', (name) => {
    const start = bridge.indexOf(`${name}: (`);
    expect(start, `${name} must exist in the bridge`).toBeGreaterThan(-1);
    // The wrapper body runs to the next top-level command declaration.
    const body = bridge.slice(start, start + 1200);
    expect(body, `${name} rewrites the dataset but does not hold the edit lock`).toContain('withDatasetBusy');
  });
});
