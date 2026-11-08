// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
const STORAGE_KEY = 'ecaptureq-layout-v1';
const MIN_LIST = 240, MIN_DETAIL = 340;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Reconstruct the previous default at this window size. Never derive a new
// default from the currently rendered width, which may already be reduced.
export function layoutWidths(width, sidebar, preferredList, sidebarVisible = true) {
  const separators = sidebarVisible ? 8 : 4;
  const left = sidebarVisible ? clamp(sidebar, 176, 300) : 0;
  const content = Math.max(0, width - left - separators);
  const previousDetail = Math.max(MIN_DETAIL, Math.min(720, width - left - 310));
  const previousList = Math.max(270, content - previousDetail);
  const maxList = Math.max(MIN_LIST, content - MIN_DETAIL);
  const list = clamp(preferredList ?? previousList * 0.6, MIN_LIST, maxList);
  return {sidebar:left, list, detail:Math.max(MIN_DETAIL, content - list), maxList};
}

export function readLayoutPreferences(storage) {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY));
    const valid = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
    return {
      ...(valid(saved?.sidebar, 176, 300) ? {sidebar:saved.sidebar} : {}),
      ...(valid(saved?.list, MIN_LIST, 100000) ? {list:saved.list} : {})
    };
  } catch { return {}; }
}

export function initLayout() {
  const root = document.documentElement;
  const workspace = document.querySelector('#workspace');
  const sidebar = document.querySelector('#sidebar');
  const list = document.querySelector('.requests-pane');
  const sidebarSeparator = document.querySelector('#sidebar-splitter');
  const detailSeparator = document.querySelector('#detail-splitter');
  let storage;
  try { storage = window.localStorage; } catch { /* Storage is optional. */ }
  const preferences = readLayoutPreferences(storage);
  let current;
  const save = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Storage is optional. */ }
  };
  const apply = () => {
    const sidebarVisible = window.matchMedia('(min-width: 961px)').matches;
    const defaultSidebar = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-default-width')) || 218;
    current = layoutWidths(workspace.clientWidth, preferences.sidebar ?? defaultSidebar, preferences.list, sidebarVisible);
    root.style.setProperty('--sidebar-width', `${preferences.sidebar ?? defaultSidebar}px`);
    root.style.setProperty('--list-width', `${current.list}px`);
    sidebarSeparator.setAttribute('aria-valuemin', '176');
    sidebarSeparator.setAttribute('aria-valuemax', '300');
    sidebarSeparator.setAttribute('aria-valuenow', String(preferences.sidebar ?? defaultSidebar));
    detailSeparator.setAttribute('aria-valuemin', String(MIN_DETAIL));
    detailSeparator.setAttribute('aria-valuemax', String(current.detail + current.list - MIN_LIST));
    detailSeparator.setAttribute('aria-valuenow', String(Math.round(current.detail)));
  };
  const change = (kind, value) => {
    if (kind === 'sidebar') preferences.sidebar = clamp(value, 176, 300);
    else preferences.list = clamp(value, MIN_LIST, current.maxList);
    apply();
  };
  const bind = (separator, kind, pane) => {
    separator.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      separator.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = pane.getBoundingClientRect().width;
      separator.classList.add('dragging');
      document.body.classList.add('resizing');
      let moved = false;
      const move = next => {
        if (next.pointerId !== event.pointerId) return;
        moved = moved || next.clientX !== startX;
        if (moved) change(kind, startWidth + next.clientX - startX);
      };
      const finish = next => {
        if (next.pointerId !== event.pointerId) return;
        separator.classList.remove('dragging');
        document.body.classList.remove('resizing');
        separator.removeEventListener('pointermove', move);
        separator.removeEventListener('pointerup', finish);
        separator.removeEventListener('pointercancel', finish);
        separator.removeEventListener('lostpointercapture', finish);
        if (moved) save();
      };
      separator.addEventListener('pointermove', move);
      separator.addEventListener('pointerup', finish);
      separator.addEventListener('pointercancel', finish);
      separator.addEventListener('lostpointercapture', finish);
    });
    separator.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const min = kind === 'sidebar' ? 176 : MIN_LIST;
      const max = kind === 'sidebar' ? 300 : current.maxList;
      // This separator announces the detail pane width; Home/End therefore
      // use the opposite list limits while the arrows follow pointer motion.
      const value = event.key === 'Home' ? (kind === 'sidebar' ? min : max) :
        event.key === 'End' ? (kind === 'sidebar' ? max : min) :
        pane.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 12 : -12);
      change(kind, value);
      save();
    });
  };
  bind(sidebarSeparator, 'sidebar', sidebar);
  bind(detailSeparator, 'list', list);
  new ResizeObserver(apply).observe(workspace);
  // Breakpoint changes may leave the workspace's width unchanged (for example
  // browser zoom rounding), so also recalculate the default sidebar on resize.
  window.addEventListener('resize', apply);
  apply();
}
