/* ============================================================
   Electronic English — интерактивные тесты
   Прогресс, таймер, имя ученика, подсветка ответов, конфетти
   ============================================================ */
(function () {
    'use strict';

    var STORAGE_KEY = 'electronic-english-progress-v1';
    var TEST_IDS = ['test1', 'test2'];

    /* --- Отправка результатов в Google Таблицу ---
       После настройки Apps Script (см. teacher-setup.md) вставьте сюда
       URL веб-приложения (заканчивается на /exec) и тот же секрет,
       что указан в Code.gs. Пока строки пустые — отправка выключена. */
    var REPORT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzm5EnYYr0jK_uIzuUkAGBxfb8VVAJWngTP2JihNK1b4WtpeZlz8LVd3wzZJG1DOPE1/exec';
    var REPORT_SECRET = 'CHANGE_ME_2026';
    var REPORT_TIMEOUT_MS = 20000;
    var reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    var state = {
        name: '',
        tests: {
            test1: { answers: {}, elapsed: 0, checked: false, correct: 0, attempts: 0, sent: false, attemptId: '', sentAt: 0 },
            test2: { answers: {}, elapsed: 0, checked: false, correct: 0, attempts: 0, sent: false, attemptId: '', sentAt: 0 }
        }
    };
    var storageOK = true;
    var timers = { test1: null, test2: null };
    var saveTimer = null;
    var activeTest = 'test1';
    var dock = null;
    var dockChips = {};

    /* ---------------- утилиты ---------------- */
    function $(selector, root) { return (root || document).querySelector(selector); }
    function $$(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function formatTime(seconds) {
        seconds = Math.max(0, Math.floor(seconds));
        return pad2(Math.floor(seconds / 60)) + ':' + pad2(seconds % 60);
    }
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }
    function scrollToEl(el, block) {
        if (!el) return;
        var behavior = (reducedMotion && reducedMotion.matches) ? 'auto' : 'smooth';
        try { el.scrollIntoView({ behavior: behavior, block: block || 'center' }); }
        catch (e) { el.scrollIntoView(); }
    }
    function flashCard(card) {
        if (!card) return;
        card.classList.add('attention');
        setTimeout(function () { card.classList.remove('attention'); }, 2200);
    }

    /* ---------------- сохранение прогресса ---------------- */
    function loadState() {
        var raw;
        try { raw = window.localStorage.getItem(STORAGE_KEY); }
        catch (e) { storageOK = false; return; }
        if (!raw) return;
        var data;
        try { data = JSON.parse(raw); } catch (e) { return; }
        if (!data || typeof data !== 'object') return;

        if (typeof data.name === 'string') state.name = data.name.slice(0, 40);

        TEST_IDS.forEach(function (id) {
            var src = data.tests && data.tests[id];
            if (!src || typeof src !== 'object') return;
            var dst = state.tests[id];
            if (src.answers && typeof src.answers === 'object' && !Array.isArray(src.answers)) {
                dst.answers = src.answers;
            }
            if (typeof src.elapsed === 'number' && isFinite(src.elapsed)) {
                dst.elapsed = Math.max(0, Math.floor(src.elapsed));
            }
            dst.checked = src.checked === true;
            if (typeof src.correct === 'number' && isFinite(src.correct)) {
                dst.correct = Math.max(0, Math.floor(src.correct));
            }
            if (typeof src.attempts === 'number' && isFinite(src.attempts)) {
                dst.attempts = Math.max(0, Math.floor(src.attempts));
            }
            dst.sent = src.sent === true;
            if (typeof src.attemptId === 'string') dst.attemptId = src.attemptId;
            if (typeof src.sentAt === 'number' && isFinite(src.sentAt)) dst.sentAt = src.sentAt;
        });
    }

    function writeState() {
        saveTimer = null;
        if (!storageOK) return;
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
        catch (e) { storageOK = false; }
    }

    function saveState(immediate) {
        if (immediate) {
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            writeState();
            return;
        }
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(writeState, 350);
    }

    /* ---------------- таймер ---------------- */
    function renderTimer(testId) {
        if (!dock || testId !== activeTest) return;
        var el = dock.querySelector('.dock-timer-value');
        if (el) el.textContent = formatTime(state.tests[testId].elapsed);
    }

    function startTimer(testId) {
        var test = state.tests[testId];
        if (timers[testId] || test.checked) return;
        timers[testId] = setInterval(function () {
            if (document.hidden) return; // не считаем время, пока вкладка неактивна
            test.elapsed += 1;
            renderTimer(testId);
            if (test.elapsed % 5 === 0) saveState();
        }, 1000);
    }

    function stopTimer(testId) {
        if (timers[testId]) {
            clearInterval(timers[testId]);
            timers[testId] = null;
        }
    }

    /* ---------------- элементы тестов ---------------- */
    function cardsOf(testId) {
        return $$('#' + testId + ' .test-question');
    }
    function cardKey(card) {
        return 'q' + (card.getAttribute('data-question') || '');
    }
    function isAnswered(card, testId) {
        if (testId === 'test1') return card.querySelector('input[type="checkbox"]:checked') !== null;
        return card.querySelector('.choice-btn.selected') !== null;
    }
    function answeredCount(testId) {
        return cardsOf(testId).filter(function (card) { return isAnswered(card, testId); }).length;
    }

    function collectAnswers(testId) {
        var answers = {};
        cardsOf(testId).forEach(function (card) {
            if (testId === 'test1') {
                var values = $$('input[type="checkbox"]:checked', card).map(function (input) { return input.value; });
                if (values.length) answers[cardKey(card)] = values;
            } else {
                var buttons = $$('.choice-btn', card);
                var index = -1;
                for (var i = 0; i < buttons.length; i++) {
                    if (buttons[i].classList.contains('selected')) { index = i; break; }
                }
                if (index !== -1) answers[cardKey(card)] = index;
            }
        });
        return answers;
    }

    function restoreAnswers(testId) {
        var answers = state.tests[testId].answers || {};
        cardsOf(testId).forEach(function (card) {
            var saved = answers[cardKey(card)];
            if (saved === undefined || saved === null) return;
            if (testId === 'test1') {
                if (!Array.isArray(saved)) return;
                $$('input[type="checkbox"]', card).forEach(function (input) {
                    input.checked = saved.indexOf(input.value) !== -1;
                });
            } else if (typeof saved === 'number') {
                var buttons = $$('.choice-btn', card);
                if (buttons[saved]) buttons[saved].classList.add('selected');
            }
        });
    }

    function renderProgress(testId) {
        var total = cardsOf(testId).length;
        var answered = answeredCount(testId);
        var test = state.tests[testId];

        var submitBtn = $('#' + testId + ' .submit-test-btn');
        if (submitBtn) submitBtn.disabled = test.checked || answered < total;

        var hint = $('#' + testId + ' .submit-hint');
        if (hint) {
            if (test.checked) {
                hint.textContent = 'Тест проверен. Чтобы исправить ответы, нажмите «Пройти тест заново».';
            } else if (answered < total) {
                hint.textContent = 'Ответьте на все вопросы, чтобы проверить результат.';
            } else {
                hint.textContent = 'Всё готово! Можно проверять. ✅';
            }
        }

        renderDock();
    }

    /* ---------------- нижняя панель прогресса ---------------- */
    function setupDock() {
        dock = document.getElementById('progressDock');
        if (!dock) return;

        TEST_IDS.forEach(function (id) {
            var chip = dock.querySelector('.dock-chip[data-test="' + id + '"]');
            dockChips[id] = chip;
            if (!chip) return;
            chip.addEventListener('click', function () {
                activeTest = id;
                renderDock();
                var section = document.getElementById(id);
                if (section) scrollToEl(section, 'start');
            });
        });

        var nextBtn = dock.querySelector('.dock-next');
        if (nextBtn) {
            nextBtn.addEventListener('click', function () {
                var card = cardsOf(activeTest).filter(function (c) { return !isAnswered(c, activeTest); })[0];
                if (card) { scrollToEl(card, 'center'); flashCard(card); }
            });
        }

        window.addEventListener('scroll', scheduleDockUpdate, { passive: true });
        window.addEventListener('resize', scheduleDockUpdate);
        updateDockFromScroll();
    }

    var dockScrollRaf = null;
    function scheduleDockUpdate() {
        if (dockScrollRaf) return;
        dockScrollRaf = window.requestAnimationFrame(function () {
            dockScrollRaf = null;
            updateDockFromScroll();
        });
    }

    function updateDockFromScroll() {
        if (!dock) return;
        var mid = window.innerHeight / 2;
        var found = null;
        TEST_IDS.forEach(function (id) {
            var section = document.getElementById(id);
            if (!section) return;
            var rect = section.getBoundingClientRect();
            if (rect.top <= mid && rect.bottom >= mid) found = id;
        });
        if (!found) {
            var first = document.getElementById(TEST_IDS[0]);
            found = (first && first.getBoundingClientRect().top > mid) ? TEST_IDS[0] : TEST_IDS[TEST_IDS.length - 1];
        }
        if (found !== activeTest) {
            activeTest = found;
            renderDock();
        }
    }

    function renderDock() {
        if (!dock) return;

        TEST_IDS.forEach(function (id) {
            var chip = dockChips[id];
            if (!chip) return;
            var total = cardsOf(id).length;
            var answered = answeredCount(id);
            chip.querySelector('.dock-chip-answered').textContent = String(answered);
            chip.querySelector('.dock-chip-total').textContent = String(total);
            chip.classList.toggle('is-active', id === activeTest);
            chip.classList.toggle('is-complete', answered === total);
            chip.classList.toggle('is-checked', state.tests[id].checked);
            chip.setAttribute('aria-pressed', id === activeTest ? 'true' : 'false');
        });

        var total = cardsOf(activeTest).length;
        var answered = answeredCount(activeTest);
        var percent = total ? Math.round((answered / total) * 100) : 0;
        var answeredEl = dock.querySelector('.dock-answered');
        var totalEl = dock.querySelector('.dock-total');
        var remainingEl = dock.querySelector('.dock-remaining');
        var fill = dock.querySelector('.dock-fill');
        var bar = dock.querySelector('.dock-bar');
        var timerEl = dock.querySelector('.dock-timer-value');
        var nextBtn = dock.querySelector('.dock-next');

        if (answeredEl) answeredEl.textContent = String(answered);
        if (totalEl) totalEl.textContent = String(total);
        if (remainingEl) remainingEl.textContent = 'осталось ' + (total - answered);
        if (fill) fill.style.width = percent + '%';
        if (bar) bar.setAttribute('aria-valuenow', String(percent));
        if (timerEl) timerEl.textContent = formatTime(state.tests[activeTest].elapsed);
        if (nextBtn) nextBtn.hidden = answered === total;
    }

    /* ---------------- оценка ответов ---------------- */
    function evaluateCard(card, testId) {
        if (testId === 'test1') {
            var correct = $$('input[data-correct="true"]', card).map(function (input) { return input.value; }).sort();
            var selected = $$('input[type="checkbox"]:checked', card).map(function (input) { return input.value; }).sort();
            return correct.length > 0 && correct.join(',') === selected.join(',');
        }
        var buttons = $$('.choice-btn', card);
        var correctIndex = -1;
        var selectedIndex = -1;
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].getAttribute('data-correct') === 'true') correctIndex = i;
            if (buttons[i].classList.contains('selected')) selectedIndex = i;
        }
        return correctIndex !== -1 && selectedIndex === correctIndex;
    }

    function correctAnswerText(card, testId) {
        if (testId === 'test1') {
            return $$('input[data-correct="true"]', card).map(function (input) {
                var label = input.closest ? input.closest('.checkbox-label') : null;
                var span = label ? label.querySelector('span') : null;
                return span ? span.textContent.trim() : input.value;
            }).join(', ');
        }
        var buttons = $$('.choice-btn', card);
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].getAttribute('data-correct') === 'true') return buttons[i].textContent.trim();
        }
        return '';
    }

    function applyFeedback(card, testId, ok, animate) {
        if (testId === 'test1') {
            $$('.checkbox-label', card).forEach(function (label) {
                label.classList.remove('correct-option', 'wrong-option');
                var input = label.querySelector('input[type="checkbox"]');
                if (!input) return;
                if (input.getAttribute('data-correct') === 'true') {
                    label.classList.add('correct-option');
                } else if (input.checked) {
                    label.classList.add('wrong-option');
                }
            });
        } else {
            $$('.choice-btn', card).forEach(function (btn) {
                btn.classList.remove('selected-correct', 'selected-wrong', 'show-correct');
                var isCorrect = btn.getAttribute('data-correct') === 'true';
                if (isCorrect) btn.classList.add('show-correct');
                if (btn.classList.contains('selected')) {
                    btn.classList.add(isCorrect ? 'selected-correct' : 'selected-wrong');
                }
            });
        }

        var message = $('.result-message', card);
        if (message) {
            if (ok) {
                message.innerHTML = '✅ Правильно!';
                message.className = 'result-message correct-message';
            } else {
                var answer = correctAnswerText(card, testId);
                message.innerHTML = '❌ Неправильно!';
                if (answer) {
                    message.innerHTML += '<span class="answer-hint">Правильный ответ: ' + escapeHtml(answer) + '</span>';
                }
                message.className = 'result-message wrong-message';
            }
        }

        card.classList.remove('question-correct', 'question-wrong');
        if (animate) {
            void card.offsetWidth; // перезапуск CSS-анимации
            card.classList.add(ok ? 'question-correct' : 'question-wrong');
            setTimeout(function () {
                card.classList.remove('question-correct', 'question-wrong');
            }, 900);
        }
    }

    function lockTest(testId, locked) {
        var section = document.getElementById(testId);
        if (!section) return;
        $$('input[type="checkbox"]', section).forEach(function (input) { input.disabled = locked; });
        $$('.choice-btn', section).forEach(function (btn) { btn.disabled = locked; });
        $$('.test-question', section).forEach(function (card) {
            card.classList.toggle('is-locked', locked);
        });
    }

    /* ---------------- проверка теста ---------------- */
    function checkTest(testId, options) {
        options = options || {};
        if (!options.restored) activeTest = testId;
        var test = state.tests[testId];
        var cards = cardsOf(testId);
        var correctCount = 0;
        var wrong = [];

        cards.forEach(function (card) {
            var ok = evaluateCard(card, testId);
            if (ok) correctCount += 1;
            else wrong.push(Number(card.getAttribute('data-question')) || 0);
            applyFeedback(card, testId, ok, options.restored !== true);
        });

        test.answers = collectAnswers(testId);
        test.checked = true;
        test.correct = correctCount;

        if (!options.restored) {
            test.attempts = (test.attempts || 0) + 1;
            test.attemptId = testId + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
            test.sent = false;
            test.sentAt = 0;
        }

        stopTimer(testId);
        lockTest(testId, true);
        renderProgress(testId);
        showResult(testId, correctCount, cards.length, wrong, options);
        saveState(true);
    }

    /* ---------------- отправка результата учителю (Google Таблица) ---------------- */
    function isReportEnabled() {
        return /^https:\/\/script\.google\.com\//.test(REPORT_ENDPOINT);
    }

    function buildReportPayload(testId) {
        var cards = cardsOf(testId);
        var test = state.tests[testId];
        var wrong = [];
        cards.forEach(function (card) {
            if (!evaluateCard(card, testId)) wrong.push(Number(card.getAttribute('data-question')) || 0);
        });
        return {
            attemptId: test.attemptId || '',
            name: (state.name || '').trim() || 'Без имени',
            test: testId,
            testTitle: testId === 'test1' ? 'Тест №1' : 'Тест №2',
            score: test.correct,
            total: cards.length,
            percent: cards.length ? Math.round((test.correct / cards.length) * 100) : 0,
            timeSec: test.elapsed,
            wrong: wrong,
            attempt: test.attempts || 1,
            date: new Date().toISOString(),
            url: window.location.href
        };
    }

    // JSONP: работает и с file://, и с любого хостинга, не требует CORS.
    var reportSeq = 0;

    function sendReport(testId, done) {
        if (!isReportEnabled()) { done(false, 'disabled'); return; }

        var payload = buildReportPayload(testId);
        var callbackName = '__eeReport_' + (++reportSeq) + '_' + Math.random().toString(36).slice(2, 8);
        var script = document.createElement('script');
        var finished = false;
        var timer = null;

        function cleanup() {
            if (timer) { clearTimeout(timer); timer = null; }
            try { delete window[callbackName]; } catch (e) { window[callbackName] = undefined; }
            if (script.parentNode) script.parentNode.removeChild(script);
        }

        function finish(ok, error) {
            if (finished) return;
            finished = true;
            cleanup();
            done(ok, error);
        }

        window[callbackName] = function (response) {
            finish(!!(response && response.ok), response && response.error);
        };

        timer = setTimeout(function () { finish(false, 'timeout'); }, REPORT_TIMEOUT_MS);
        script.onerror = function () { finish(false, 'network'); };

        script.src = REPORT_ENDPOINT +
            (REPORT_ENDPOINT.indexOf('?') === -1 ? '?' : '&') +
            'data=' + encodeURIComponent(JSON.stringify(payload)) +
            '&callback=' + callbackName +
            '&secret=' + encodeURIComponent(REPORT_SECRET) +
            '&t=' + Date.now();

        document.body.appendChild(script);
    }

    function setReportStatus(block, kind, text) {
        if (!block) return;
        var status = block.querySelector('.report-status');
        var button = block.querySelector('.report-btn');
        if (status) {
            status.textContent = text || '';
            status.className = 'report-status' + (kind ? ' is-' + kind : '');
        }
        if (button) button.disabled = kind === 'sending';
    }

    function bindReportBlock(testId, container, restored) {
        if (!isReportEnabled()) return;
        var block = container.querySelector('.report-block');
        if (!block) return;

        var test = state.tests[testId];
        var button = block.querySelector('.report-btn');

        function showSavedState() {
            if (test.sent && test.sentAt) {
                var sentTime = new Date(test.sentAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                setReportStatus(block, 'ok', '✅ Результат отправлен учителю в ' + sentTime);
                if (button) button.textContent = '📤 Отправить ещё раз';
            } else {
                setReportStatus(block, 'idle', '');
                if (button) button.textContent = '📤 Отправить учителю';
            }
        }

        function submit() {
            setReportStatus(block, 'sending', '⏳ Отправляю результат учителю…');
            if (button) button.textContent = '⏳ Отправка…';

            sendReport(testId, function (ok) {
                if (ok) {
                    test.sent = true;
                    test.sentAt = Date.now();
                    saveState(true);
                    showSavedState();
                } else {
                    setReportStatus(block, 'error', '⚠️ Не удалось отправить. Проверьте интернет и попробуйте снова.');
                    if (button) {
                        button.disabled = false;
                        button.textContent = '📤 Повторить отправку';
                    }
                }
            });
        }

        if (button) button.addEventListener('click', submit);
        showSavedState();

        // при свежей проверке отправляем автоматически; при восстановлении — нет
        if (!restored) {
            setTimeout(submit, 400);
        }
    }

    /* ---------------- результат ---------------- */
    function showResult(testId, correct, total, wrong, options) {
        options = options || {};
        var container = document.getElementById(testId + '-result');
        if (!container) return;

        var percentage = total > 0 ? Math.round((correct / total) * 100) : 0;
        var grade;
        if (percentage === 100) grade = '🏆 Отлично! 🏆';
        else if (percentage >= 80) grade = '✅ Хорошо! ✅';
        else if (percentage >= 60) grade = '📚 Удовлетворительно! 📚';
        else grade = '📖 Нужно повторить! 📖';

        var name = (state.name || '').trim();
        var time = formatTime(state.tests[testId].elapsed);
        var wrongDetails = '';

        if (wrong.length) {
            var chips = wrong.map(function (num) {
                return '<button class="wrong-chip" type="button" data-question="' + num + '">Вопрос ' + num + '</button>';
            }).join('');
            wrongDetails = '<div class="score-details">' +
                '<p><strong>❌ Неправильные ответы:</strong></p>' +
                '<div class="wrong-chips">' + chips + '</div>' +
                '</div>';
        }

        var reportHtml = isReportEnabled()
            ? '<div class="report-block">' +
                '<div class="report-status" role="status" aria-live="polite"></div>' +
                '<button class="report-btn" type="button">📤 Отправить учителю</button>' +
              '</div>'
            : '';

        container.innerHTML =
            '<h3>📊 Результат теста</h3>' +
            (name ? '<p class="result-name">' + escapeHtml(name) + ', вот твой результат:</p>' : '') +
            '<p class="result-score">' + correct + ' / ' + total + ' правильных ответов</p>' +
            '<p class="result-percent">' + percentage + '%</p>' +
            '<p class="result-grade">' + grade + '</p>' +
            '<p class="result-time">⏱ Затраченное время: ' + time + '</p>' +
            wrongDetails +
            (percentage < 80 ? '<p class="result-advice">💡 Совет: посмотри видео ещё раз и попробуй снова.</p>' : '') +
            reportHtml +
            '<button class="retry-test-btn" type="button">🔄 Пройти тест заново</button>';

        container.className = 'test-result-container show ' + (percentage >= 60 ? 'success' : 'fail');
        container.style.display = '';

        var retryBtn = container.querySelector('.retry-test-btn');
        if (retryBtn) retryBtn.addEventListener('click', function () { retryTest(testId); });

        $$('.wrong-chip', container).forEach(function (chip) {
            chip.addEventListener('click', function () {
                var num = chip.getAttribute('data-question');
                var card = cardsOf(testId).filter(function (c) {
                    return c.getAttribute('data-question') === num;
                })[0];
                if (card) { scrollToEl(card, 'center'); flashCard(card); }
            });
        });

        bindReportBlock(testId, container, options.restored === true);

        if (options.restored) return;

        if (percentage === 100) launchConfetti();

        setTimeout(function () {
            scrollToEl(container, 'center');
        }, 220);
    }

    /* ---------------- сброс ---------------- */
    function clearTestDom(testId) {
        var section = document.getElementById(testId);
        var container = document.getElementById(testId + '-result');

        if (section) {
            $$('input[type="checkbox"]', section).forEach(function (input) {
                input.checked = false;
                input.disabled = false;
            });
            $$('.choice-btn', section).forEach(function (btn) {
                btn.disabled = false;
                btn.classList.remove('selected', 'selected-correct', 'selected-wrong', 'show-correct');
            });
            $$('.checkbox-label', section).forEach(function (label) {
                label.classList.remove('correct-option', 'wrong-option');
            });
            $$('.test-question', section).forEach(function (card) {
                card.classList.remove('is-locked', 'question-correct', 'question-wrong', 'attention');
            });
            $$('.result-message', section).forEach(function (message) {
                message.textContent = '';
                message.className = 'result-message';
            });
        }

        if (container) {
            container.innerHTML = '';
            container.className = 'test-result-container';
            container.style.display = '';
        }
    }

    function retryTest(testId) {
        activeTest = testId;
        var test = state.tests[testId];
        test.checked = false;
        test.correct = 0;
        test.answers = {};
        test.elapsed = 0;
        test.sent = false;
        test.attemptId = '';
        test.sentAt = 0;

        stopTimer(testId);
        clearTestDom(testId);
        renderTimer(testId);
        renderProgress(testId);
        saveState(true);

        var section = document.getElementById(testId);
        if (section) scrollToEl(section, 'start');
        startTimer(testId);
    }

    function resetAll() {
        if (!window.confirm('Сбросить имя ученика, все ответы и результаты тестов?')) return;

        activeTest = TEST_IDS[0];
        TEST_IDS.forEach(function (id) {
            stopTimer(id);
            state.tests[id] = { answers: {}, elapsed: 0, checked: false, correct: 0, attempts: 0, sent: false, attemptId: '', sentAt: 0 };
            clearTestDom(id);
            renderTimer(id);
            renderProgress(id);
        });

        state.name = '';
        var input = document.getElementById('studentName');
        if (input) input.value = '';
        renderGreeting();

        try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
        saveState(true);
    }

    /* ---------------- тема ---------------- */
    var THEME_KEY = 'electronic-english-theme';

    function initTheme() {
        var root = document.documentElement;
        var button = document.getElementById('themeToggle');
        var icon = button ? button.querySelector('.theme-icon') : null;
        var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

        function currentTheme() {
            return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        }

        function applyTheme(theme, persist) {
            root.setAttribute('data-theme', theme);
            if (button) {
                button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
                button.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
                button.setAttribute('title', theme === 'dark' ? 'Светлая тема' : 'Тёмная тема');
            }
            if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
            var meta = document.querySelector('meta[name="theme-color"]');
            if (meta) meta.setAttribute('content', theme === 'dark' ? '#0e1512' : '#f0f4f0');
            if (persist) {
                try { window.localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
            }
        }

        applyTheme(currentTheme(), false);

        if (button) {
            button.addEventListener('click', function () {
                applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
            });
        }

        // если пользователь ещё не выбирал тему вручную — следуем системной
        var onSystemThemeChange = function (event) {
            var saved = null;
            try { saved = window.localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
            if (saved !== 'dark' && saved !== 'light') {
                applyTheme(event.matches ? 'dark' : 'light', false);
            }
        };

        if (media) {
            if (media.addEventListener) media.addEventListener('change', onSystemThemeChange);
            else if (media.addListener) media.addListener(onSystemThemeChange);
        }
    }

    /* ---------------- имя ученика ---------------- */
    function renderGreeting() {
        var el = document.getElementById('studentGreeting');
        if (!el) return;
        var name = (state.name || '').trim();
        el.textContent = name ? 'Привет, ' + name + '! 👋' : '';
    }

    function bindName() {
        var input = document.getElementById('studentName');
        if (!input) return;
        input.value = state.name || '';
        input.addEventListener('input', function () {
            state.name = input.value.slice(0, 40);
            renderGreeting();
            saveState();
        });
        input.addEventListener('blur', function () { saveState(true); });
        renderGreeting();
    }

    /* ---------------- события ответов ---------------- */
    function onAnswerChanged(testId) {
        state.tests[testId].answers = collectAnswers(testId);
        startTimer(testId);
        renderProgress(testId);
        saveState();
    }

    function bindTest(testId) {
        var section = document.getElementById(testId);
        if (!section) return;
        var test = state.tests[testId];

        section.addEventListener('change', function (event) {
            var target = event.target;
            if (!target || target.type !== 'checkbox' || test.checked) return;
            if (!target.closest('.test-question')) return;
            onAnswerChanged(testId);
        });

        section.addEventListener('click', function (event) {
            var btn = event.target.closest ? event.target.closest('.choice-btn') : null;
            if (!btn || test.checked) return;
            var card = btn.closest('.test-question');
            if (!card) return;

            $$('.choice-btn', card).forEach(function (b) { b.classList.remove('selected'); });
            btn.classList.add('selected');

            var message = $('.result-message', card);
            if (message) {
                message.textContent = '';
                message.className = 'result-message';
            }

            onAnswerChanged(testId);
        });

        var submitBtn = $('#' + testId + ' .submit-test-btn');
        if (submitBtn) {
            submitBtn.addEventListener('click', function () {
                if (test.checked) return;
                if (answeredCount(testId) < cardsOf(testId).length) return;
                checkTest(testId);
            });
        }
    }

    /* ---------------- конфетти ---------------- */
    var confettiCanvas = null;
    var confettiCtx = null;
    var confettiParticles = [];
    var confettiRaf = null;
    var lastFrame = 0;
    var CONFETTI_COLORS = ['#2ecc40', '#8ce99a', '#ffd43b', '#ff8787', '#4dabf7', '#b197fc', '#ffa94d'];

    function setupConfetti() {
        confettiCanvas = document.getElementById('confetti-canvas');
        if (!confettiCanvas || !confettiCanvas.getContext) return;
        confettiCtx = confettiCanvas.getContext('2d');
        resizeConfetti();
        window.addEventListener('resize', resizeConfetti);
    }

    function resizeConfetti() {
        if (!confettiCanvas || !confettiCtx) return;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        confettiCanvas.width = Math.floor(window.innerWidth * dpr);
        confettiCanvas.height = Math.floor(window.innerHeight * dpr);
        confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function launchConfetti() {
        if (!confettiCanvas || !confettiCtx) return;
        if (reducedMotion && reducedMotion.matches) return;

        resizeConfetti();
        var w = window.innerWidth;
        var h = window.innerHeight;
        var now = performance.now();

        for (var i = 0; i < 120; i++) {
            var fromLeft = i % 2 === 0;
            var speed = 9 + Math.random() * 7;
            var angle = (35 + Math.random() * 45) * Math.PI / 180;
            confettiParticles.push({
                x: fromLeft ? -10 : w + 10,
                y: h - 10,
                vx: Math.cos(angle) * speed * (fromLeft ? 1 : -1),
                vy: -Math.sin(angle) * speed,
                size: 4 + Math.random() * 6,
                color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
                rot: Math.random() * Math.PI * 2,
                vr: (Math.random() - 0.5) * 0.3,
                shape: Math.random() < 0.25 ? 'circle' : 'rect',
                life: 0
            });
        }

        confettiCanvas.classList.add('active');
        if (!confettiRaf) {
            lastFrame = now;
            confettiRaf = window.requestAnimationFrame(confettiFrame);
        }
    }

    function confettiFrame(ts) {
        confettiRaf = null;
        if (!confettiCtx) return;

        var dt = Math.min(2.5, Math.max(0.4, (ts - lastFrame) / 16.667));
        lastFrame = ts;
        var w = window.innerWidth;
        var h = window.innerHeight;
        confettiCtx.clearRect(0, 0, w, h);

        for (var i = confettiParticles.length - 1; i >= 0; i--) {
            var p = confettiParticles[i];
            p.vy += 0.28 * dt;
            p.vx *= Math.pow(0.995, dt);
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.rot += p.vr * dt;
            p.life += dt;

            if (p.y > h + 40 || p.x < -80 || p.x > w + 80 || p.life > 420) {
                confettiParticles.splice(i, 1);
                continue;
            }

            confettiCtx.save();
            confettiCtx.translate(p.x, p.y);
            confettiCtx.rotate(p.rot);
            confettiCtx.fillStyle = p.color;
            confettiCtx.globalAlpha = p.life > 330 ? Math.max(0, 1 - (p.life - 330) / 90) : 1;
            if (p.shape === 'circle') {
                confettiCtx.beginPath();
                confettiCtx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
                confettiCtx.fill();
            } else {
                confettiCtx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            }
            confettiCtx.restore();
        }

        if (confettiParticles.length) {
            confettiRaf = window.requestAnimationFrame(confettiFrame);
        } else {
            confettiCtx.clearRect(0, 0, w, h);
            confettiCanvas.classList.remove('active');
        }
    }

    /* ---------------- появление карточек ---------------- */
    function initReveal() {
        if (!('IntersectionObserver' in window)) return;
        if (reducedMotion && reducedMotion.matches) return;

        var cards = $$('.test-question');
        cards.forEach(function (card) { card.classList.add('reveal-on'); });

        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                var card = entry.target;
                observer.unobserve(card);
                var delay = Math.min(cards.indexOf(card), 5) * 60;
                setTimeout(function () { card.classList.add('revealed'); }, delay);
            });
        }, { threshold: 0.06, rootMargin: '0px 0px -30px 0px' });

        cards.forEach(function (card) { observer.observe(card); });
    }

    /* ---------------- автозапуск таймеров при прокрутке ---------------- */
    function initTimers() {
        if (!('IntersectionObserver' in window)) {
            TEST_IDS.forEach(startTimer);
            return;
        }
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) startTimer(entry.target.id);
            });
        }, { threshold: 0.15 });

        TEST_IDS.forEach(function (id) {
            var section = document.getElementById(id);
            if (section) observer.observe(section);
        });
    }

    /* ---------------- запуск ---------------- */
    function init() {
        initTheme();
        loadState();
        bindName();
        setupConfetti();

        TEST_IDS.forEach(function (id) {
            restoreAnswers(id);
            renderTimer(id);
            bindTest(id);
            renderProgress(id);
        });

        initReveal();
        initTimers();
        setupDock();

        var resetBtn = document.getElementById('resetProgress');
        if (resetBtn) resetBtn.addEventListener('click', resetAll);

        // восстанавливаем проверенные тесты без анимаций и без конфетти
        TEST_IDS.forEach(function (id) {
            if (state.tests[id].checked) checkTest(id, { restored: true });
        });

        renderDock();

        window.addEventListener('beforeunload', function () { saveState(true); });
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) saveState(true);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();