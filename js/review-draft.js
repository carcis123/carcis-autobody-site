/* Carcis AI review wizard -- the questions, and the draft they build.
 *
 * Separated from the DOM wiring on purpose. Everything in here is pure: the
 * same answers always produce the same sentences, and it can be run and
 * tested in Node without a browser. That matters more than usual, because
 * what this file writes is a review that goes out under a customer's name.
 *
 * The rule the whole thing is built around: this assembles THEIR answers, it
 * does not write a review. Every clause below is the plain-prose form of a
 * button the customer pressed. There is no sentiment here that they did not
 * choose, no adjective that was not on the chip they tapped, and nothing
 * anywhere that praises Carcis on its own initiative.
 *
 * Which is also why the unhappy answers are in the same list, worded just as
 * plainly, and produce a review that still complains. A wizard that only
 * knows how to say nice things is a review-fixing machine, and Google's
 * rating-manipulation policy is the least of the reasons not to build one.
 */
(function (root) {
  'use strict';

  var STEPS = [
    {
      id: 'work',
      kind: 'multi',
      q: 'What did we do for you?',
      note: 'Tap any that apply.',
      options: [
        { label: 'Collision repair',  phrase: 'collision repair' },
        { label: 'Dent removal',      phrase: 'dent removal' },
        { label: 'Paint & refinish',  phrase: 'a repaint' },
        { label: 'Bumper repair',     phrase: 'bumper repair' },
        { label: 'Glass',             phrase: 'glass work' },
        { label: 'Detailing',         phrase: 'detailing' },
        { label: 'Towing',            phrase: 'towing' }
      ]
    },
    {
      id: 'verdict',
      kind: 'single',
      required: true,
      q: 'How did it go?',
      note: 'Whichever one is true. We would rather know.',
      options: [
        { label: 'Better than I expected', phrase: 'It went better than I expected.' },
        { label: 'About what I expected',  phrase: 'It went about how I expected.' },
        { label: 'Not what I expected',    phrase: 'It did not go how I expected.' },
        { label: 'It went wrong',          phrase: 'It went wrong.' }
      ]
    },
    {
      id: 'notes',
      kind: 'multi',
      q: 'Anything stand out?',
      note: 'Good or bad. Both are worth saying.',
      options: [
        { label: 'Kept me updated',          phrase: 'they kept me updated' },
        { label: 'Finished when they said',  phrase: 'they finished when they said they would' },
        { label: 'Price matched the quote',  phrase: 'the price matched the quote' },
        { label: 'The finish looked right',  phrase: 'the finish looked right' },
        { label: 'Easy to deal with',        phrase: 'they were easy to deal with' },
        { label: 'Explained the work',       phrase: 'they explained what they were doing' },
        { label: 'Took longer than quoted',  phrase: 'it took longer than they quoted', bad: true },
        { label: 'Hard to get hold of',      phrase: 'they were hard to get hold of',   bad: true },
        { label: 'The price changed',        phrase: 'the price changed from the quote', bad: true },
        { label: 'The finish was not right', phrase: 'the finish was not right',        bad: true },
        { label: 'Had to bring it back',     phrase: 'I had to bring it back',          bad: true }
      ]
    },
    {
      id: 'extra',
      kind: 'text',
      q: 'Anything else, in your own words?',
      note: 'Optional. This part goes in exactly as you write it.',
      placeholder: 'Whatever you would tell a friend about it.'
    }
  ];

  /* "a, b and c" -- Oxford comma left off deliberately, because this is
     meant to read like a person wrote it, not like a form filled itself in. */
  function list(items) {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function sentence(s) {
    s = (s || '').trim();
    if (!s) return '';
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return /[.!?]$/.test(s) ? s : s + '.';
  }

  function phrasesFor(stepId, labels) {
    var step = null;
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === stepId) step = STEPS[i];
    if (!step || !step.options) return [];
    var out = [];
    // Driven by the question's own order rather than the order they were
    // tapped, so the sentence reads the same way every time.
    step.options.forEach(function (o) {
      if (labels.indexOf(o.label) !== -1) out.push(o);
    });
    return out;
  }

  /* answers: { work: [label], verdict: label, notes: [label], extra: string } */
  function buildDraft(answers) {
    answers = answers || {};
    var parts = [];

    var work = phrasesFor('work', answers.work || []).map(function (o) { return o.phrase; });
    if (work.length) parts.push(sentence('Carcis did ' + list(work) + ' for me'));

    var verdict = phrasesFor('verdict', answers.verdict ? [answers.verdict] : [])[0];
    if (verdict) parts.push(verdict.phrase);

    // Good and bad stay in separate sentences. Running them together with an
    // "and" quietly softens the complaint, which is exactly the edit this
    // file is not allowed to make.
    var notes = phrasesFor('notes', answers.notes || []);
    var good = notes.filter(function (o) { return !o.bad; }).map(function (o) { return o.phrase; });
    var bad  = notes.filter(function (o) { return o.bad; }).map(function (o) { return o.phrase; });
    if (good.length) parts.push(sentence(list(good)));
    if (bad.length)  parts.push(sentence(list(bad)));

    // Straight through, untouched apart from a full stop if they left it off.
    var extra = (answers.extra || '').trim();
    if (extra) parts.push(sentence(extra));

    return parts.join(' ');
  }

  var api = { STEPS: STEPS, buildDraft: buildDraft, list: list, sentence: sentence };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CarcisReview = api;
})(typeof self !== 'undefined' ? self : this);
