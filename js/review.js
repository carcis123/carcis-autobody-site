/* Carcis AI review composer -- /review only.
 *
 * What this is for: typing a paragraph on a phone is the reason reviews get
 * abandoned half-written. So instead of asking for a paragraph, it asks four
 * short questions that can be answered by tapping, and assembles the answers
 * into a draft the customer then edits and sends. The box underneath is a
 * first-class way in on its own -- plenty of people will ignore the questions
 * and just write, and nothing here gets in their way.
 *
 * This replaced a version built on the Web Speech API. Talking was a better
 * idea on paper, but the browser engine proved too unreliable to put in front
 * of a customer: it differs per platform, it leans on Google's servers, and
 * it fails in ways the page cannot see or explain. Tapping a chip has none of
 * those failure modes.
 *
 * The sentences themselves live in review-draft.js, which is pure and tested
 * on its own. The division matters: this file moves things around a screen,
 * that one decides what a review says, and only one of those two is worth
 * being paranoid about.
 *
 * Google has no way to prefill the text in its review box -- there is no URL
 * parameter for it and never has been. So the last step copies to the
 * clipboard and opens Google, and the page says plainly that a paste is
 * coming. Pretending otherwise just lands people on Google confused.
 */
(function () {
  var root = document.getElementById('composer');
  if (!root) return;

  var W = window.CarcisReview;
  var box       = document.getElementById('cpText');
  var countEl   = document.getElementById('cpCount');
  var polishBtn = document.getElementById('cpPolish');
  var compare   = document.getElementById('cpCompare');
  var tidiedEl  = document.getElementById('cpTidied');
  var useMine   = document.getElementById('cpUseMine');
  var useTidied = document.getElementById('cpUseTidied');
  var goBtn     = document.getElementById('cpGo');
  var doneEl    = document.getElementById('cpDone');
  var doneHead  = doneEl ? doneEl.querySelector('.cp-done-head') : null;
  var wizEl     = document.getElementById('cpWizard');
  var noteEl    = document.getElementById('cpNote');
  var draftNote = document.getElementById('cpDraftNote');

  var POLISH_URL = root.getAttribute('data-polish') || '';

  function track(name) {
    try { if (window.clarity) window.clarity('event', name); } catch (e) {}
    try { if (window.gtag) window.gtag('event', name); } catch (e) {}
  }

  function note(msg) {
    if (!noteEl) return;
    noteEl.textContent = msg || '';
    noteEl.hidden = !msg;
  }

  /* ----------------------------------------------------------- word count */

  function words(s) {
    var t = (s || '').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function refresh() {
    var n = words(box.value);
    countEl.textContent = n === 0 ? '' : n + (n === 1 ? ' word' : ' words');
    // Two sentences is what the page asks for, so about 15 words is the point
    // where it is worth posting. Encouragement, never a gate.
    countEl.className = 'cp-count' + (n >= 15 ? ' cp-count-ok' : '');
    goBtn.classList.toggle('cp-go-off', n === 0);
    if (polishBtn) polishBtn.disabled = n < 8;
  }

  /* ------------------------------------------------------------- wizard --
     Built in script rather than written out in the template because the
     questions and their wording live in one place, review-draft.js, and
     having the markup restate them is how the two drift apart. If that file
     fails to load there is simply no wizard, and the textarea below carries
     on working on its own. */

  var answers = { work: [], verdict: '', notes: [], extra: '' };
  var step = 0;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function answered(s) {
    if (s.kind === 'single') return !!answers[s.id];
    if (s.kind === 'multi') return answers[s.id].length > 0;
    return true;                       // free text is always optional
  }

  function toggle(s, label) {
    if (s.kind === 'single') {
      answers[s.id] = answers[s.id] === label ? '' : label;
    } else {
      var at = answers[s.id].indexOf(label);
      if (at === -1) answers[s.id].push(label); else answers[s.id].splice(at, 1);
    }
  }

  function render() {
    var steps = W.STEPS;
    var s = steps[step];
    wizEl.textContent = '';

    var head = el('div', 'wz-head');
    head.appendChild(el('span', 'wz-count', 'Question ' + (step + 1) + ' of ' + steps.length));
    var dots = el('span', 'wz-dots');
    steps.forEach(function (_, i) {
      dots.appendChild(el('span', 'wz-dot' + (i === step ? ' wz-dot-on' : (i < step ? ' wz-dot-done' : ''))));
    });
    head.appendChild(dots);
    wizEl.appendChild(head);

    wizEl.appendChild(el('h3', 'wz-q', s.q));
    if (s.note) wizEl.appendChild(el('p', 'wz-note', s.note));

    if (s.kind === 'text') {
      var ta = el('textarea', 'wz-text');
      ta.rows = 4;
      ta.placeholder = s.placeholder || '';
      ta.value = answers[s.id];
      ta.addEventListener('input', function () { answers[s.id] = ta.value; });
      wizEl.appendChild(ta);
    } else {
      var wrap = el('div', 'wz-chips');
      s.options.forEach(function (o) {
        var on = s.kind === 'single'
          ? answers[s.id] === o.label
          : answers[s.id].indexOf(o.label) !== -1;
        var b = el('button', 'wz-chip' + (on ? ' wz-chip-on' : '') + (o.bad ? ' wz-chip-bad' : ''), o.label);
        b.type = 'button';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.addEventListener('click', function () { toggle(s, o.label); render(); });
        wrap.appendChild(b);
      });
      wizEl.appendChild(wrap);
    }

    var nav = el('div', 'wz-nav');
    if (step > 0) {
      var back = el('button', 'wz-back', 'Back');
      back.type = 'button';
      back.addEventListener('click', function () { step--; render(); });
      nav.appendChild(back);
    }

    var last = step === steps.length - 1;
    var next = el('button', 'btn btn-primary wz-next', last ? 'Write my review' : 'Next');
    next.type = 'button';
    if (s.required && !answered(s)) next.disabled = true;
    next.addEventListener('click', function () {
      if (last) { finish(); return; }
      step++;
      render();
    });
    nav.appendChild(next);

    // Never a dead end: a question can always be skipped, except the one the
    // review cannot be built without.
    if (!last && !(s.required && !answered(s))) {
      var skip = el('button', 'wz-skip', 'Skip');
      skip.type = 'button';
      skip.addEventListener('click', function () { step++; render(); });
      nav.appendChild(skip);
    }

    wizEl.appendChild(nav);
  }

  function finish() {
    var draft = W.buildDraft(answers);
    if (!draft) { box.focus(); return; }
    // Added to whatever is already in the box rather than replacing it:
    // someone who typed first and then ran the questions did not ask for
    // their own words to be thrown away.
    var existing = box.value.trim();
    box.value = existing ? existing + ' ' + draft : draft;
    refresh();
    if (compare) compare.hidden = true;
    if (doneEl) doneEl.hidden = true;
    if (draftNote) draftNote.hidden = false;
    note('');
    track('review_wizard_done');
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Focus after the scroll, so the caret lands somewhere they can see it.
    setTimeout(function () {
      box.focus();
      try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) {}
    }, 320);
  }

  if (wizEl && W) {
    render();
  } else if (wizEl) {
    // review-draft.js did not load. Nothing clever to say -- get out of the
    // way of the part that always works.
    wizEl.hidden = true;
  }

  box.addEventListener('input', function () {
    refresh();
    if (compare) compare.hidden = true;
    if (doneEl) doneEl.hidden = true;
  });

  /* ------------------------------------------------------------- tidy up */

  if (polishBtn && POLISH_URL) {
    polishBtn.addEventListener('click', function () {
      var mine = box.value.trim();
      if (words(mine) < 8) return;

      polishBtn.disabled = true;
      polishBtn.textContent = 'Thinking…';
      note('');
      // Which text this answer is for. A suggestion that arrives after the
      // customer has rewritten the review is advice about a review that no
      // longer exists, and showing it invites them to accept words they did
      // not write.
      var askedAbout = mine;

      fetch(POLISH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: mine })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, data: data };
        });
      }).then(function (r) {
        var sent = r.data && typeof r.data.polished === 'string';
        if (!r.ok || !sent) throw new Error('unavailable');
        if (box.value.trim() !== askedAbout) {
          note('You’ve changed it since — press the button again for a fresh suggestion.');
          return;
        }
        // An empty string is a deliberate answer, not a failure: the endpoint
        // checked the edit, decided it had drifted from what the customer
        // actually said, and withheld it.
        var tidied = r.data.polished.trim();
        if (!tidied || tidied === mine) {
          note('Carcis AI didn’t find anything worth changing — it already reads well.');
          return;
        }
        tidiedEl.textContent = tidied;
        compare.hidden = false;
        track('review_polish');
        compare.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }).catch(function () {
        note('Couldn’t reach Carcis AI. What you’ve written is fine as it is — carry on.');
      }).then(function () {
        polishBtn.textContent = 'Ask Carcis AI to tidy it up';
        refresh();
      });
    });

    useTidied.addEventListener('click', function () {
      box.value = tidiedEl.textContent;
      refresh();
      compare.hidden = true;
      note('Using the tidied version. Edit it freely — it’s your review.');
    });

    useMine.addEventListener('click', function () {
      compare.hidden = true;
      note('Keeping your own words.');
    });
  } else if (polishBtn) {
    polishBtn.hidden = true;
  }

  /* -------------------------------------------------- copy and hand over */

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Older Safari, and any non-secure context.
    return new Promise(function (resolve, reject) {
      var tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.setAttribute('readonly', '');
      tmp.style.position = 'fixed';
      tmp.style.top = '-1000px';
      document.body.appendChild(tmp);
      tmp.select();
      tmp.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(tmp);
      if (ok) { resolve(); } else { reject(new Error('copy failed')); }
    });
  }

  // goBtn is a real link, so the new tab opens from the click itself and
  // cannot be swallowed by a popup blocker. The copy rides along beside it.
  goBtn.addEventListener('click', function (e) {
    var text = box.value.trim();
    if (!text) { e.preventDefault(); box.focus(); return; }

    copy(text).then(function () {
      doneEl.hidden = false;
      if (doneHead) doneHead.textContent = 'Copied. Now paste it into the box on Google.';
    }).catch(function () {
      doneEl.hidden = false;
      if (doneHead) {
        doneHead.textContent = 'Couldn’t copy it for you — select the text above and copy it yourself.';
      }
      box.select();
    });

    track('review_copy_open');
  });

  refresh();
})();
