// Rendering one transcript record into chat markup.
//
// Nothing is ever dropped: a block the parser does not recognise falls through
// to a collapsed raw-JSON <details> rather than disappearing.

import { esc, truncated, stripAnsi } from '../dom.mjs';

function innerTag(body, name) {
  var m = body.match(new RegExp('<' + name + '>([\\s\\S]*?)<\\/' + name + '>'));
  return m ? m[1].trim() : '';
}

/* Slash-command invocations and their local stdout are injected into the
   transcript as <command-*> / <local-command-*> tags. Render them as chips
   instead of leaking the raw markup into the chat body. */
function extractCommandBlocks(text) {
  var blocks = [];
  var remaining = String(text).replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');

  remaining = remaining.replace(
    /<command-name>([\s\S]*?)<\/command-name>(?:\s*<command-message>([\s\S]*?)<\/command-message>)?(?:\s*<command-args>([\s\S]*?)<\/command-args>)?/g,
    function (_, name, _msg, cmdArgs) {
      var args = (cmdArgs || '').trim();
      blocks.push('<div class="cmd-block"><span class="cmd-badge">Command</span><span class="cmd-name">' + esc(name.trim()) + '</span>' +
        (args ? ' <span class="cmd-args">' + esc(args) + '</span>' : '') + '</div>');
      return '';
    });

  remaining = remaining.replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, function (_, out) {
    var clean = stripAnsi(out).trim();
    if (clean) blocks.push('<div class="cmd-block"><span class="cmd-badge cmd-badge-out">Output</span><pre class="cmd-stdout">' + esc(clean) + '</pre></div>');
    return '';
  });

  remaining = remaining.replace(/<task-notification>([\s\S]*?)<\/task-notification>/g, function (_, body) {
    var status = innerTag(body, 'status') || 'done';
    var summary = innerTag(body, 'summary');
    var taskId = innerTag(body, 'task-id');
    blocks.push('<div class="cmd-block"><span class="cmd-badge cmd-badge-task">Task ' + esc(status) + '</span>' +
      (summary ? '<span class="cmd-name">' + esc(summary) + '</span>' : '') +
      (taskId ? ' <span class="cmd-args">#' + esc(taskId) + '</span>' : '') + '</div>');
    return '';
  });

  remaining = remaining.replace(/<ide_opened_file>([\s\S]*?)<\/ide_opened_file>/g, function (_, content) {
    var match = content.match(/opened the file (.+?) in the IDE/);
    blocks.push('<div class="ctx-row"><span class="ctx-badge">Opened file</span><span class="ctx-path">' + esc(match ? match[1].trim() : content.trim()) + '</span></div>');
    return '';
  });

  remaining = remaining.replace(/<ide_selection>([\s\S]*?)<\/ide_selection>/g, function (_, content) {
    var lineMatch = content.match(/selected the lines (\d+) to (\d+) from (.+?):/);
    if (lineMatch) {
      var selected = content.split('\n').slice(1).join('\n').replace(/\nThis may or may not be related to the current task\./, '').trim();
      blocks.push('<div class="ctx-row"><span class="ctx-badge">Selection</span><span class="ctx-path">' + esc(lineMatch[3].trim()) + ':L' + esc(lineMatch[1]) + '-' + esc(lineMatch[2]) + '</span>' +
        (selected ? '<pre class="cmd-stdout">' + esc(selected) + '</pre>' : '') + '</div>');
    } else {
      blocks.push('<div class="ctx-row"><span class="ctx-badge">Selection</span><pre class="cmd-stdout">' + esc(content.trim()) + '</pre></div>');
    }
    return '';
  });

  remaining = remaining.replace(/<system-reminder>([\s\S]*?)<\/system-reminder>/g, function (_, content) {
    blocks.push('<details class="tool"><summary><span class="tool__name">system-reminder</span></summary>' +
      '<div class="tool__body"><pre class="chat-pre">' + esc(content.trim()) + '</pre></div></details>');
    return '';
  });

  remaining = remaining.replace(/This may or may not be related to the current task\.\s*/g, '').trim();
  return { blocks: blocks.join(''), remaining: remaining };
}

