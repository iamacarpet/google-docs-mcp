import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDocModel, getTab } from '../docModel.js';
import {
  EditValidationError,
  buildMultiEditRequests,
  buildReplaceRequests,
  planRangeEdit,
  sortEditsDescending,
} from '../edits.js';
import { createSampleDocument } from './fixtures.js';

describe('edits', () => {
  it('sorts edits in reverse order (bottom-to-top) and prevents index drift', () => {
    const edits = [
      { startIndex: 20, endIndex: 30, text: 'A' },
      { startIndex: 80, endIndex: 90, text: 'B' },
      { startIndex: 50, endIndex: 60, text: 'C' },
    ];

    const sorted = sortEditsDescending(edits);
    assert.deepEqual(
      sorted.map((e) => e.startIndex),
      [80, 50, 20],
    );
  });

  it('rejects overlapping edits', () => {
    const overlapping = [
      { startIndex: 20, endIndex: 40, text: 'A' },
      { startIndex: 35, endIndex: 50, text: 'B' },
    ];

    assert.throws(() => sortEditsDescending(overlapping), EditValidationError);
  });

  it('validates ranges and respects expectedText guards', () => {
    const raw = createSampleDocument();
    const model = buildDocModel(raw, { commentsAvailable: true });
    const tab = getTab(model);

    // Matching expectedText succeeds
    const planned = planRangeEdit(
      tab,
      { startIndex: 69, endIndex: 89, text: 'accelerate our launch' },
      'we must move rapidly',
    );
    assert.equal(planned.startIndex, 69);
    assert.equal(planned.endIndex, 89);
    assert.equal(planned.text, 'accelerate our launch');

    // Mismatched expectedText throws
    assert.throws(
      () =>
        planRangeEdit(
          tab,
          { startIndex: 69, endIndex: 88, text: 'accelerate our launch' },
          'something completely different',
        ),
      EditValidationError,
    );
  });

  it('builds insert-at-end-then-delete requests for atomic suggestion mode', () => {
    const raw = createSampleDocument();
    const model = buildDocModel(raw, { commentsAvailable: true });
    const tab = getTab(model);

    const edit = { startIndex: 69, endIndex: 89, text: 'accelerate execution' };
    const requests = buildReplaceRequests(tab, edit);

    assert.equal(requests.length, 2);
    // 1st request: insert at endIndex (89)
    assert.deepEqual(requests[0], {
      insertText: {
        location: { index: 89 },
        text: 'accelerate execution',
      },
    });
    // 2nd request: delete original range [69, 89)
    assert.deepEqual(requests[1], {
      deleteContentRange: {
        range: { startIndex: 69, endIndex: 89 },
      },
    });
  });

  it('builds multi-edit requests strictly ordered bottom-to-top', () => {
    const raw = createSampleDocument();
    const model = buildDocModel(raw, { commentsAvailable: true });
    const tab = getTab(model);

    const edits = [
      { startIndex: 27, endIndex: 35, text: 'To' },
      { startIndex: 69, endIndex: 89, text: 'accelerate execution' },
    ];

    const requests = buildMultiEditRequests(tab, edits);
    // Lower edit (69..89) should come first, then upper edit (27..35)
    assert.equal(requests.length, 4);
    assert.equal(requests[0].insertText.location.index, 89);
    assert.equal(requests[1].deleteContentRange.range.startIndex, 69);
    assert.equal(requests[2].insertText.location.index, 35);
    assert.equal(requests[3].deleteContentRange.range.startIndex, 27);
  });
});
