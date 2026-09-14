import { X } from 'lucide-react';
import { useRef, useState } from 'react';

import { translateRawTag } from '../lib/tags';

/** One editable tag.
 *
 * The edit page used to show two lists: a raw comma-separated textarea and a
 * read-only run of translated chips underneath. Nothing tied them together, so
 * the translations were decoration and every edit was string surgery.
 *
 * A chip shows the translation and
 * reveals the original underneath it. Hover does it on a mouse; a tap does it on
 * touch, where there is no hover to rely on. The delete button sits on the right
 * so removing a tag is one click rather than finding it in a string.
 */
export function MetadataTagChip({ tag, onDelete }: { tag: string; onDelete: () => void }) {
  const translated = translateRawTag(tag);
  const [revealed, setRevealed] = useState(false);
  const pointerType = useRef('');
  // A translation identical to the source has nothing to reveal.
  const hasTranslation = translated !== tag;

  return (
    <span className={`metadata-tag${revealed ? ' is-revealed' : ''}${hasTranslation ? '' : ' is-untranslated'}`}>
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
