/**
 * Test fixtures representing Google Docs API v1 Document responses,
 * including Developer Preview comments, commentAnchors, and suggestions.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function createSampleDocument(): any {
  // We'll construct a document with:
  // Index 0: Section break / start of document
  // 1..26: "Introduction to Editorial\n" (HEADING_1)
  // 26..78: "In order to capture enterprise customers, we must move rapidly and ship ahead of schedule.\n" (NORMAL_TEXT)
  //   - Comment anchor c_anchor_1 on [68..88): "move rapidly"
  // 78..95: "Key Action Items\n" (NORMAL_TEXT, but pseudo-heading: bold, <80 chars)
  // 95..145: "First item: update the public documentation immediately.\n"
  //   - Suggestion ins_1 inserting "public " at 107..114
  // 145..185: "Second item: finalize enterprise pricing.\n"

  const doc = {
    documentId: 'doc_test_123',
    title: 'Editorial Test Document',
    revisionId: 'rev_initial_001',
    suggestionsViewMode: 'SUGGESTIONS_INLINE',
    commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED',
    namedStyles: {
      styles: [
        {
          namedStyleType: 'NORMAL_TEXT',
          textStyle: {
            fontSize: { magnitude: 11, unit: 'PT' },
            bold: false,
          },
        },
        {
          namedStyleType: 'HEADING_1',
          textStyle: {
            fontSize: { magnitude: 20, unit: 'PT' },
            bold: true,
          },
        },
      ],
    },
    body: {
      content: [
        {
          startIndex: 0,
          endIndex: 1,
          sectionBreak: {},
        },
        {
          startIndex: 1,
          endIndex: 27,
          paragraph: {
            paragraphStyle: {
              namedStyleType: 'HEADING_1',
            },
            elements: [
              {
                startIndex: 1,
                endIndex: 27,
                textRun: {
                  content: 'Introduction to Editorial\n',
                  textStyle: { bold: true },
                },
              },
            ],
          },
        },
        {
          startIndex: 27,
          endIndex: 119,
          paragraph: {
            paragraphStyle: {
              namedStyleType: 'NORMAL_TEXT',
            },
            elements: [
              {
                startIndex: 27,
                endIndex: 69,
                textRun: {
                  content: 'In order to capture enterprise customers, ',
                },
              },
              {
                startIndex: 69,
                endIndex: 89,
                textRun: {
                  content: 'we must move rapidly',
                },
              },
              {
                startIndex: 89,
                endIndex: 119,
                textRun: {
                  content: ' and ship ahead of schedule.\n',
                },
              },
            ],
          },
        },
        {
          startIndex: 119,
          endIndex: 136,
          paragraph: {
            paragraphStyle: {
              namedStyleType: 'NORMAL_TEXT',
            },
            elements: [
              {
                startIndex: 119,
                endIndex: 136,
                textRun: {
                  content: 'Key Action Items\n',
                  textStyle: { bold: true },
                },
              },
            ],
          },
        },
        {
          startIndex: 136,
          endIndex: 193,
          paragraph: {
            paragraphStyle: {
              namedStyleType: 'NORMAL_TEXT',
            },
            elements: [
              {
                startIndex: 136,
                endIndex: 148,
                textRun: {
                  content: 'First item: ',
                },
              },
              {
                startIndex: 148,
                endIndex: 155,
                textRun: {
                  content: 'public ',
                  suggestedInsertionIds: ['sug_ins_1'],
                },
              },
              {
                startIndex: 155,
                endIndex: 193,
                textRun: {
                  content: 'documentation must be published soon.\n',
                },
              },
            ],
          },
        },
      ],
    },
    commentAnchors: {
      anchor_c1: {
        anchorId: 'anchor_c1',
        ranges: [
          {
            startIndex: 69,
            endIndex: 89,
          },
        ],
      },
    },
    comments: [
      {
        commentId: 'c.123456',
        anchorId: 'anchor_c1',
        status: 'OPEN',
        plainTextQuote: 'we must move rapidly',
        headPost: {
          postId: 'post_001',
          author: {
            displayName: 'Alice Smith',
          },
          content: 'Please rephrase to sound more executive.',
          createTime: '2026-10-01T12:00:00Z',
        },
        replies: [
          {
            postId: 'post_002',
            author: {
              displayName: 'Bob Jones',
            },
            content: 'Agreed, maybe "accelerate execution"?',
            createTime: '2026-10-01T12:05:00Z',
          },
        ],
      },
    ],
    suggestions: [
      {
        suggestionId: 'sug_ins_1',
        status: 'OPEN',
        headPost: {
          author: {
            displayName: 'Charlie Brown',
          },
        },
        summaryText: 'Insert "public "',
      },
    ],
  };

  return doc;
}

export function createFormattedDocument(): any {
  return {
    documentId: 'doc_formatted_001',
    title: 'Project Proposal & Review',
    revisionId: 'rev_formatted_001',
    namedStyles: {
      styles: [
        { namedStyleType: 'NORMAL_TEXT', textStyle: { fontSize: { magnitude: 11, unit: 'PT' } } },
        { namedStyleType: 'HEADING_1', textStyle: { fontSize: { magnitude: 18, unit: 'PT' }, bold: true } },
      ],
    },
    body: {
      content: [
        { startIndex: 0, endIndex: 1, sectionBreak: {} },
        {
          startIndex: 1,
          endIndex: 31,
          paragraph: {
            paragraphStyle: { namedStyleType: 'TITLE' },
            elements: [
              {
                startIndex: 1,
                endIndex: 31,
                textRun: { content: 'Project Proposal & Review Doc\n', textStyle: { bold: true } },
              },
            ],
          },
        },
        {
          startIndex: 31,
          endIndex: 60,
          paragraph: {
            paragraphStyle: { namedStyleType: 'HEADING_1' },
            elements: [
              {
                startIndex: 31,
                endIndex: 60,
                textRun: { content: 'Section 1: Core Deliverables\n', textStyle: { bold: true } },
              },
            ],
          },
        },
        {
          startIndex: 60,
          endIndex: 220,
          table: {
            rows: 2,
            columns: 2,
            tableRows: [
              {
                startIndex: 61,
                endIndex: 105,
                tableCells: [
                  {
                    startIndex: 62,
                    endIndex: 80,
                    content: [
                      {
                        startIndex: 63,
                        endIndex: 80,
                        paragraph: {
                          elements: [
                            {
                              startIndex: 63,
                              endIndex: 80,
                              textRun: { content: 'Requirement Item\n', textStyle: { bold: true } },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  {
                    startIndex: 81,
                    endIndex: 104,
                    content: [
                      {
                        startIndex: 82,
                        endIndex: 104,
                        paragraph: {
                          elements: [
                            {
                              startIndex: 82,
                              endIndex: 104,
                              textRun: { content: 'Proposed Deliverables\n', textStyle: { bold: true } },
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
              {
                startIndex: 105,
                endIndex: 219,
                tableCells: [
                  {
                    startIndex: 106,
                    endIndex: 130,
                    content: [
                      {
                        startIndex: 107,
                        endIndex: 130,
                        paragraph: {
                          elements: [
                            {
                              startIndex: 107,
                              endIndex: 130,
                              textRun: { content: 'Feature & System Scope\n' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  {
                    startIndex: 131,
                    endIndex: 218,
                    content: [
                      {
                        startIndex: 132,
                        endIndex: 153,
                        paragraph: {
                          elements: [
                            {
                              startIndex: 132,
                              endIndex: 153,
                              textRun: { content: 'Deliverable includes ' },
                            },
                            {
                              startIndex: 153,
                              endIndex: 161,
                              textRun: {
                                content: '10 days ',
                                textStyle: { italic: true, strikethrough: true },
                              },
                            },
                            {
                              startIndex: 161,
                              endIndex: 169,
                              textRun: {
                                content: '20 days ',
                                textStyle: { bold: true },
                              },
                            },
                            {
                              startIndex: 169,
                              endIndex: 189,
                              textRun: {
                                content: 'dedicated QA support',
                                textStyle: { underline: true },
                              },
                            },
                            {
                              startIndex: 189,
                              endIndex: 218,
                              textRun: { content: ' per sprint by our dev team.\n' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        {
          startIndex: 220,
          endIndex: 250,
          paragraph: {
            elements: [
              {
                startIndex: 220,
                endIndex: 248,
                textRun: { content: 'System Performance Metrics: ' },
              },
              {
                startIndex: 248,
                endIndex: 249,
                inlineObjectElement: { inlineObjectId: 'kix.chart1' },
              },
              {
                startIndex: 249,
                endIndex: 250,
                textRun: { content: '\n' },
              },
            ],
          },
        },
      ],
    },
    inlineObjects: {
      'kix.chart1': {
        inlineObjectProperties: {
          embeddedObject: {
            title: 'System Performance Metrics',
            description: 'Architecture throughput benchmarks over 12 months',
            imageProperties: { contentUri: 'https://example.com/performance-chart.png' },
            size: { width: { magnitude: 400 }, height: { magnitude: 250 } },
          },
        },
      },
    },
  };
}

