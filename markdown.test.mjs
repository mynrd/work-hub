import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown } from './markdown.mjs';

test('renderMarkdown converts ATX headings h1 through h6', () => {
  const html = renderMarkdown('# H1\n## H2\n###### H6');
  assert.match(html, /<h1>H1<\/h1>/);
  assert.match(html, /<h2>H2<\/h2>/);
  assert.match(html, /<h6>H6<\/h6>/);
});

test('renderMarkdown converts a fenced code block verbatim, without inline parsing', () => {
  const html = renderMarkdown('```js\nif (x < 2) { y(); }\n**not bold**\n```');
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /if \(x &lt; 2\) \{ y\(\); \}/);
  assert.match(html, /\*\*not bold\*\*/); // untouched by bold parsing
  assert.doesNotMatch(html, /<strong>/);
});

test('renderMarkdown converts inline code spans', () => {
  const html = renderMarkdown('Use `const x = 1` here.');
  assert.equal(html, '<p>Use <code>const x = 1</code> here.</p>');
});

test('renderMarkdown converts bold text', () => {
  const html = renderMarkdown('This is **bold** text');
  assert.equal(html, '<p>This is <strong>bold</strong> text</p>');
});

test('renderMarkdown converts italic text', () => {
  const html = renderMarkdown('This is *italic* text');
  assert.equal(html, '<p>This is <em>italic</em> text</p>');
});

test('renderMarkdown converts links', () => {
  const html = renderMarkdown('See [the docs](https://example.com/path?a=1&b=2).');
  assert.equal(html, '<p>See <a href="https://example.com/path?a=1&amp;b=2">the docs</a>.</p>');
});

test('renderMarkdown converts an unordered list', () => {
  const html = renderMarkdown('- item one\n- item two');
  assert.equal(html, '<ul><li>item one</li><li>item two</li></ul>');
});

test('renderMarkdown converts an ordered list', () => {
  const html = renderMarkdown('1. first\n2. second');
  assert.equal(html, '<ol><li>first</li><li>second</li></ol>');
});

test('renderMarkdown converts a GFM pipe table', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.equal(
    html,
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  );
});

test('renderMarkdown converts a blockquote', () => {
  const html = renderMarkdown('> quoted text');
  assert.equal(html, '<blockquote><p>quoted text</p></blockquote>');
});

test('renderMarkdown escapes HTML before converting, so literal <n> and <folder> survive as visible text', () => {
  const html = renderMarkdown('Use `--port <n>` and set `<folder>/progress.json`.');

  assert.equal(
    html,
    '<p>Use <code>--port &lt;n&gt;</code> and set <code>&lt;folder&gt;/progress.json</code>.</p>',
  );
  assert.equal(html.includes('<n>'), false);
  assert.equal(html.includes('<folder>'), false);
});
