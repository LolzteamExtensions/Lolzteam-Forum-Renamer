// ==UserScript==
// @name         Lolzteam Forum Renamer
// @namespace    https://lolz.team/
// @version      1.2.4
// @description  Locally renames Lolzteam forums and subforums
// @match        https://lolz.team/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'lolz-forum-renamer';
    const STORAGE_VERSION = 1;
    const ID_ATTRIBUTE = 'data-lolz-forum-id';
    const ORIGINAL_ATTRIBUTE = 'data-lolz-forum-original';
    const PREFIX_ATTRIBUTE = 'data-lolz-forum-prefix';
    const SUFFIX_ATTRIBUTE = 'data-lolz-forum-suffix';
    const EDITING_ATTRIBUTE = 'data-lolz-forum-editing';
    const INPUT_CLASS = 'lolz-forum-renamer-input';
    const DOUBLE_CLICK_DELAY = 450;
    const BLOCKED_TARGET_SELECTOR = [
        '.message',
        '.messageText',
        '.ugc',
        '.bbCodeQuote',
        '.quote',
        '.PageNav',
        '.fr-element',
        '[contenteditable="true"]',
        'textarea',
        'script',
        'style'
    ].join(', ');

    let savedNames = loadNames();
    let observer;
    let activeEditor = null;
    let pendingClick = null;
    let scanScheduled = false;
    let pendingRoots = new Set();
    let titleState = null;
    const routeIds = new Map();

    function loadNames() {
        try {
            if (typeof GM_getValue !== 'function') {
                return {};
            }

            const stored = GM_getValue(STORAGE_KEY, null);
            if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
                return {};
            }
            if (stored.version !== STORAGE_VERSION || !stored.names ||
                typeof stored.names !== 'object' || Array.isArray(stored.names)) {
                return {};
            }

            const validNames = {};
            for (const [id, value] of Object.entries(stored.names)) {
                if (/^\d+$/.test(id) && typeof value === 'string' && value.trim()) {
                    validNames[id] = value.trim();
                }
            }
            return validNames;
        } catch (_error) {
            return {};
        }
    }

    function saveNames() {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(STORAGE_KEY, {
                    version: STORAGE_VERSION,
                    names: { ...savedNames }
                });
            }
        } catch (_error) {
            // A storage failure must not break forum navigation
        }
    }

    function collect(root, selector) {
        const elements = [];
        if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) {
            elements.push(root);
        }
        if (typeof root.querySelectorAll === 'function') {
            elements.push(...root.querySelectorAll(selector));
        }
        return elements;
    }

    function forumIdFromClasses(element) {
        for (const className of element.classList) {
            const match = className.match(/^node_?(\d+)$/);
            if (match && match[1] !== '0') {
                return match[1];
            }
        }
        return null;
    }

    function iconIdFromClasses(element) {
        for (const className of element.classList) {
            const match = className.match(/^nodeIcon(\d+)$/);
            if (match && match[1] !== '0') {
                return match[1];
            }
        }
        return null;
    }

    function threadIconIdFromClasses(element) {
        for (const className of element.classList) {
            const match = className.match(/^nodeIconThread(\d+)$/);
            if (match && match[1] !== '0') {
                return match[1];
            }
        }
        return null;
    }

    function normalizeRoute(href) {
        try {
            const url = new URL(href, location.href);
            if (url.origin !== location.origin) {
                return null;
            }
            return url.pathname.replace(/\/+$/, '') || '/';
        } catch (_error) {
            return null;
        }
    }

    function rememberRoute(anchor, id) {
        const route = normalizeRoute(anchor.getAttribute('href'));
        if (route) {
            routeIds.set(route, id);
        }
    }

    function directIdFromRoute(anchor) {
        const route = normalizeRoute(anchor.getAttribute('href'));
        if (!route) {
            return null;
        }
        const match = route.match(/^\/(?:forums|link-forums)\/(\d+)$/);
        return match ? match[1] : routeIds.get(route) || null;
    }

    function ownForumAnchor(container) {
        for (const anchor of container.querySelectorAll('.nodeTitle a')) {
            if (anchor.closest('.node') === container) {
                return anchor;
            }
        }
        return null;
    }

    function isBlockedTarget(element) {
        return !element.closest('.alert_violation_kf') &&
            Boolean(element.closest(BLOCKED_TARGET_SELECTOR));
    }

    function forumLinkLabel(anchor) {
        for (const selector of ['[itemprop="name"]', '.forumTitle', '.nodeTitle']) {
            const label = anchor.querySelector(selector);
            if (label) {
                return label;
            }
        }

        if (anchor.childElementCount === 0) {
            return anchor;
        }

        const textChildren = [...anchor.children].filter(function (child) {
            return child.textContent.trim() && !child.matches('svg, img, i, .SvgIcon, .NodeSvgIcon');
        });
        return textChildren.length === 1 ? textChildren[0] : null;
    }

    function forumControlLabel(control) {
        if (control.matches('a[href]')) {
            return forumLinkLabel(control);
        }

        const label = control.querySelector(
            '.forumInfo > .title, .nodeTitle > a[href] .forumTitle, .nodeTitle > a[href], ' +
            ':scope > .forumTitle, :scope > .title'
        );
        if (label) {
            return label.matches('a[href]') ? forumLinkLabel(label) : label;
        }

        const title = control.matches('.nodeTitle')
            ? control
            : control.querySelector(':scope > .nodeTitle');
        return title && title.childElementCount === 0 ? title : null;
    }

    function discoverForumLinkTargets(root) {
        for (const anchor of collect(root, 'a[href]')) {
            if (isBlockedTarget(anchor)) {
                continue;
            }

            const id = directIdFromRoute(anchor);
            const label = id ? forumLinkLabel(anchor) : null;
            if (!id || !label) {
                continue;
            }

            rememberRoute(anchor, id);
            markTarget(label, id);
        }
    }

    function discoverClassTargets(root) {
        for (const marker of collect(root, '[class*="node"]')) {
            const iconId = iconIdFromClasses(marker) || threadIconIdFromClasses(marker);
            const id = iconId || forumIdFromClasses(marker);
            if (!id || isBlockedTarget(marker)) {
                continue;
            }

            let control = marker.closest('a[href], [role="button"], .nodeTitle');
            if (!control && !iconId && !marker.matches('html, body, .node')) {
                control = marker;
            }
            if (!control) {
                continue;
            }

            const label = forumControlLabel(control);
            if (control.matches('a[href]')) {
                rememberRoute(control, id);
            }

            if (label) {
                markTarget(label, id);
            }
        }
    }

    function discoverNodeTargets(root) {
        for (const container of collect(root, '.node')) {
            if (!container.classList.contains('forum') && !container.classList.contains('link')) {
                continue;
            }

            const id = forumIdFromClasses(container);
            if (!id) {
                continue;
            }

            const anchor = ownForumAnchor(container);
            if (!anchor) {
                continue;
            }

            rememberRoute(anchor, id);
            const label = anchor.querySelector('.forumTitle') || anchor;
            markTarget(label, id);
        }

    }

    function forumIdFromContext(element) {
        const form = element.closest('form');
        const input = form ? form.querySelector('[name="node_id"]') : null;
        if (input && /^\d+$/.test(input.value) && input.value !== '0') {
            return input.value;
        }
        return currentForumId();
    }

    function discoverCreateThreadHeaderTargets(root) {
        for (const header of collect(root, '.createThread-header')) {
            const match = header.textContent.trim().match(/^(.*?:\s*)(.+)$/);
            const id = forumIdFromContext(header);
            if (!match || !id) {
                continue;
            }
            markTarget(header, id, '', match[1]);
        }
    }

    function discoverNotificationRulesTargets(root) {
        for (const block of collect(root, '.notification_rules_block')) {
            const id = forumIdFromContext(block);
            const label = block.querySelector('.subtitle b');
            if (!id || !label) {
                continue;
            }
            markTarget(label, id);
        }
    }

    function optionSuffix(text) {
        const suffix = ' + подразделы';
        return text.endsWith(suffix) ? suffix : '';
    }

    function optionPrefix(text) {
        const match = text.match(/^\s*/);
        return match ? match[0] : '';
    }

    function discoverNodeSelectTargets(root) {
        const selects = collect(root, 'select[name="node_id"]');
        if (root.nodeType === Node.ELEMENT_NODE && typeof root.closest === 'function') {
            const chosen = root.closest('.chosen-container');
            const select = chosen ? chosen.previousElementSibling : null;
            if (select && select.matches('select[name="node_id"]') && !selects.includes(select)) {
                selects.push(select);
            }
        }

        for (const select of selects) {
            let optionsChanged = false;
            for (const option of select.options) {
                if (!/^\d+$/.test(option.value)) {
                    continue;
                }
                const prefix = optionPrefix(option.textContent);
                if (option.disabled && !prefix) {
                    continue;
                }
                optionsChanged = markTarget(option, option.value, '', prefix) || optionsChanged;
            }

            if (optionsChanged) {
                refreshChosen(select);
            }

            const chosen = select.nextElementSibling;
            if (!chosen || !chosen.classList.contains('chosen-container')) {
                continue;
            }

            for (const choice of chosen.querySelectorAll('[data-option-array-index]')) {
                const index = Number.parseInt(choice.getAttribute('data-option-array-index'), 10);
                const option = select.options[index];
                if (!option || !option.hasAttribute(ID_ATTRIBUTE)) {
                    continue;
                }
                const label = choice.querySelector('.innerText') || choice.querySelector('span') || choice;
                markTarget(
                    label,
                    option.getAttribute(ID_ATTRIBUTE),
                    '',
                    optionPrefix(label.textContent)
                );
            }

            const selected = select.options[select.selectedIndex];
            const selectedLabel = chosen.querySelector('.chosen-single > span');
            if (selected && selectedLabel && selected.hasAttribute(ID_ATTRIBUTE)) {
                markTarget(
                    selectedLabel,
                    selected.getAttribute(ID_ATTRIBUTE),
                    '',
                    optionPrefix(selectedLabel.textContent)
                );
            }
        }
    }

    function discoverFeedOptionTargets(root) {
        const forms = collect(root, '#ExcludeForumsForm');
        if (root.nodeType === Node.ELEMENT_NODE && typeof root.closest === 'function') {
            const parentForm = root.closest('#ExcludeForumsForm');
            if (parentForm && !forms.includes(parentForm)) {
                forms.push(parentForm);
            }
        }

        for (const form of forms) {
            const select = form.querySelector('select.SelectForums[name="node_ids[]"]');
            if (!select) {
                continue;
            }

            let optionsChanged = false;
            for (const option of select.options) {
                if (!/^\d+$/.test(option.value) || option.classList.contains('d0') ||
                    option.classList.contains('_depth0')) {
                    continue;
                }
                optionsChanged = markTarget(
                    option,
                    option.value,
                    optionSuffix(option.textContent.trim())
                ) || optionsChanged;
            }

            if (optionsChanged) {
                refreshChosen(select);
            }

            const chosen = select.nextElementSibling;
            if (!chosen || !chosen.classList.contains('chosen-container')) {
                continue;
            }

            for (const choice of chosen.querySelectorAll('[data-option-array-index]')) {
                const index = Number.parseInt(choice.getAttribute('data-option-array-index'), 10);
                const option = select.options[index];
                if (!option || !option.hasAttribute(ID_ATTRIBUTE)) {
                    continue;
                }
                const label = choice.querySelector('.innerText') || choice.querySelector('span') || choice;
                markTarget(
                    label,
                    option.getAttribute(ID_ATTRIBUTE),
                    option.getAttribute(SUFFIX_ATTRIBUTE) || ''
                );
            }
        }
    }

    function refreshChosen(select) {
        if (typeof window.jQuery === 'function') {
            window.jQuery(select).trigger('chosen:updated');
            return;
        }
        select.dispatchEvent(new CustomEvent('chosen:updated'));
    }

    function currentForumId() {
        const input = document.querySelector('form.DiscussionListOptions input[name="node_id"]');
        if (input && /^\d+$/.test(input.value) && input.value !== '0') {
            return input.value;
        }

        const canonical = document.querySelector('link[rel="canonical"]');
        if (canonical) {
            const route = normalizeRoute(canonical.getAttribute('href'));
            if (route) {
                const match = route.match(/^\/forums\/(\d+)$/);
                if (match) {
                    return match[1];
                }
                if (routeIds.has(route)) {
                    return routeIds.get(route);
                }
            }
        }

        if (document.body) {
            for (const className of document.body.classList) {
                const match = className.match(/^node(\d+)$/);
                if (match && match[1] !== '0') {
                    return match[1];
                }
            }
        }
        return null;
    }

    function discoverCurrentForumTitle() {
        const heading = document.querySelector('main#content.forum_view .titleBar > h1');
        if (!heading) {
            return;
        }

        const id = currentForumId();
        if (!id) {
            return;
        }

        markTarget(heading, id);
        syncDocumentTitle(id, heading);
    }

    function markTarget(target, id, suffix, prefix) {
        if (!target || target.hasAttribute(EDITING_ATTRIBUTE)) {
            return false;
        }

        if (typeof prefix === 'string') {
            if (prefix) {
                target.setAttribute(PREFIX_ATTRIBUTE, prefix);
            } else {
                target.removeAttribute(PREFIX_ATTRIBUTE);
            }
        }
        if (typeof suffix === 'string') {
            if (suffix) {
                target.setAttribute(SUFFIX_ATTRIBUTE, suffix);
            } else {
                target.removeAttribute(SUFFIX_ATTRIBUTE);
            }
        }

        const previousId = target.getAttribute(ID_ATTRIBUTE);
        const currentPrefix = target.getAttribute(PREFIX_ATTRIBUTE) || '';
        const currentSuffix = target.getAttribute(SUFFIX_ATTRIBUTE) || '';
        const currentText = currentPrefix ? target.textContent : target.textContent.trim();
        let currentName = currentPrefix && currentText.startsWith(currentPrefix)
            ? currentText.slice(currentPrefix.length)
            : currentText;
        if (currentSuffix && currentName.endsWith(currentSuffix)) {
            currentName = currentName.slice(0, -currentSuffix.length);
        }
        if (previousId !== id || !target.hasAttribute(ORIGINAL_ATTRIBUTE)) {
            target.setAttribute(ID_ATTRIBUTE, id);
            target.setAttribute(ORIGINAL_ATTRIBUTE, currentName);
        } else {
            const original = target.getAttribute(ORIGINAL_ATTRIBUTE);
            const expected = currentPrefix + (savedNames[id] || original) + currentSuffix;
            if (currentText && currentText !== expected) {
                target.setAttribute(ORIGINAL_ATTRIBUTE, currentName);
            }
        }

        const original = target.getAttribute(ORIGINAL_ATTRIBUTE);
        const desired = currentPrefix + (savedNames[id] || original) + currentSuffix;
        if (target.textContent !== desired) {
            target.textContent = desired;
            return true;
        }
        return false;
    }

    function replaceForumName(title, originalName, customName) {
        const index = title.indexOf(originalName);
        if (index === -1) {
            return title;
        }
        return title.slice(0, index) + customName + title.slice(index + originalName.length);
    }

    function syncDocumentTitle(id, heading) {
        const originalName = heading.getAttribute(ORIGINAL_ATTRIBUTE) || heading.textContent.trim();
        if (!titleState || titleState.id !== id) {
            titleState = {
                id,
                originalTitle: document.title,
                appliedTitle: document.title
            };
        } else if (document.title !== titleState.appliedTitle) {
            titleState.originalTitle = document.title;
        }

        const customName = savedNames[id];
        const desired = customName
            ? replaceForumName(titleState.originalTitle, originalName, customName)
            : titleState.originalTitle;

        titleState.appliedTitle = desired;
        if (document.title !== desired) {
            document.title = desired;
        }
    }

    function applyForumName(id) {
        const changedSelects = new Set();
        for (const target of document.querySelectorAll(`[${ID_ATTRIBUTE}="${id}"]`)) {
            if (target.hasAttribute(EDITING_ATTRIBUTE)) {
                continue;
            }
            const original = target.getAttribute(ORIGINAL_ATTRIBUTE) || '';
            const prefix = target.getAttribute(PREFIX_ATTRIBUTE) || '';
            const suffix = target.getAttribute(SUFFIX_ATTRIBUTE) || '';
            const desired = prefix + (savedNames[id] || original) + suffix;
            if (target.textContent !== desired) {
                target.textContent = desired;
                if (target.tagName === 'OPTION' && target.parentElement.tagName === 'SELECT') {
                    changedSelects.add(target.parentElement);
                }
            }
        }
        for (const select of changedSelects) {
            refreshChosen(select);
        }
        discoverCurrentForumTitle();
    }

    function scan(root) {
        if (!root || (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE)) {
            return;
        }
        for (const target of collect(root, `[${ID_ATTRIBUTE}]`)) {
            markTarget(target, target.getAttribute(ID_ATTRIBUTE));
        }
        discoverNodeTargets(root);
        discoverClassTargets(root);
        discoverForumLinkTargets(root);
        discoverCreateThreadHeaderTargets(root);
        discoverNotificationRulesTargets(root);
        discoverFeedOptionTargets(root);
        discoverNodeSelectTargets(root);
        discoverCurrentForumTitle();
    }

    function scheduleScan(root) {
        if (!root) {
            return;
        }
        if (root.nodeType === Node.TEXT_NODE) {
            root = root.parentElement;
        }
        if (!root) {
            return;
        }

        if (root.nodeType === Node.ELEMENT_NODE && typeof root.closest === 'function') {
            root = root.closest(`[${ID_ATTRIBUTE}], a[href], [class*="node"], .chosen-container, select[name="node_id"], .createThread-header, .notification_rules_block, #ExcludeForumsForm, main#content.forum_view .titleBar`) || root;
        }

        pendingRoots.add(root);
        if (scanScheduled) {
            return;
        }
        scanScheduled = true;
        requestAnimationFrame(function () {
            scanScheduled = false;
            const roots = [...pendingRoots];
            pendingRoots = new Set();
            for (const candidate of roots) {
                if (!candidate.isConnected && candidate !== document) {
                    continue;
                }
                const hasPendingAncestor = roots.some(function (other) {
                    return other !== candidate && typeof other.contains === 'function' && other.contains(candidate);
                });
                if (!hasPendingAncestor) {
                    scan(candidate);
                }
            }
        });
    }

    function cancelPendingClick() {
        if (!pendingClick) {
            return;
        }
        clearTimeout(pendingClick.timer);
        pendingClick = null;
    }

    function replayPendingClick() {
        if (!pendingClick) {
            return;
        }
        const control = pendingClick.control;
        pendingClick = null;
        if (control.isConnected) {
            control.click();
        }
    }

    function beginEditing(target) {
        cancelPendingClick();
        if (activeEditor) {
            finishEditing(activeEditor, false);
        }

        const id = target.getAttribute(ID_ATTRIBUTE);
        if (!id) {
            return;
        }

        target.setAttribute(EDITING_ATTRIBUTE, 'true');
        target.textContent = '';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = INPUT_CLASS;
        input.value = savedNames[id] || target.getAttribute(ORIGINAL_ATTRIBUTE) || '';
        input.setAttribute('aria-label', 'Новое название раздела');
        target.append(input);

        activeEditor = { target, input, id, finished: false };

        input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                finishEditing(activeEditor, true);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finishEditing(activeEditor, false);
            }
        });
        input.addEventListener('blur', function () {
            if (activeEditor && activeEditor.input === input) {
                finishEditing(activeEditor, false);
            }
        });
        for (const eventName of ['click', 'dblclick']) {
            input.addEventListener(eventName, function (event) {
                event.stopPropagation();
            });
        }

        input.focus();
        input.select();
    }

    function finishEditing(editor, shouldSave) {
        if (!editor || editor.finished) {
            return;
        }
        editor.finished = true;

        if (shouldSave) {
            const value = editor.input.value.trim();
            if (value) {
                savedNames[editor.id] = value;
            } else {
                delete savedNames[editor.id];
            }
            saveNames();
        }

        editor.target.removeAttribute(EDITING_ATTRIBUTE);
        if (activeEditor === editor) {
            activeEditor = null;
        }
        applyForumName(editor.id);
    }

    function recognizedTarget(eventTarget) {
        return eventTarget && typeof eventTarget.closest === 'function'
            ? eventTarget.closest(`[${ID_ATTRIBUTE}]`)
            : null;
    }

    function installInteractionHandlers() {
        document.addEventListener('click', function (event) {
            const target = recognizedTarget(event.target);
            if (!target) {
                return;
            }

            if (event.target.classList && event.target.classList.contains(INPUT_CLASS)) {
                return;
            }

            const control = target.closest('a, [role="button"]');
            if (target.hasAttribute(EDITING_ATTRIBUTE)) {
                if (control) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
                return;
            }

            if (!control || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
            }

            if (event.detail > 1) {
                cancelPendingClick();
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }

            if (!event.isTrusted) {
                return;
            }

            if (pendingClick) {
                replayPendingClick();
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            pendingClick = {
                control,
                timer: setTimeout(replayPendingClick, DOUBLE_CLICK_DELAY)
            };
        }, true);

        document.addEventListener('dblclick', function (event) {
            const target = recognizedTarget(event.target);
            if (!target || target.hasAttribute(EDITING_ATTRIBUTE)) {
                return;
            }
            cancelPendingClick();
            event.preventDefault();
            event.stopImmediatePropagation();
            beginEditing(target);
        }, true);
    }

    function installStyle() {
        const style = document.createElement('style');
        style.textContent = `
            .${INPUT_CLASS} {
                box-sizing: border-box;
                width: min(100%, 24rem);
                min-width: 8rem;
                margin: 0;
                padding: 0.2rem 0.4rem;
                color: inherit;
                font: inherit;
                line-height: inherit;
                background: var(--primaryDarker, #181e1c);
                border: 1px solid var(--primaryMedium, #00ba78);
                border-radius: 4px;
                outline: none;
            }
        `;
        (document.head || document.documentElement).append(style);
    }

    function start() {
        installStyle();
        installInteractionHandlers();
        scan(document);

        observer = new MutationObserver(function (mutations) {
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    if (mutation.addedNodes.length === 0) {
                        scheduleScan(mutation.target);
                    } else {
                        for (const node of mutation.addedNodes) {
                            scheduleScan(node);
                        }
                    }
                } else {
                    scheduleScan(mutation.target);
                }
            }
        });
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'href']
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
}());
