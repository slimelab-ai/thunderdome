// Subtitles use all-caps for visual emphasis. Speech models commonly interpret
// that typography as shouting, acronym spelling, or a request to over-stress every
// syllable, so keep it out of the text sent to every offline renderer.
const normalizeEmphasis = text => text.replace(
  /\b[A-Z][A-Z']*[A-Z]\b/g,
  word => word[0] + word.slice(1).toLowerCase(),
);

export function announcerSpokenText(text) {
  let result = text.replaceAll('{victim}', 'the target').replaceAll('{killer}', 'the hired gun')
    .replace('Hired muscle the hired gun', 'The hired gun')
    .replace('the target, meet floor', 'the target meets the floor')
    .replace('the target just became the most valuable target', 'That fighter just became the most valuable target');
  result = normalizeEmphasis(result);
  result = result.replace(/\bRsvp\b/g, 'R. S. V. P.').replace(/\bBo-Ring\b/g, 'Boring');
  return result ? result[0].toUpperCase() + result.slice(1) : result;
}
