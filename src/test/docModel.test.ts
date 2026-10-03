import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocModel,
  collectSuggestionIds,
  findComment,
  getTab,
  renderText,
  resolveCommentAnchor,
  searchText,
} from '../docModel.js';
import { createSampleDocument } from './fixtures.js';

describe('docModel', () => {
  it('preserves exact UTF-16 coordinate fidelity', () => {
    const raw = createSampleDocument();
    const model = buildDocModel(raw, { commentsAvailable: true });
    const tab = getTab(model);

    // Total length check
    assert.equal(tab.endIndex, 193);

    // Range [1, 27) corresponds to Heading 1
    const headingText = tab.text.slice(1, 27);
    assert.equal(headingText, 'Introduction to Editorial\n');

    // Range [69, 89) corresponds to the comment anchor
    const anchorText = tab.text.slice(69, 89);
    assert.equal(anchorText, 'we must move rapidly');

    // Section break at index 0 is represented as a gap character
    assert.equal(tab.text[0], '\u0000');
  });

  it('detects formal headings and pseudo-headings', () => {
    const raw = createSampleDocument();
    const model = buildDocModel(raw, { commentsAvailable: true });
    const tab = getTab(model);

    assert.equal(tab.outline.length, 2);

    // Entry 0: Formal HEADING_1
    assert.equal(tab.outline[0].title, 'Introduction to Editorial');
    assert.equal(tab.outline[0].level, 1);
    assert.equal(tab.outline[0].isPseudo, false);
    assert.equal(tab.outline[0].startIndex, 1);
    assert.equal(tab.outline[0].endIndex, 27);

    // Entry 1: Pseudo-heading (bold, single line < 80 chars)
    assert.equal(tab.outline[1].title, 'Key Action Items');
    assert.equal(tab.outline[1].level, 2);
    assert.equal(tab.outline[1].isPseudo, true);
    assert.equal(tab.outline[1].startIndex, 119);
    assert.equal(tab.outline[1].endIndex, 136);
  });

  it('parses comments, replies and resolves anchors', () => {
    const raw = createSampleDocument();
    const model = buildDocModel(raw, { commentsAvailable: true });

    assert.equal(model.comments.length, 1);
    const comment = findComment(model, 'c.123456');
    assert.equal(comment.head.author, 'Alice Smith');
    assert.equal(comment.head.content, 'Please rephrase to sound more executive.');
    assert.equal(comment.status, 'OPEN');
    assert.equal(comment.replies.length, 1);
    assert.equal(comment.replies[0].author, 'Bob Jones');

    const resolved = resolveCommentAnchor(model, comment);
    assert.ok(resolved);
    assert.ok(resolved.merged);
    assert.equal(resolved.merged.startIndex, 69);
    assert.equal(resolved.merged.endIndex, 89);
    assert.equal(resolved.tab.text.slice(resolved.merged.startIndex, resolved.merged.endIndex), 'we must move rapidly');
  });

  it('identifies suggestions and renders inline diff markup', () => {
    const raw = createSampleDocument();
    const model = buildDocModel(raw, { commentsAvailable: true });
    const tab = getTab(model);

    const suggestionIds = collectSuggestionIds(model);
    assert.ok(suggestionIds.has('sug_ins_1'));

    // Plain text without markup
    const plain = renderText(tab, 136, 193, false);
    assert.equal(plain, 'First item: public documentation must be published soon.\n');

    // With suggestion markup
    const marked = renderText(tab, 136, 193, true);
    assert.equal(marked, 'First item: {+public +}documentation must be published soon.\n');
  });

  it('searches text accurately without re-indexing', () => {
    const raw = createSampleDocument();
    const model = buildDocModel(raw, { commentsAvailable: true });
    const tab = getTab(model);

    const res = searchText(tab, 'enterprise');
    assert.equal(res.totalMatches, 1);
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0].startIndex, 47);
    assert.equal(res.matches[0].endIndex, 57);
    assert.equal(tab.text.slice(res.matches[0].startIndex, res.matches[0].endIndex), 'enterprise');

    // Case insensitive by default
    const resUpper = searchText(tab, 'ENTERPRISE', { caseSensitive: false });
    assert.equal(resUpper.totalMatches, 1);

    // Case sensitive
    const resSensitive = searchText(tab, 'ENTERPRISE', { caseSensitive: true });
    assert.equal(resSensitive.totalMatches, 0);
  });
});
