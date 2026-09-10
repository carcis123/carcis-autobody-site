(function () {
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Scroll reveal
  var revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    if (reduceMotion) {
      revealEls.forEach(function (el) { el.classList.add('in'); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry, i) {
          if (entry.isIntersecting) {
            setTimeout(function () { entry.target.classList.add('in'); }, i * 40);
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15 });
      revealEls.forEach(function (el) { io.observe(el); });
    }
  }

  // Mobile nav
  var toggle = document.getElementById('navToggle');
  var mobile = document.getElementById('navMobile');
  var closeBtn = document.getElementById('navClose');
  if (toggle && mobile) {
    var FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

    function focusableItems() {
      return Array.prototype.filter.call(
        mobile.querySelectorAll(FOCUSABLE),
        function (el) { return el.offsetParent !== null || el === document.activeElement; }
      );
    }

    function openNav() {
      mobile.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      var items = focusableItems();
      if (items.length) items[0].focus();
      document.addEventListener('keydown', onKeydown);
    }

    function closeNav() {
      mobile.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeydown);
      toggle.focus();
    }

    // Escape closes the menu; Tab is trapped inside it while it is open, so
    // keyboard focus cannot wander onto the page hidden behind the overlay.
    function onKeydown(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        closeNav();
        return;
      }
      if (e.key !== 'Tab') return;
      var items = focusableItems();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    toggle.addEventListener('click', openNav);
    if (closeBtn) closeBtn.addEventListener('click', closeNav);
    mobile.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', closeNav); });
  }

  // Before/after slider (Home + Estimate pages)
  var frame = document.getElementById('sliderFrame');
  var input = document.getElementById('sliderInput');
  if (frame && input) {
    function setSplit(pct) {
      pct = Math.max(0, Math.min(100, pct));
      frame.style.setProperty('--split', pct + '%');
      input.value = pct;
    }
    input.addEventListener('input', function () { setSplit(parseFloat(input.value)); });

    var dragging = false;
    function pctFromClientX(clientX) {
      var rect = frame.getBoundingClientRect();
      return ((clientX - rect.left) / rect.width) * 100;
    }
    frame.addEventListener('pointerdown', function (e) {
      dragging = true;
      setSplit(pctFromClientX(e.clientX));
    });
    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      setSplit(pctFromClientX(e.clientX));
    });
    window.addEventListener('pointerup', function () { dragging = false; });

    if (!reduceMotion) {
      var t0 = null;
      function introSweep(ts) {
        if (t0 === null) t0 = ts;
        var elapsed = ts - t0;
        var dur = 1400;
        if (elapsed < dur) {
          var p = elapsed / dur;
          var eased = 1 - Math.pow(1 - p, 3);
          setSplit(eased * 62);
          requestAnimationFrame(introSweep);
        } else {
          setSplit(50);
        }
      }
      setTimeout(function () { requestAnimationFrame(introSweep); }, 500);
    } else {
      setSplit(50);
    }
  }

})();
