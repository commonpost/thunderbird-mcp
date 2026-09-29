'use strict';

// Links and images in email HTML: only http(s)/mailto links survive the
// conversion to Markdown, an image is never more than its alt text; oversized
// HTML never reaches the DOM.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../extension/mcp_server/api.js'), 'utf8');

// Node has no DOMParser: a tiny stand-in that handles the markup used below
// (tags, quoted attributes, text, void tags; no entity decoding).
class FakeDOMParser {
  static calls = 0;

  parseFromString(html) {
    FakeDOMParser.calls++;
    const VOID = new Set(['br', 'hr', 'img']);
    const make = (tagName, attrs) => ({
      nodeType: 1, tagName: tagName.toUpperCase(), childNodes: [], parentElement: null,
      getAttribute: (n) => (n in attrs ? attrs[n] : null),
      hasAttribute: (n) => n in attrs,
      get textContent() { return this.childNodes.map((c) => c.textContent).join(''); },
    });
    const body = make('body', {});
    const stack = [body];
    const re = /<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      const top = stack[stack.length - 1];
      if (m[4] !== undefined) {
        top.childNodes.push({ nodeType: 3, textContent: m[4] });
      } else if (m[1]) {
        if (stack.length > 1) stack.pop();
      } else {
        const attrs = {};
        // A bare boolean attribute (no "=value", e.g. "hidden") is captured too.
        for (const a of m[3].matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
          attrs[a[1]] = a[2] ?? a[3] ?? '';
        }
        const node = make(m[2], attrs);
        node.parentElement = top;
        top.childNodes.push(node);
        if (!VOID.has(m[2].toLowerCase())) stack.push(node);
      }
    }
    return { body, documentElement: body };
  }
}

// stripHtml, htmlExceedsDomLimit, safeEmailUrl and htmlToMarkdown now share
// helpers declared alongside them (hidden-content removal): load the whole
// marked block instead of each function's own brace-matched body.
function load({ withDom }) {
  const sandbox = withDom ? { DOMParser: FakeDOMParser } : {};
  vm.createContext(sandbox);
  const start = source.indexOf('// BEGIN HTML HIDDEN CONTENT HELPERS');
  const end = source.indexOf('// END HTML HIDDEN CONTENT HELPERS');
  assert.ok(start >= 0 && end > start, 'HTML HIDDEN CONTENT HELPERS marker missing');
  const names = ['stripHtml', 'htmlExceedsDomLimit', 'safeEmailUrl', 'htmlToMarkdown', 'isHiddenElementNode'];
  vm.runInContext(`${source.slice(start, end)}\nthis.api = { ${names.join(', ')} };`, sandbox);
  return sandbox.api;
}

const withDom = load({ withDom: true });
const noDom = load({ withDom: false });

describe('safeEmailUrl', () => {
  const link = (u) => withDom.safeEmailUrl(u);

  it('keeps http, https and mailto links, whatever their case', () => {
    assert.equal(link('http://example.org/a'), 'http://example.org/a');
    assert.equal(link('https://example.org/a?b=c#d'), 'https://example.org/a?b=c#d');
    assert.equal(link('mailto:a@example.org'), 'mailto:a@example.org');
    assert.equal(link('HTTPS://Example.org'), 'HTTPS://Example.org');
    assert.equal(link('MailTo:a@example.org'), 'MailTo:a@example.org');
  });

  it('drops every other scheme, and scheme-less or relative URLs', () => {
    for (const u of [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>',
      'vbscript:msgbox(1)', 'cid:logo@example', 'ftp://example.org/', 'tel:+15145550100', 'view-source:https://a.b',
      '//example.org/x', '/path', '#anchor', 'example.org', 'httpx://example.org', 'http', '', '   ',
    ]) {
      assert.equal(link(u), '', JSON.stringify(u));
    }
    assert.equal(link(null), '');
    assert.equal(link(undefined), '');
  });

  it('reads the scheme like a browser: leading control characters and spaces, tabs/newlines inside', () => {
    assert.equal(link('  \t\n javascript:alert(1)'), '');
    assert.equal(link('\u0001\u0002 javascript:alert(1)'), '');
    assert.equal(link('java\tscri\npt:alert(1)'), '');
    assert.equal(link('jav\rascript:alert(1)'), '');
    assert.equal(link('\u0000data:text/html,x'), '');
    // Legitimate URLs behind the same padding are still kept, cleaned.
    assert.equal(link('\u0001 https://example.org/'), 'https://example.org/');
    assert.equal(link('  ht\ttps://example.org/  '), 'https://example.org/');
  });

  it('keeps a URL from closing the Markdown link early', () => {
    assert.equal(link('https://example.org/a b(c)d<e>'), 'https://example.org/a%20b%28c%29d%3Ce%3E');
  });
});

