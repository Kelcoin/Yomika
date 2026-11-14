/** Keep ordinary accents, Thai vowels/tones and emoji variation selectors, but
 * bound Zalgo-style mark stacking so one comment cannot paint over its peers. */
export function readableCommentText(text: string): string {
  let marks = 0;
  let result = '';
  for (const character of text.normalize('NFC')) {
    if (/\p{M}/u.test(character)) {
      if (++marks > 3) continue;
    } else marks = 0;
    result += character;
  }
  return result;
}
