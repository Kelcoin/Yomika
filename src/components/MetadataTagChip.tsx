import { X } from 'lucide-react';
import { useRef, useState, type CSSProperties } from 'react';

import { translateRawTag } from '../lib/tags';
import type { MetadataTagSizes } from './MetadataTagRows';

/** One editable tag.
 *
 * The edit page used to show two lists: a raw comma-separated textarea and a
 * read-only run of translated chips underneath. Nothing tied them together, so
 * the translations were decoration and every edit was string surgery.
 *
 * A chip rests at its translation's width and morphs to the original's on
 * hover (mouse) or press (touch, where there is no hover) — the row was
 * wrapped on the wider of the two labels, so the growth only shoves row
 * neighbours aside and never overflows it. The delete button sits on the right
 * so removing a tag is one click rather than finding it in a string.
 */
export function MetadataTagChip({ tag, sizes, onDelete }: { tag: string; sizes?: MetadataTagSizes | undefined; onDelete: () => void }) {
  const translated = translateRawTag(tag);
  const [revealed, setRevealed] = useState(false);
  const pointerType = useRef('');
  // A translation identical to the source has nothing to reveal and one width.
  const hasTranslation = translated !== tag;
  const measured = Boolean(sizes?.originalWidth && sizes?.translatedWidth);
  // **向上**取整：量出来的是小数（`somebody` 61.05px），四舍五入到 61 就比文字窄了
  // 零点零五个像素——`text-overflow: ellipsis` 立刻把最后一个字换成省略号。看起来
  // 「明明放得下却被截断」就是这么来的（实测 8 枚里有 3 枚这样）。
  const style: CSSProperties | undefined = measured ? ({
    '--tag-width-rest': `${Math.ceil(sizes!.translatedWidth)}px`,
    '--tag-width-revealed': `${Math.ceil(sizes!.originalWidth)}px`,
  } as CSSProperties) : undefined;

  return (
    <span className={`metadata-tag${revealed ? ' is-revealed' : ''}${hasTranslation ? '' : ' is-untranslated'}${measured ? ' is-measured' : ''}`} style={style}>
      <button
        type="button"
        className="metadata-tag-reveal"
        aria-label={hasTranslation ? `${translated}（原文 ${tag}）` : tag}
        aria-pressed={revealed}
        title={revealed ? translated : tag}
        onPointerDown={(event) => { pointerType.current = event.pointerType; }}
        onClick={() => {
          // Mouse users already get the original on hover, so a click there
          // would fight the hover state. Touch has no hover to fight.
          if (pointerType.current && pointerType.current !== 'mouse') setRevealed((value) => !value);
          pointerType.current = '';
        }}
      >
        {hasTranslation ? (
          <span className="metadata-tag-labels">
            <span className="metadata-tag-label is-translated">{translated}</span>
            <span className="metadata-tag-label is-original">{tag}</span>
          </span>
        ) : <span className="metadata-tag-labels"><span className="metadata-tag-label is-translated">{tag}</span></span>}
      </button>
      <button type="button" className="metadata-tag-delete" aria-label={`删除标签 ${tag}`} title="删除标签" onClick={onDelete}>
        <X aria-hidden="true" />
      </button>
    </span>
  );
}