describe('htmlToMarkdown with a DOM parser', () => {
  const md = (html) => withDom.htmlToMarkdown(html);

  it('keeps safe links', () => {
    assert.equal(md('<p><a href="https://example.org/x">site</a> <a href="mailto:a@example.org">mail</a></p>'),
      '[site](https://example.org/x) [mail](mailto:a@example.org)');
    assert.equal(md('<a href="https://example.org/">https://example.org/</a>'), 'https://example.org/');
  });

  it('turns unsafe links into their text, with no URL', () => {
    for (const href of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x',
      'file:///etc/passwd', 'vbscript:x', 'cid:a', 'ftp://example.org', '#top', '/relative']) {
      const out = md(`<p>before <a href="${href}">click here</a> after</p>`);
      assert.equal(out, 'before click here after', JSON.stringify(href));
    }
  });

  it('drops an unsafe link that has no text, instead of printing its URL', () => {
    assert.equal(md('<p>a<a href="javascript:alert(1)"></a>b</p>'), 'ab');
    assert.equal(md('<p>a<a></a>b</p>'), 'ab');
  });

  it('turns every image into its alt text, whatever its source', () => {
    for (const src of ['https://example.org/a.png', 'HTTP://example.org/a.png', 'data:image/png;base64,AAAA',
      'cid:logo@example', 'file:///a.png', 'javascript:1', 'mailto:a@b.c', '/a.png', '//example.org/a.png']) {
      assert.equal(md(`<p><img src="${src}" alt="logo"></p>`), 'logo', src);
    }
    assert.equal(md('<p>x<img src="https://example.org/a.png">y</p>'), 'xy');
    assert.equal(md('<p>x<img alt="">y</p>'), 'xy');
    assert.equal(md('<p>x<img src="https://example.org/a.png" alt="a" width="1" height="1">y</p>'), 'xy');
    assert.equal(md('<p><img src="https://example.org/t.gif" width="1" height="1" alt="t"></p>'), '');
    assert.equal(md('<p><a href="https://example.org/">go <img src="https://example.org/a.png" alt="now"></a></p>'),
      '[go now](https://example.org/)');
  });

  it('never lets an unsafe scheme reach the output', () => {
    const out = md('<a href="javascript:a()">1</a><a href="data:x">2</a><a href="file:///x">3</a><img src="data:x" alt="4"><img src="cid:y" alt="5"><img src="https://example.org/i.png" alt="6">');
    assert.ok(!/javascript:|data:|file:|cid:|https?:/i.test(out), out);
  });
});

describe('htmlToMarkdown without a DOM parser', () => {
  it('emits no link or image URL at all', () => {
    const out = noDom.htmlToMarkdown('<p>see <a href="javascript:alert(1)">this</a> <a href="https://example.org/">that</a><img src="data:image/png;base64,AAAA"></p>');
    assert.ok(!/javascript:|data:|https:/.test(out), out);
    assert.match(out, /see\s+this\s+that/);
  });
});

describe('size cap before the DOM parse', () => {
  const LIMIT = 2 * 1024 * 1024;
  const html = (size) => {
    const open = '<p><a href="https://example.org/">x</a></p>';
    return open + 'a'.repeat(size - open.length);
  };

  it('parses HTML up to 2 MiB and skips the DOM beyond it', () => {
    assert.equal(withDom.htmlExceedsDomLimit(html(LIMIT)), false);
    assert.equal(withDom.htmlExceedsDomLimit(html(LIMIT + 1)), true);

    FakeDOMParser.calls = 0;
    const small = withDom.htmlToMarkdown(html(LIMIT));
    assert.equal(FakeDOMParser.calls, 1);
    assert.match(small, /^\[x\]\(https:\/\/example\.org\/\)/);

    FakeDOMParser.calls = 0;
    const large = withDom.htmlToMarkdown(html(LIMIT + 1));
    assert.equal(FakeDOMParser.calls, 0, 'the DOM parser must not be reached');
    assert.match(large, /^x\s*a+$/, 'falls back to stripHtml');
    assert.ok(!large.includes('https://'), 'the fallback prints no URL');
  });

  it('still returns an empty string for empty input', () => {
    assert.equal(withDom.htmlToMarkdown(''), '');
    assert.equal(withDom.htmlToMarkdown(null), '');
  });
});

describe('hidden content is removed from the DOM walk, not just the regex fallback', () => {
  it('drops an element hidden by the hidden attribute or CSS, and counts it', () => {
    const cases = [
      '<p>keep</p><div hidden><p>secret</p></div>',
      '<p>keep</p><div style="display:none"><p>secret</p></div>',
      '<p>keep</p><div style="visibility: hidden"><p>secret</p></div>',
      '<p>keep</p><span style="font-size:0">secret</span>',
      '<p>keep</p><span style="opacity:0">secret</span>',
      '<p>keep</p><template><p>secret</p></template>',
    ];
    for (const html of cases) {
      const counter = { n: 0 };
      const text = withDom.htmlToMarkdown(html, counter);
      assert.ok(text.includes('keep'), html);
      assert.ok(!text.includes('secret'), `${html} was not removed: ${text}`);
      assert.equal(counter.n, 1, html);
    }
  });

  it('a hidden ancestor takes its whole subtree with it, counted once', () => {
    const counter = { n: 0 };
    const text = withDom.htmlToMarkdown(
      '<div hidden><p>firstsecret</p><p>secondsecret<a href="https://x.example/">linksecret</a></p></div>keep',
      counter
    );
    assert.ok(text.includes('keep'), text);
    assert.ok(!text.includes('secret'), text);
    assert.equal(counter.n, 1);
  });

  it('leaves ordinary visible content alone', () => {
    const counter = { n: 0 };
    const text = withDom.htmlToMarkdown('<p>visible</p><span style="color:red">also visible</span>', counter);
    assert.ok(text.includes('visible'));
    assert.ok(text.includes('also visible'));
    assert.equal(counter.n, 0);
  });
});
