/**
 * ST-Persistent-Memory - 屏幕快捷悬浮按钮与拖拽持久化 (Floating Bubble & Draggable Service)
 * 职责：
 * 1. 注入屏幕快捷入口（悬浮气泡，支持任意拖拽与坐标记忆）
 * 2. 手机触控与桌面鼠标双端适配、防遮挡安全边缘算法
 * 3. 手机端与桌面端屏幕坐标隔离持久化存储 (localStorage)
 * 4. 坐标重置自愈服务 (resetBubblePosition)
 *
 * @version 0.1.43
 */

import { getSettings } from '../state.js';

/**
 * 注入屏幕快捷入口（悬浮气泡，支持任意拖拽与坐标记忆）
 */
export function createFloatingButton(onToggle) {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pm-floating-bubble')) return;

    const btn = document.createElement('div');
    btn.id = 'pm-floating-bubble';
    btn.className = 'pm-floating-bubble';
    btn.title = '持续记忆系统 (可拖拽，点击打开 HUD 面板)';
    btn.innerHTML = '<i class="fa-solid fa-brain"></i>';

    if (getSettings().showFloatingBubble === false) {
        btn.style.display = 'none';
    }

    // 绑定拖拽逻辑
    makeDraggable(btn, () => {
        if (typeof onToggle === 'function') {
            onToggle();
        }
    });

    document.body.appendChild(btn);
}

/**
 * 重置悬浮球位置到系统默认推荐坐标 (适配 PC 与 手机)
 */
export function resetBubblePosition() {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem('pm_bubble_pos');
            localStorage.removeItem('pm_bubble_pos_mobile');
        }
    } catch {}
    if (typeof document !== 'undefined') {
        const bubble = document.getElementById('pm-floating-bubble');
        if (bubble) {
            bubble.style.left = '';
            bubble.style.top = '';
            bubble.style.right = '';
            bubble.style.bottom = '';
        }
    }
}

/**
 * 拖拽核心算法：手机触控与桌面鼠标双端适配、防遮挡安全边缘、坐标隔离持久化
 */
export function makeDraggable(el, onClickCallback) {
    if (!el || typeof window === 'undefined') return;

    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0;
    let initialX = 0, initialY = 0;

    const isMobile = () => window.innerWidth <= 768;
    const getStorageKey = () => isMobile() ? 'pm_bubble_pos_mobile' : 'pm_bubble_pos';

    // 恢复历史记忆位置 (手机端与桌面端分别记忆，避免桌面大屏坐标导致手机端飞出屏幕)
    try {
        const key = getStorageKey();
        const saved = localStorage.getItem(key);
        if (saved) {
            const { x, y } = JSON.parse(saved);
            const maxX = Math.max(10, window.innerWidth - 50);
            const maxY = Math.max(10, window.innerHeight - 50);
            const clampedX = Math.min(Math.max(10, x), maxX);
            const clampedY = Math.min(Math.max(10, y), maxY);
            el.style.left = `${clampedX}px`;
            el.style.top = `${clampedY}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        } else {
            // 未保存过自定义位置时，清空 inline 样式，严格使用 CSS 优雅响应式默认定位
            el.style.left = '';
            el.style.top = '';
            el.style.right = '';
            el.style.bottom = '';
        }
    } catch {}

    const onStart = (e) => {
        isDragging = true;
        hasMoved = false;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;

        const rect = el.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;

        el.style.transition = 'none';
        el.classList.add('pm-dragging');

        window.addEventListener('mousemove', onMove, { passive: false });
        window.addEventListener('mouseup', onEnd);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onEnd);
    };

    const onMove = (e) => {
        if (!isDragging) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = clientX - startX;
        const dy = clientY - startY;

        if (Math.hypot(dx, dy) > 5) {
            hasMoved = true;
            if (e.cancelable) e.preventDefault();
        }

        if (!hasMoved) return;

        let newX = initialX + dx;
        let newY = initialY + dy;

        const maxX = window.innerWidth - el.offsetWidth;
        const maxY = window.innerHeight - el.offsetHeight;
        newX = Math.min(Math.max(0, newX), maxX);
        newY = Math.min(Math.max(0, newY), maxY);

        el.style.left = `${newX}px`;
        el.style.top = `${newY}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    };

    const onEnd = () => {
        if (!isDragging) return;
        isDragging = false;
        el.style.transition = '';
        el.classList.remove('pm-dragging');

        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);

        if (hasMoved) {
            const rect = el.getBoundingClientRect();
            try {
                localStorage.setItem(getStorageKey(), JSON.stringify({ x: rect.left, y: rect.top }));
            } catch {}
        }
    };

    el.addEventListener('mousedown', onStart);
    el.addEventListener('touchstart', onStart, { passive: true });

    el.addEventListener('click', (e) => {
        if (hasMoved) {
            e.stopImmediatePropagation();
            e.preventDefault();
            hasMoved = false;
            return;
        }
        onClickCallback?.();
    });
}