function rawJsonBlock(label, raw) {
  var json;
  try { json = JSON.stringify(raw, null, 2); } catch (e) { json = String(raw); }
  return '<details class="tool"><summary><span class="tool__name">' + esc(label) + '</span></summary>' +
    '<div class="tool__body"><pre class="chat-pre">' + esc(truncated(json, 20000)) + '</pre></div></details>';
}

function partHtml(p) {
  switch (p.kind) {
    case 'text': {
      var extracted = extractCommandBlocks(p.text || '');
      return extracted.blocks + (extracted.remaining ? '<div class="chat-text">' + esc(extracted.remaining) + '</div>' : '');
    }
    case 'thinking':
      return '<details class="tool tool--thinking"><summary><span class="tool__name">thinking</span>' +
        '<span class="tool__arg">' + esc(String(p.text || '').slice(0, 120)) + '</span></summary>' +
        '<div class="tool__body"><div class="chat-text">' + esc(truncated(p.text, 20000)) + '</div></div></details>';
    case 'tool_use':
      return '<details class="tool"><summary><span class="tool__name">' + esc(p.tool) + '</span>' +
        '<span class="tool__arg">' + esc(p.input || '') + '</span></summary>' +
        '<div class="tool__body"><pre class="chat-pre">' + esc(truncated(JSON.stringify(p.raw, null, 2), 20000)) + '</pre></div></details>';
    case 'tool_result':
      return '<details class="tool' + (p.isError ? ' tool--error' : '') + '"><summary>' +
        '<span class="tool__name">' + (p.isError ? 'error' : 'result') + '</span>' +
        '<span class="tool__arg">' + esc(String(p.text || '').split('\n')[0].slice(0, 160)) + '</span></summary>' +
        '<div class="tool__body"><pre class="chat-pre">' + esc(truncated(p.text, 20000)) + '</pre></div></details>';
    case 'image':
      return '<img alt="pasted image" style="max-width:100%;border-radius:var(--r-sm)" src="data:' + esc(p.mediaType) + ';base64,' + esc(p.data) + '" />';
    case 'attachment': {
      var label = p.attachKind || 'context';
      var value = p.displayPath || p.text || '';
      return '<div class="ctx-row"><span class="ctx-badge">' + esc(label) + '</span><span class="ctx-path">' + esc(value) + '</span>' +
        (p.numLines ? '<span class="subtle">' + esc(p.numLines) + ' lines</span>' : '') + '</div>';
    }
    case 'event':
      return '<div class="ctx-row"><span class="ctx-badge">' + esc(p.label) + '</span><span>' + esc(truncated(p.text, 400)) + '</span></div>';
    case 'unknown':
    default:
      // Nothing is ever dropped: an unrecognised record or block shows raw.
      return rawJsonBlock(p.label || 'unknown', p.raw);
  }
}

const ROLE_LABEL = { user: 'You', assistant: 'Claude', tool: 'Tool output', context: 'Context' };

export function messageHtml(m) {
  var body = m.parts.map(partHtml).join('');
  // A message whose only content was CLI boilerplate (the per-command caveat,
  // say) renders to nothing. Drop the empty card rather than leave a blank box.
  if (!body.trim()) return '';
  var cls = 'msg msg--' + m.role + (m.isCompactSummary ? ' msg--compact' : '');
  var meta = [];
  if (m.model) meta.push(m.model.replace(/^claude-/, ''));
  if (m.timestamp) meta.push(new Date(m.timestamp).toLocaleString());
  if (m.isCompactSummary) meta.push('compact summary');
  return '<div class="' + cls + '">' +
    '<div class="msg__head"><span>' + esc(ROLE_LABEL[m.role] || m.role) + '</span>' +
    (meta.length ? '<span class="grow"></span><span>' + esc(meta.join(' · ')) + '</span>' : '') + '</div>' +
    '<div class="msg__body">' + body + '</div></div>';
}
