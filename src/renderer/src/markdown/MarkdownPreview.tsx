/**
 * Rendered markdown view (v0.3.4) — the shared preview used by the IDE's
 * split/preview modes, the fullscreen file overlay, and (via those) the
 * terminal ⌘-click flow.
 *
 * SECURITY: agent-generated markdown is untrusted. react-markdown WITHOUT
 * rehype-raw renders to React elements only — no HTML sink exists, raw HTML in
 * the source is shown as text, and the default urlTransform already drops
 * javascript: URIs. Keep it that way: never add rehype-raw here.
 *
 * Links never navigate the window: http(s)/mailto go through the main-process
 * opener; relative *.md links surface through onOpenMarkdownLink so the host
 * (IDE tab / overlay) opens them in context; everything else is inert.
 */
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface MarkdownPreviewProps {
  source: string;
  /** Repo-relative path of the file being previewed (for resolving relative links). */
  baseRel?: string;
  /** Open a sibling markdown file (repo-relative path) in the host's context. */
  onOpenMarkdownLink?: (rel: string) => void;
}

/** Resolve `href` against the directory of `baseRel` ('' when unknown). */
function resolveRel(baseRel: string | undefined, href: string): string {
  const baseDir = (baseRel ?? '').split('/').slice(0, -1);
  const parts = [...baseDir];
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

function isExternal(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

function isRelativeMd(href: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(href) && /\.(md|markdown)(#.*)?$/i.test(href);
}

export const MarkdownPreview = memo(function MarkdownPreview({
  source,
  baseRel,
  onOpenMarkdownLink,
}: MarkdownPreviewProps) {
  return (
    <div className="cth-md-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const h = href ?? '';
            const onClick = (e: React.MouseEvent) => {
              e.preventDefault();
              if (isExternal(h)) {
                void window.cth.openExternal?.(h);
                return;
              }
              if (isRelativeMd(h) && onOpenMarkdownLink) {
                onOpenMarkdownLink(resolveRel(baseRel, h.replace(/#.*$/, '')));
              }
              // anything else (file:, anchors into self, unknown schemes): inert
            };
            const clickable = isExternal(h) || (isRelativeMd(h) && !!onOpenMarkdownLink);
            return (
              <a
                href={h || undefined}
                onClick={onClick}
                title={h}
                style={
                  clickable ? undefined : { cursor: 'default', textDecoration: 'underline dotted' }
                }
              >
                {children}
              </a>
            );
          },
          // Local/remote images: remote is blocked by CSP anyway; render alt text
          // as a placeholder chip instead of a broken-image icon.
          img: ({ alt, src }) => (
            <span className="cth-md-img" title={typeof src === 'string' ? src : undefined}>
              🖼 {alt || 'image'}
            </span>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
