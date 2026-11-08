/* Review composer -- /review only.
 *
 * The point of this file: typing a paragraph on a phone is the reason people
 * abandon a review. So they talk instead, the browser transcribes it, and the
 * words stay theirs. Nothing here writes a review for anyone.
 *
 * The optional "tidy up" step sends what they said to /api/review-polish and
 * shows the result BESIDE their original, with their own version kept unless
 * they pick the other one. It only ever fixes wording. It never adds a fact,
 * an opinion or a feeling that was not already in what they said, and a
 * review that complains about us has to come back still complaining about us.
 *
 * Google has no way to prefill the text in its review box -- there is no URL
 * parameter for it and never has been. So the last step copies to the
 * clipboard and opens Google, and the page tells them to paste. That paste is
 * unavoidable; pretending otherwise just means they land on Google confused.
 */
(function () {
  var root = document.getElementById('composer');
  if (!root) return;

  var box       = document.getElementById('cpText');
  var micBtn    = document.getElementById('cpMic');
  var micLabel  = document.getElementById('cpMicLabel');
  var statusEl  = document.getElementById('cpStatus');
  var countEl   = document.getElementById('cpCount');
  var polishBtn = document.getElementById('cpPolish');
  var compare   = document.getElementById('cpCompare');
  var tidiedEl  = document.getElementById('cpTidied');
  var useMine   = document.getElementById('cpUseMine');
  var useTidied = document.getElementById('cpUseTidied');
  var goBtn     = document.getElementById('cpGo');
  var doneEl    = document.getElementById('cpDone');
  var doneHead  = doneEl ? doneEl.querySelector('.cp-done-head') : null;

  var POLISH_URL = root.getAttribute('data-polish') || '';

  function track(name) {
    try { if (window.clarity) window.clarity('event', name); } catch (e) {}
    try { if (window.gtag) window.gtag('event', name); } catch (e) {}
  }

  function say(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'cp-status' + (kind ? ' cp-status-' + kind : '');
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

  /* ----------------------------------------------------------- dictation */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null;
  var listening = false;
  var wantListening = false;   // the user's intent, separate from engine state
  var committed = '';          // everything finalised or typed
  var interim = '';

  function paint() {
    var joined = committed + (interim ? ' ' + interim : '');
    box.value = joined.replace(/\s+/g, ' ').replace(/^\s+/, '');
    refresh();
  }

  function setMic(on) {
    listening = on;
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.classList.toggle('cp-mic-live', on);
    micLabel.textContent = on ? 'Stop' : (committed ? 'Keep talking' : 'Tap and talk');
  }

  if (!SR) {
    // No speech engine: Firefox, and some iOS versions. The textarea is the
    // whole feature then, so get out of its way rather than leaving a button
    // on screen that cannot work.
    micBtn.hidden = true;
    say('Talking isn’t supported in this browser, so type it below — it works the same from there.');
  } else {
    micBtn.addEventListener('click', function () {
      if (listening) {
        wantListening = false;
        setMic(false);
        if (rec) { try { rec.stop(); } catch (e) {} }
        say(box.value.trim() ? 'Read it back and change anything that isn’t how you’d say it.' : '');
        return;
      }
      committed = box.value.trim();
      interim = '';
      wantListening = true;
      start();
      track('review_voice_start');
    });
  }

  function start() {
    rec = new SR();
    rec.lang = document.documentElement.lang || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = function () {
      setMic(true);
      say('Listening. Say it how you’d say it to a friend — pauses are fine.', 'live');
    };

    rec.onresult = function (e) {
      var pending = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          committed = (committed + ' ' + chunk.replace(/^\s+|\s+$/g, '')).replace(/^\s+/, '');
        } else {
          pending += chunk;
        }
      }
      interim = pending.replace(/^\s+|\s+$/g, '');
      paint();
    };

    rec.onerror = function (e) {
      var code = e.error || '';
      wantListening = false;
      setMic(false);
      interim = '';
      paint();

      if (code === 'not-allowed' || code === 'service-not-allowed') {
        say('The browser blocked the microphone. Allow it from the address bar, or just type below.', 'warn');
      } else if (code === 'no-speech') {
        say('Didn’t catch anything. Tap again and speak up, or type below.', 'warn');
      } else if (code === 'audio-capture') {
        say('No microphone found. Typing below works just as well.', 'warn');
      } else if (code === 'aborted') {
        say('');
      } else {
        say('Speech recognition stopped working. You can carry on typing below.', 'warn');
      }
    };

    rec.onend = function () {
      // Chrome ends the session by itself after a pause. While the button is
      // still pressed in, restart, so a long pause mid-thought does not
      // quietly end the dictation.
      if (wantListening) {
        try { rec.start(); return; } catch (e) {}
      }
      setMic(false);
      if (interim) {
        committed = (committed + ' ' + interim).replace(/^\s+/, '');
        interim = '';
      }
      paint();
    };

    try {
      rec.start();
    } catch (e) {
      wantListening = false;
      setMic(false);
      say('Couldn’t start the microphone. Type it below instead.', 'warn');
    }
  }

  // A manual edit becomes the new baseline, so dictating again appends to the
  // edited text rather than resurrecting what was replaced.
  box.addEventListener('input', function () {
    if (!listening) { committed = box.value; interim = ''; }
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
      polishBtn.textContent = 'Tidying…';
      say('');

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
        // An empty string is a deliberate answer, not a failure: the endpoint
        // checked the edit, decided it had drifted from what the customer
        // actually said, and withheld it. Saying "couldn't reach the service"
        // there would be a lie about something that worked correctly.
        var tidied = r.data.polished.trim();
        if (!tidied || tidied === mine) {
          say('Your wording already reads well — nothing worth changing.', 'ok');
          return;
        }
        tidiedEl.textContent = tidied;
        compare.hidden = false;
        say('');
        track('review_polish');
        compare.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }).catch(function () {
        say('Couldn’t reach the tidy-up service. What you’ve written is fine as it is — carry on.', 'warn');
      }).then(function () {
        polishBtn.textContent = 'Tidy up my wording';
        refresh();
      });
    });

    useTidied.addEventListener('click', function () {
      committed = tidiedEl.textContent;
      interim = '';
      paint();
      compare.hidden = true;
      say('Using the tidied version. Edit it freely — it’s your review.', 'ok');
    });

    useMine.addEventListener('click', function () {
      compare.hidden = true;
      say('Keeping your own words.', 'ok');
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
  setMic(false);
})();
